# Decisiones y diferencias con el prompt original

Fuentes: https://help.ctrader.com/open-api/ y los `.proto` oficiales
(https://github.com/spotware/openapi-proto-messages), consultados el 2026-10-22.

## Fase 1: cliente cTrader

| # | Tema | Decisión | Motivo |
|---|------|----------|--------|
| D1 | Endpoint | `wss://demo.ctraderapi.com:5036` | La doc indica 5036 solo para JSON y 5035 solo para Protobuf. Ambos puertos aceptan TCP y WebSocket. |
| D2 | Guardia demo-only | Se verifica `isLive === false` en `ProtoOAGetAccountListByAccessTokenRes.ctidTraderAccount`. Cualquier otra cosa (`true`, campo ausente, cuenta que no aparece en la lista) es fatal: el proceso termina con código 1. | **Difiere del prompt:** `ProtoOATraderRes`/`ProtoOATrader` **no tiene** `isLive`, solo lo tiene `ProtoOACtidTraderAccount`. Además, conectar solo al host demo es una segunda barrera, porque los entornos demo y live están totalmente separados. `CTRADER_ENV` solo admite `demo`. |
| D3 | Selección de cuenta | Si `CTRADER_ACCOUNT_ID` está vacío, se usa la única cuenta demo del token. Si hay 0 o más de 1, se aborta y se piden los ids. | Evita operar en una cuenta que no sea la esperada. |
| D4 | Tokens: fuente de verdad | El `.env` solo inicializa un store vacío. Después de eso manda SQLite (cifrado AES-256-GCM, clave derivada con scrypt de `CTRADER_CLIENT_SECRET` y salt aleatorio por registro). El par nuevo se persiste **antes** de usarse. | La doc dice que al renovar se invalidan los tokens anteriores. Decisión confirmada por el usuario. Consecuencia: si se borra `data/`, hay que volver a cargar un par válido en `.env`. |
| D5 | Refresh | Se dispara con `OA_AUTH_TOKEN_EXPIRED` o `CH_ACCESS_TOKEN_INVALID` (en `ProtoOAErrorRes`) y con `ProtoOAAccountsTokenInvalidatedEvent`. Se hace un solo refresh y un solo reintento; refreshes concurrentes se unifican en uno (single-flight). | Así se evitan loops de refresh. El código exacto que devuelve la demo con un token vencido se confirma en el test de integración. |
| D6 | `expiresIn` | Se acepta en segundos (lo que documenta el endpoint HTTP: 2628000) o como timestamp Unix en ms (lo que asume el ejemplo C# del SDK con Protobuf). | La doc es ambigua sobre la respuesta Protobuf/JSON. |
| D7 | Rate limits | Ventana deslizante de 1 s: **45/s** para requests no históricos y **4/s** para históricos (la doc dice 50 y 5). | Se deja margen para heartbeats y errores de reloj. |
| D8 | Qué cuenta como "histórico" | Trendbars, tick data, deal list, cash-flow history, order list, deal/order list por posición y deal offset list. | La doc no publica una lista exhaustiva; se clasificaron así los requests que la doc describe como datos históricos. |
| D9 | Heartbeat | `ProtoHeartbeatEvent` (payloadType 51) cada 10 s, sin pasar por el limiter. | La doc dice "keep sending a heartbeat every 10 seconds". |
| D10 | Reconexión | Backoff exponencial con "equal jitter" (base 1 s, tope 60 s). Al reconectar: auth de app, lista de cuentas (guardia), auth de cuenta, trader, reconcile y re-suscripción a spots. | Los requests en vuelo se rechazan con `CTraderDisconnectedError`; nunca se reenvían solos (podría duplicar órdenes). |
| D11 | Correlación | `clientMsgId` = UUID v4. Un request se resuelve con el primer mensaje de tipo esperado con el mismo id; `ProtoOAErrorRes` / `ProtoErrorRes` / `ProtoOAOrderErrorEvent` con ese id lo rechazan con `CTraderApiError`. Timeout por defecto: 10 s desde el envío (la espera en la cola del limiter no cuenta). | |
| D12 | int64 y enums en JSON | Los int64 se aceptan como número o string (deben ser safe integers). Los enums, como número o como nombre proto. | La doc no fija el formato JSON de esos tipos, así que se aceptan las dos formas sin romper. |
| D13 | Precios y volúmenes | Precios enteros (spots, trendbars, SL/TP relativos) en 1/100000 → redondeados a `digits`. Volúmenes en centésimas de unidad. Dinero escalado por `moneyDigits` de cada mensaje. El volumen **siempre se redondea hacia abajo** al `stepVolume`. | Según los `.proto`. Redondear hacia arriba aumentaría el riesgo. |
| D14 | Órdenes de mercado | No aceptan SL/TP absolutos ("Not supported for MARKET orders"): se usan `relativeStopLoss`/`relativeTakeProfit` en 1/100000. | Según `ProtoOANewOrderReq` (se implementa en la Fase 4). |
| D15 | Valor del pip | `pip = 10^-pipPosition` en moneda quote, convertido a la moneda de depósito recorriendo la cadena de `ProtoOASymbolsForConversionReq` con el **mid** de spots en vivo. | Así se cubren cruces (EURGBP) y pares con JPY. La diferencia bid/ask en la conversión es despreciable frente al riesgo por trade. |
| D16 | Transporte desacoplado | El cliente solo maneja envelopes `{payloadType, payload, clientMsgId}` a través de la interfaz `Transport`. | Pasar a Protobuf (puerto 5035) es escribir otro `Transport`, sin tocar el cliente ni las tools. |

## Pendiente de confirmar contra la demo (tests de integración)

- Máximo de `count` en `ProtoOAGetTrendbarsReq`. La doc no lo publica; si no alcanza para 500 velas, se pagina por `toTimestamp`.
- Código de error real ante un access token vencido (se espera `CH_ACCESS_TOKEN_INVALID`).
- Formato JSON real de int64 y enums (D12 cubre ambas formas).

## Entorno de desarrollo

El contenedor cloud donde se construyó la Fase 1 no puede abrir WebSockets ni conectarse a puertos que no sean 443, así que los tests de integración (`INTEGRATION=1`) se corren en la máquina local o en el VPS.

## Fase 2: motor de riesgo

| # | Tema | Decisión | Motivo |
|---|------|----------|--------|
| R1 | Dónde vive | `src/risk/engine.ts` es una función pura (`evaluateOrder` / `evaluateAmend`). `RiskService` arma el contexto desde el broker y **toda** tool de órdenes va a pasar por ahí. Si el contexto no se puede construir, la orden se rechaza (*fail closed*). | Testeable regla por regla, y el agente no puede saltearlo. |
| R2 | Equity | `balance + Σ netUnrealizedPnL` (`ProtoOAGetPositionUnrealizedPnLReq`). | Es lo que da el broker; no incluye la comisión de cierre, como dice la doc. |
| R3 | Tamaño | `units = equity × riskPct / (pips de SL × valor del pip por unidad)`, piso a `stepVolume`; si queda por debajo de `minVolume`, se rechaza. Las distancias se redondean a los `digits` del símbolo antes de dividir. | Evita que el ruido de punto flotante baje un step entero. El riesgo real nunca supera el objetivo. `riskPct` por trade puede ser menor que `RISK_PER_TRADE_PCT`, nunca mayor. |
| R4 | Precio de entrada en órdenes de mercado | BUY usa el ask y SELL el bid del spot actual. Sin quote en vivo, se rechaza. | |
| R5 | Riesgo abierto | Suma del riesgo hasta el SL de **posiciones y órdenes pendientes** (una pendiente puede llenarse). Un SL ya en ganancia cuenta 0. Una posición **sin SL** bloquea toda orden nueva hasta corregirla. Las órdenes de protección (SL/TP) no cuentan. | Criterio conservador. |
| R6 | Exposición por moneda | Una operación con riesgo R en BASE/QUOTE suma +R a BASE y −R a QUOTE si es compra (al revés si es venta). Se rechaza si la operación **aumenta** el \|neto\| de una moneda **y** el resultado supera el 1,5 % del equity. | Así se permite cerrar o compensar una exposición grande. XAU cuenta como moneda. |
| R7 | Día de trading | Medianoche de `TZ_SESSIONS` (America/New_York), con DST resuelto vía `Intl`. | El prompt dice "día de NY"; es coherente con la apertura de medianoche NY de la Fase 3. |
| R8 | Operaciones por símbolo y día | Posiciones distintas abiertas hoy (deals de apertura, de `ProtoOADealListReq`) + órdenes pendientes creadas hoy. Una pendiente cancelada no cuenta. | El broker es la fuente de verdad; no depende del journal. |
| R9 | Límite de pérdida diaria | `(PnL realizado de hoy + flotante) / balance al inicio del día`, donde el inicio del día = `balance − realizado de hoy`. Realizado = gross + swap + comisiones (de apertura y de cierre) + fee de conversión. | **Supuesto:** no hay depósitos ni retiros durante el día (si los hay, el porcentaje se distorsiona). |
| R10 | Spread medio "de la sesión" | Media móvil de las últimas 2 h, con una muestra por segundo de los spots. Es válida con ≥ 60 muestras. Sin baseline, las órdenes de mercado se rechazan y las límite se permiten. Al arrancar, el servidor se suscribe a los spots de `ALLOWED_SYMBOLS`. | Interpretación de "sesión"; evita entrar a mercado en spikes de spread. |
| R11 | Noticias | Solo para órdenes de mercado, como dice el prompt: se rechazan si `now < blockedUntil` o si hay un evento `high` (o sin impacto informado) de la moneda base o quote a ±15 min. | Las órdenes límite no se bloquean por noticias. |
| R12 | Modificar SL | El SL nuevo no puede alejarse (BUY: ≥ al actual; SELL: ≤). SL y TP siguen siendo obligatorios y no pueden quedar "del otro lado" del precio actual (BUY cierra en bid, SELL en ask). | |
| R13 | Journal | Cada rechazo se guarda en `events` (`risk_rejected`) con la intención, los motivos y el sizing; los previews aprobados se guardan como `risk_preview`. | La Fase 5 agrega `trades` y `daily_stats`. |
