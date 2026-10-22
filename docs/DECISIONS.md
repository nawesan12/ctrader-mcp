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

## Fase 3: contexto SMC

No se recibió el código Pine de "SMC Lite": `src/analysis/smc.ts` implementa la especificación del prompt. Si se comparte el `.pine`, se alinean los detalles (empates en pivotes, OB, tolerancias).

| # | Tema | Decisión |
|---|------|----------|
| S1 | Velas | Solo velas **cerradas** (se descarta la que se está formando). Las funciones son puras. Un test de propiedad verifica, para cada prefijo de una serie aleatoria con semilla, que los BOS/CHoCH y swings ya conocidos coinciden con el análisis completo (no hay repintado). |
| S2 | Pivotes | `len = 5`. High pivote: estrictamente mayor que las `len` velas de la izquierda y ≥ que las `len` de la derecha (lo mismo para lows). Se confirma en `i + len` y recién desde ahí se usa. |
| S3 | BOS / CHoCH | Se rompe con un **cierre** más allá del último swing confirmado y no roto. Si la ruptura va contra la tendencia vigente es CHoCH; si no, BOS (la primera ruptura cuenta como BOS). La tendencia del TF es la dirección de la última ruptura (`range` si todavía no hubo ninguna). |
| S4 | Order Blocks | En cada ruptura se toma la última vela de color opuesto entre las 20 velas previas, con rango completo (high–low). Se invalida con un cierre del otro lado del bloque. Queda `mitigated` si el precio volvió a entrar. Se guardan los 3 vigentes más recientes por lado. |
| S5 | FVG | Alcista si `low[i] > high[i−2]`; bajista si `high[i] < low[i−2]`. Las mechas lo van rellenando (se reporta el tramo sin rellenar) y se elimina cuando una mecha llega al borde opuesto. Se guardan 5 por lado. |
| S6 | EQH/EQL | Dos swings del mismo tipo (entre los últimos 5) con diferencia ≤ 10 % del ATR(14) Wilder. No cuenta si una mecha intermedia ya superó el primero. El nivel es el extremo de los dos. Se considera barrido cuando una mecha posterior lo supera. |
| S7 | Niveles | Se calculan a partir de velas H1 por **día calendario de NY**. Semana forex: lunes a domingo, donde el domingo (apertura de la sesión) pertenece a la semana siguiente. ADR(10) = promedio del rango de los últimos 10 días hábiles completos (sin sábados ni domingos). |
| S8 | Premium/discount | Rango entre el último swing high y el último swing low confirmados. Equilibrio ± 2 % del rango = `equilibrium`. OTE = retroceso del 62–79 % del tramo (si el low es anterior al high, se mide desde el high hacia abajo; si no, al revés). |
| S9 | Killzones | En hora de NY con DST: Asia 20:00–24:00, Londres 02:00–05:00, NY AM 07:00–10:00, NY PM 13:30–16:00 (fin exclusivo). |
| S10 | Bias | Score explicable: cada TF suma ± su peso (H4 2, H1 1,5, M15 1…), y la zona premium/discount del TF mayor suma ±1. Con \|score\| ≥ 35 % del máximo es bullish o bearish; si no, neutral. Un CHoCH en el TF menor contra la tendencia del mayor se reporta como warning. Es una **sugerencia**: el motor de riesgo no la usa. |
| S11 | Velas desde el broker | Se paginan hacia atrás pidiendo una ventana del doble de largo para cubrir fines de semana. Máximo 500 por llamada. Caché de 20 s por símbolo y TF para cuidar el límite de 5 req/s de pedidos históricos. |

## Fase 4: tools MCP

| # | Tema | Decisión | Motivo |
|---|------|----------|--------|
| T1 | Tamaño de la orden | El agente **no** puede elegir unidades: el servidor calcula el tamaño a partir de `RISK_PER_TRADE_PCT` (o un `riskPct` menor). | Así el riesgo no depende del prompt. |
| T2 | Serialización | Todas las tools que modifican estado pasan por un mutex FIFO. | Evita que dos órdenes concurrentes pasen el motor de riesgo con la misma foto de la cuenta (hay un test que lo cubre). |
| T3 | Idempotencia | `idempotencyKey` obligatorio; se persiste en SQLite con el hash del request y el resultado durante 10 minutos. La misma key con el mismo request devuelve el resultado guardado (`duplicate: true`); con otro request, error. También se envía como `clientOrderId`. | El resultado sobrevive reinicios. El `clientOrderId` permite encontrar la orden en el broker si la confirmación no llega. |
| T4 | Confirmación | Las tools devuelven el estado del `ProtoOAExecutionEvent`: límite = `ORDER_ACCEPTED`; mercado = `ORDER_FILLED` de esa orden; modificación = `ORDER_REPLACED` (y, para posiciones, el SL/TP pedidos ya reflejados); cancelación = `ORDER_CANCELLED`; cierre = `ORDER_FILLED` de la orden de cierre. Los eventos se guardan desde **antes** de enviar el request. | Así no se pierde un fill que llegue antes de que el request resuelva, ni uno que llegue sin `clientMsgId`. |
| T5 | Resultado incierto | Si no hay confirmación a tiempo (timeout, o caída del socket **después** de enviar: `CTraderDisconnectedError.sent`), se reconcilia y se devuelve `unconfirmed`, buscando la orden por `clientOrderId`. **Nunca se reintenta automáticamente.** Si el request no llegó a enviarse, se libera la key para poder reintentar. | Un reintento ciego puede duplicar una orden. |
| T6 | Órdenes de mercado | SL/TP se envían como `relativeStopLoss`/`relativeTakeProfit`, con las distancias aprobadas por el motor. | La doc lo exige ("Not supported for MARKET orders") y la distancia de riesgo se mantiene aunque haya slippage. |
| T7 | `amend_order` | Cambio de precio, SL, TP o expiración de una límite pendiente. Re-evalúa el riesgo **sin contar la orden misma** (ni en riesgo abierto ni en trades del día) y el volumen solo puede quedar igual o bajar. | La Fase 7 pide "modificarla", y esto evita usar la modificación para agrandar el riesgo. |
| T8 | `amend_position_sl_tp` | SL y TP son obligatorios. El SL nuevo solo puede acercarse (regla R12). Se valida contra el bid/ask actual. | |
| T9 | `close_position` parcial | Las unidades se redondean al `stepVolume`. Si el remanente quedara por debajo de `minVolume`, se rechaza (hay que cerrar todo). | |
| T10 | Journal | Cada orden crea una fila en `trades` (con tesis, setup, killzone y riesgo planificado) **antes** de enviarse. Los execution events la actualizan: fill de la límite → `open`; cancelación/expiración; cierres parciales acumulan PyG; al cierre total se calculan R y el motivo (el `reason` de `close_position`, o inferido: SL, SL movido o TP). La comisión de apertura se registra al confirmar el fill. | |
| T11 | Respuestas | JSON compacto. Los rechazos (motor o broker) se devuelven con `isError: true` y los motivos, para que el modelo los note. `get_candles` usa formato columnar (`t,o,h,l,c`). | Ahorra tokens. |
| T12 | `get_journal` / `get_performance` | Se implementan en la Fase 5, sobre la tabla `trades` que ya se llena acá. | |

## Fase 5: journal y métricas

| # | Tema | Decisión | Motivo |
|---|------|----------|--------|
| J1 | Fuente de las métricas | Solo la tabla `trades` (trades enviados por este servidor), y solo los **cerrados**. Un trade es ganador si su PyG (neto de comisiones y swap) es > 0. R = PyG / riesgo planificado al entrar. | Las métricas dependen de una sola fuente que se puede auditar. |
| J2 | Métricas | Win rate, R medio (= expectancy en R), expectancy en la moneda de la cuenta, profit factor (null si no hay pérdidas), mejor y peor R, R medio de ganadores y de perdedores, max drawdown sobre la curva acumulada (en dinero y en R), racha máxima de pérdidas. Desglose por símbolo, killzone y setup. | Lo que pide el prompt para decidir qué setups dejar. |
| J3 | Advertencias | Con menos de 30 trades cerrados la respuesta lo advierte. Un setup con ≥ 10 trades y R medio negativo también se marca. | Para no sacar conclusiones con muestras chicas. |
| J4 | `daily_stats` | Una fila por día de NY. Balance inicial = primer snapshot del día; balance final = el último. Los contadores (aperturas, cierres, ganadores, PyG, R, rechazos) se **recalculan** a partir de `trades` y `events`. | Siempre se pueden regenerar desde el journal. |
| J5 | Reconciliación del journal | Después de cada reconcile del cliente (al conectar y cada 5 min) se comparan los trades `pending`/`unconfirmed`/`open` con el estado real. Si una orden ya no está, `ProtoOAOrderDetailsReq` dice si se llenó, se canceló o expiró. Si una posición ya no está, `ProtoOADealListByPositionIdReq` aporta los deals de cierre (PyG, precio de salida, hora). Si no hay discrepancias, no se hace ningún request. | Cubre eventos perdidos (servidor caído, desconexión) y cambios hechos desde la app de cTrader. |
| J6 | Filtros de fecha | `since` y `until` se comparan con la fecha de creación del trade, en UTC (`YYYY-MM-DD` = 00:00 UTC). | Es simple y predecible para el agente. |
