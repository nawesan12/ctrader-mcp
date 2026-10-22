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
