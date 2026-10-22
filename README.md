# ctrader-mcp

Servidor MCP remoto (HTTP) que conecta a Claude con una cuenta **demo** de cTrader mediante la cTrader Open API (JSON sobre WebSocket). Expone tools para leer la cuenta, analizar el mercado con SMC de forma determinista, operar con **gestión de riesgo forzada en el servidor** y llevar un journal con métricas.

> **Estado:** las 7 fases están implementadas. Lo que falta verificar contra la demo real (integración, refresh y deploy) está en [`docs/VERIFICATION.md`](docs/VERIFICATION.md). Las decisiones y las diferencias con la documentación están en [`docs/DECISIONS.md`](docs/DECISIONS.md).
>
> **Aviso:** nada de esto garantiza rentabilidad. Lo que el servidor sí asegura es que el riesgo de cada operación esté acotado y que todo quede registrado para evaluar la estrategia con datos.

## Tools

| Tool | Qué hace |
| --- | --- |
| `get_account` | Balance, equity, margen, PyG del día (NY), riesgo abierto, exposición por moneda y límites restantes |
| `get_positions` / `get_orders` | Estado actual con R múltiplo, pips a SL/TP y tiempo abierto |
| `get_symbol_info` | Digits, valor del pip en la moneda de la cuenta, volúmenes, spread actual y medio |
| `get_candles` | OHLC columnar (máx. 500); solo cuando haga falta |
| `get_smc_context` | Tendencia, BOS/CHoCH, OB/FVG cercanos, liquidez, niveles, premium/discount, killzone y bias |
| `preview_order` | Tamaño, riesgo, R:R y cada regla del motor, **sin enviar nada** |
| `place_limit_order` / `place_market_order` | Órdenes con SL/TP obligatorios, tesis obligatoria e idempotencia |
| `amend_order` | Modifica una límite pendiente (re-evalúa riesgo; el tamaño nunca sube) |
| `amend_position_sl_tp` | Mueve SL/TP de una posición (el SL nunca puede aumentar el riesgo) |
| `close_position` / `cancel_order` | Total o parcial, con motivo obligatorio |
| `get_journal` / `get_performance` | Trades con tesis y resultado; win rate, expectancy, PF, drawdown por símbolo/killzone/setup |

## 1. Credenciales de cTrader

1. Entrá a https://openapi.ctrader.com con tu cTID y creá una aplicación. Ahí obtenés el **Client ID** y el **Client Secret**. La aprobación de la app puede tardar.
2. En la app, abrí el **Playground** (la primera redirect URI es la del Playground) y autorizá tu cuenta con permiso de trading. Obtenés el **access token** y el **refresh token**.
3. `CTRADER_ACCOUNT_ID` es el `ctidTraderAccountId` de la cuenta **demo**, que no es el número de login. Si lo dejás vacío y el token tiene una sola cuenta demo, el servidor la elige solo. El test de integración imprime la lista de cuentas con su `isLive`.

Detalle del flujo: https://help.ctrader.com/open-api/account-authentication/

> Los tokens del `.env` solo se usan **la primera vez**. Después se guardan cifrados en `data/ctrader-mcp.db`, y el servidor los renueva y persiste por su cuenta (cTrader invalida el par anterior en cada renovación). **No borres `data/`.**

## 2. Correr local

Requiere Node 22 o superior.

```bash
cp .env.example .env        # completar
npm ci
npm test                    # tests unitarios
INTEGRATION=1 npm run test:integration   # contra la demo real (ver más abajo)
npm run dev                 # servidor en http://localhost:8787 (/health, /mcp)
```

Sin cuenta ni conexión podés probar todo contra un **broker simulado**: `npm run sim` levanta el servidor HTTP real en `http://127.0.0.1:8788/mcp` (bearer `sim-token-sim-token-sim-token-sim-token`) y `bash scripts/inspector-smoke.sh` llama las 15 tools con el MCP Inspector.

Para usarlo local con Claude Code: `MCP_AUTH_TOKEN` en `.env`, y después
`claude mcp add --transport http ctrader http://localhost:8787/mcp --header "Authorization: Bearer <MCP_AUTH_TOKEN>"`.

### Tests contra la demo (Fase 7)

`INTEGRATION=1 npm run test:integration` verifica:
- autenticación, y que la cuenta sea demo;
- símbolos, velas H1 de EURUSD (500), valor del pip en cruces y contexto SMC;
- un `preview_order`;
- la reconexión tras cortar el socket;
- **colocar una límite unos 300 pips lejos del precio → modificarla → cancelarla** a través de las tools MCP, verificando el journal.

Con `INTEGRATION_REFRESH=1` además fuerza la renovación del token.

## 3. Deploy en el VPS (Hostinger u otro Linux)

Requiere Docker con el plugin compose (`curl -fsSL https://get.docker.com | sh`).

```bash
git clone https://github.com/nawesan12/ctrader-mcp.git && cd ctrader-mcp
cp .env.example .env && nano .env
#   CTRADER_*, MCP_AUTH_TOKEN (openssl rand -hex 32), OAUTH_OWNER_PASSWORD,
#   PUBLIC_URL=https://mcp.tudominio.com y MCP_DOMAIN=mcp.tudominio.com
```

Elegí **una** forma de exponerlo con HTTPS. HTTPS es obligatorio: claude.ai solo acepta `https://` y el bearer no puede viajar en texto plano.

**A. Caddy** (certificado automático de Let's Encrypt). El registro DNS `A` de `MCP_DOMAIN` tiene que apuntar al VPS y los puertos 80 y 443 tienen que estar abiertos:

```bash
docker compose --profile caddy up -d --build
```

**B. Cloudflare Tunnel** (no abre ningún puerto; el dominio tiene que estar en Cloudflare). En Zero Trust → Networks → Tunnels, creá un túnel, copiá el token en `CLOUDFLARE_TUNNEL_TOKEN` y agregá un *public hostname* `mcp.tudominio.com` → `http://ctrader-mcp:8787`:

```bash
docker compose --profile tunnel up -d --build
```

Comprobación:

```bash
curl https://mcp.tudominio.com/health   # {"status":"ok","ctrader":"ready",...}
docker compose logs -f ctrader-mcp
```

Notas:
- La imagen final corre como usuario no-root, con el filesystem de solo lectura salvo el volumen `ctrader-data` (SQLite) y `restart: unless-stopped`.
- Si Docker Hub limita los pulls: `docker compose build --build-arg NODE_IMAGE=public.ecr.aws/docker/library/node:22-bookworm-slim`.
- Actualizar: `git pull && docker compose --profile caddy up -d --build`. Los datos quedan en el volumen.
- Backup: `docker compose cp ctrader-mcp:/app/data ./backup-data`.

## 4. Conectarlo a Claude

### claude.ai (conector personalizado, con OAuth)

claude.ai autentica conectores personalizados con OAuth. Los headers fijos están en beta y solo para algunas organizaciones. El servidor trae un OAuth mínimo de un solo dueño:

1. En el `.env` del VPS configurá `OAUTH_OWNER_PASSWORD` (16 caracteres o más) y `PUBLIC_URL`.
2. claude.ai → **Settings → Connectors → Add custom connector**.
3. URL: `https://mcp.tudominio.com/mcp`. Dejá vacíos los campos de OAuth Client ID/Secret: Claude se registra solo.
4. Al conectar se abre la página **Authorize trading access** del servidor. Ingresá la contraseña y aprobá.

El token de acceso dura 1 hora y Claude lo renueva solo. Solo se aceptan redirects de `claude.ai`/`claude.com` y loopback. Después de 20 contraseñas incorrectas en una hora, el consentimiento se bloquea.

Si tu organización tiene el beta de **Request headers**, también podés usar `Authorization: Bearer <MCP_AUTH_TOKEN>`.

### Claude Code

```bash
claude mcp add --transport http ctrader https://mcp.tudominio.com/mcp --header "Authorization: Bearer <MCP_AUTH_TOKEN>"
```

### La tarea diaria del agente

Una rutina sugerida para el prompt de la tarea programada:

`get_account` → `get_performance` (para no repetir setups con expectativa negativa) → `get_positions`/`get_orders` (gestionar lo abierto) → `get_smc_context` por símbolo → revisar el calendario económico → `preview_order` → `place_limit_order` con `thesis`, `setup` y un `idempotencyKey` nuevo.

El motor de riesgo decide el tamaño y rechaza lo que no cumpla las reglas, sin importar lo que diga el prompt.

## Seguridad

- **Solo demo.** `CTRADER_ENV` solo acepta `demo`, el servidor se conecta solo al host demo y una cuenta con `isLive !== false` aborta el proceso.
- **Secretos.** Los tokens de cTrader se guardan cifrados (AES-256-GCM). Los tokens OAuth se guardan solo como hash. Los logs redactan tokens. `.env` está en `.gitignore`.
- **`/mcp`.** Exige bearer (comparación en tiempo constante), aplica rate limit por IP, limita el body a 1 MB y no tiene CORS (cerrado). Opcionalmente valida `Origin` con una allowlist.
- **`/health`.** No requiere auth y no expone datos de la cuenta.

## Estructura

```
src/
  index.ts                 arranque, HTTP y shutdown limpio
  app.ts                   composición de servicios
  config.ts / logger.ts    env validado (zod) / pino con redacción
  http/                    servidor HTTP (Streamable HTTP stateless) y OAuth de un solo dueño
  mcp/tools.ts             definición de las 15 tools
  ctrader/                 transporte WS-JSON, cliente (auth, refresh, reconexión, reconcile), normalización, símbolos, velas
  risk/                    motor de riesgo puro + contexto desde el broker, exposición, spread
  analysis/                SMC determinista + resumen y bias
  trading/                 órdenes (idempotencia, mutex, confirmación por execution events) y vistas
  journal/                 trades, eventos, métricas, daily_stats, reconciliación con el broker
  db/                      SQLite (migraciones) y store de tokens cifrado
tests/
  unit/                    incluye un broker simulado y tests end-to-end por MCP y HTTP
  integration/             contra la demo real (INTEGRATION=1)
```
