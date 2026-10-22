# ctrader-mcp

Servidor MCP remoto para operar una cuenta **demo** de cTrader mediante la cTrader Open API (JSON sobre WebSocket).

> Estado: **Fase 1** (cliente cTrader confiable + normalización). El servidor MCP, el motor de riesgo, el SMC y el journal llegan en las fases siguientes.

## Requisitos

- Node 22+
- Una app en https://openapi.ctrader.com (client id y secret) y un par de tokens con acceso a la cuenta demo

## Configuración

```bash
cp .env.example .env   # completar credenciales
npm ci
```

`CTRADER_ACCESS_TOKEN` / `CTRADER_REFRESH_TOKEN` solo se usan la **primera vez**: se guardan cifrados en `data/ctrader-mcp.db` y, desde ahí, el servidor renueva y persiste los tokens por su cuenta (ver `docs/DECISIONS.md`, D4). No borres `data/`.

## Scripts

| Comando | Qué hace |
| --- | --- |
| `npm run dev` | Conecta a la demo, autentica, reconcilia y carga los símbolos |
| `npm test` | Tests unitarios |
| `npm run typecheck` / `npm run lint` | Chequeo de tipos y lint |
| `INTEGRATION=1 npm run test:integration` | Tests contra la demo real: auth, guardia demo, símbolos, velas H1 de EURUSD, valor del pip y reconexión |
| `INTEGRATION=1 INTEGRATION_REFRESH=1 npm run test:integration` | Además fuerza un refresh de tokens (rota el par y lo persiste) |

## Estructura

```
src/
  config.ts              env validado con zod (solo CTRADER_ENV=demo)
  logger.ts              pino con redacción de tokens
  db/                    SQLite (migraciones) + store de tokens cifrado
  ctrader/
    payloadTypes.ts      ids de mensajes tomados de los .proto oficiales
    schemas.ts           schemas zod de respuestas y eventos
    transport.ts         interfaz Transport + JSON/WebSocket
    rateLimiter.ts       ventanas de 45/s y 4/s (histórico)
    client.ts            auth, refresh, guardia demo, correlación, heartbeat, reconexión, reconcile
    accountState.ts      posiciones y órdenes en memoria
    normalize.ts         precios, velas, volumen, conversión y valor del pip
    symbols.ts           caché de símbolos y assets + quotes en vivo
```
