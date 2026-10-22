# Verificación (Fase 7)

El servidor se desarrolló en un contenedor cloud **sin acceso a la demo de cTrader**: el proxy de salida no permite WebSocket ni puertos que no sean 443. Por eso cada punto aclara dónde quedó verificado y qué falta correr del lado tuyo.

## Estado

| # | Verificación | Estado | Cómo / dónde |
|---|--------------|--------|--------------|
| 1 | Tests unitarios: normalización, valor del pip en cruces, motor de riesgo (cada regla aceptada y rechazada), SMC con fixtures | ✅ 178 tests, estables en corridas repetidas | `npm test` |
| 1b | Cliente cTrader: auth, guardia demo, refresh, correlación, timeouts, reconexión, rate limit | ✅ con broker falso y con un servidor WebSocket local real | `tests/unit/client.test.ts`, `transport.test.ts` |
| 1c | Tools completas: idempotencia, concurrencia, ciclos límite y mercado, journal, PyG/R, eventos perdidos | ✅ con broker simulado, a través de un cliente MCP real | `tests/unit/tools.test.ts`, `journal.test.ts` |
| 1d | HTTP: auth, 401 + discovery, 413, CORS, rate limit y flujo OAuth completo | ✅ incluye el cliente HTTP MCP real del SDK | `tests/unit/http.test.ts` |
| 2 | Integración contra la demo: auth, lista de cuentas (demo), símbolos, velas H1 EURUSD, `preview_order`, límite lejos → modificar → cancelar, journal | ⏳ **pendiente, lo corrés vos** | `INTEGRATION=1 npm run test:integration` |
| 3 | Reconexión: cortar el WS y verificar que se recupera, reautentica y reconcilia | ✅ simulado · ⏳ real | Simulado en unit tests. Real: test "recovers after a manual socket drop" (`INTEGRATION=1`) |
| 4 | Token vencido: forzar refresh y verificar que se persiste | ✅ simulado · ⏳ real | Real: `INTEGRATION=1 INTEGRATION_REFRESH=1 npm run test:integration`. **Rota el par**: el nuevo queda en `data/` |
| 5 | MCP Inspector contra `/mcp`, llamando cada tool | ✅ las 15 tools (17 llamadas, incluido un rechazo esperado) contra el servidor HTTP real con broker simulado · ⏳ contra el deploy | `npm run sim` + `bash scripts/inspector-smoke.sh`. Deploy: `MCP_URL=https://.../mcp MCP_TOKEN=... bash scripts/inspector-smoke.sh` (en real solo coloca, modifica y cancela una límite lejana; el mercado solo con `SMOKE_MARKET=1`) |
| 6 | Build de producción | ✅ artefacto (`npm ci` → build → `prune --omit=dev`) ejecutado: `/health`, 401, metadata OAuth, `tools/list`, shutdown con SIGTERM · ⏳ imagen Docker | Docker Hub y ECR respondieron 429 desde el entorno de desarrollo. `docker compose config` valida. La imagen se construye en el VPS |

## Orden sugerido en tu máquina o en el VPS

```bash
npm ci
INTEGRATION=1 npm run test:integration              # 2, 3
INTEGRATION=1 INTEGRATION_REFRESH=1 npm run test:integration -t "refreshes"   # 4 (rota tokens)
docker compose --profile caddy up -d --build        # o --profile tunnel
curl https://mcp.tudominio.com/health
MCP_URL=https://mcp.tudominio.com/mcp MCP_TOKEN=<MCP_AUTH_TOKEN> bash scripts/inspector-smoke.sh   # 5
```

Los tests de integración imprimen lo que conviene revisar a mano: cuentas e `isLive`, detalle de EURUSD, valor del pip por lote en EURUSD/USDJPY/EURGBP, el `get_smc_context` completo y la fila del journal.

## Supuestos que confirma la integración

- Formato JSON real de int64 y enums (se aceptan número/string y número/nombre: D12).
- Código de error con un access token vencido (se espera `CH_ACCESS_TOKEN_INVALID` u `OA_AUTH_TOKEN_EXPIRED`: D5).
- Máximo de `count` en trendbars (las velas se paginan igual: S11).
- Si los eventos posteriores de una orden (`ORDER_FILLED`) llegan con o sin `clientMsgId` (los dos casos están cubiertos: T4).
- `expiresIn` de `ProtoOARefreshTokenRes` en segundos o en ms (se aceptan ambos: D6).

## Riesgos conocidos

1. **Sin prueba contra la demo real todavía.** El protocolo se implementó contra los `.proto` oficiales y está cubierto por simulación, pero la confirmación final es el punto 2.
2. **Pérdida diaria con depósitos o retiros intradía** (R9): el balance de inicio de día se estima como `balance − realizado de hoy`. Un depósito o retiro durante el día distorsiona el porcentaje.
3. **Spread medio** (R10): el baseline arranca vacío después de cada reinicio. Durante los primeros 60 segundos con spots, las órdenes de mercado se rechazan (las límite no).
4. **Datos de mercado de otras fuentes:** el SMC usa las velas del broker. Puede diferir de TradingView en el cierre diario o semanal y en los gaps de fin de semana.
5. **Comisiones** (J1): el PyG del journal incluye comisión, swap y fee de conversión tal como los informa el broker. El riesgo planificado (R) **no** descuenta la comisión, así que un trade que toca el SL exacto da un poco menos que −1R.
6. **OAuth de un solo dueño:** la seguridad del conector de claude.ai depende de `OAUTH_OWNER_PASSWORD`. Usá una contraseña larga y única.
7. **Single point of failure:** un solo proceso y una sola conexión. Si el VPS se cae, las órdenes ya colocadas siguen en el broker con su SL/TP, y al volver el journal se reconcilia solo (J5).
8. **Rentabilidad:** el sistema acota y mide el riesgo, pero no garantiza ventaja. Hay que mirar `get_performance` con al menos 30 trades antes de sacar conclusiones.
