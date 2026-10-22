import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { App } from '../app.js';
import { TrendbarPeriod, type Timeframe } from '../ctrader/payloadTypes.js';

/**
 * MCP tool definitions. Inputs are validated with zod by the SDK before the
 * handler runs; every order goes through the risk engine inside OrderService.
 * Outputs are compact JSON text (no pretty-printing) to save tokens.
 */

const TIMEFRAMES = Object.keys(TrendbarPeriod) as [Timeframe, ...Timeframe[]];

const symbol = z
  .string()
  .min(3)
  .max(20)
  .regex(/^[A-Za-z0-9/._-]+$/)
  .describe('Symbol, e.g. "EURUSD" (separators are ignored)');
const side = z.enum(['BUY', 'SELL']);
const price = z.number().positive().finite();
const idempotencyKey = z
  .string()
  .min(8)
  .max(80)
  .regex(/^[A-Za-z0-9_.:-]+$/)
  .describe('Unique key for this action (e.g. "2026-10-22-eurusd-long-1"). Re-sending the same key within 10 min returns the first result instead of acting twice. Use a NEW key for a new action.');
const reason = z.string().min(5).max(500).describe('Why you are doing this (stored in the journal)');
const thesis = z
  .string()
  .min(20)
  .max(2000)
  .describe('Mandatory trade thesis for the journal: context, setup, invalidation. Be specific.');
const setup = z.string().min(2).max(60).optional().describe('Short setup tag used in statistics, e.g. "OB+FVG H1", "liquidity sweep"');
const label = z.string().min(1).max(50).optional().describe('Broker label for the order/position');
const riskPct = z.number().positive().max(100).optional().describe('Optional LOWER risk % for this trade; the server cap (RISK_PER_TRADE_PCT) always applies');
const newsEvents = z
  .array(
    z.object({
      currency: z.string().length(3).describe('ISO currency, e.g. "USD"'),
      time: z.iso.datetime({ offset: true }).describe('Release time, ISO-8601'),
      impact: z.enum(['high', 'medium', 'low']).optional(),
      title: z.string().max(120).optional(),
    }),
  )
  .max(30)
  .optional()
  .describe('Economic calendar events you checked. High-impact events of the symbol currencies within ±15 min block MARKET orders.');
const blockedUntil = z.iso.datetime({ offset: true }).optional().describe('If you decided market orders must wait (e.g. news), until when (ISO-8601)');

function ok(data: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}

function fail(err: unknown): CallToolResult {
  const message = err instanceof Error ? `${err.name === 'Error' ? '' : `${err.name}: `}${err.message}` : String(err);
  return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: message }) }] };
}

async function run(fn: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    const data = await fn();
    // Rejections from the risk engine/broker are normal results, but flag them as errors so the model notices.
    if (data && typeof data === 'object' && 'ok' in data && (data).ok === false) {
      return { isError: true, content: [{ type: 'text', text: JSON.stringify(data) }] };
    }
    return ok(data);
  } catch (err) {
    return fail(err);
  }
}

const READ = { readOnlyHint: true, openWorldHint: true } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true } as const;

export function registerTools(server: McpServer, app: App): void {
  const depositInfo = () => {
    const trader = app.client.trader;
    if (!trader) throw new Error('account not loaded yet');
    return { id: trader.depositAssetId, name: app.symbols.assetName(trader.depositAssetId) ?? String(trader.depositAssetId) };
  };

  server.registerTool(
    'get_account',
    {
      title: 'Account status',
      description:
        'Balance, equity, margin, today P&L (NY day, realized + floating), open risk, net risk % per currency and what the risk limits still allow (open risk, daily loss, trades left per symbol). Call this first.',
      inputSchema: {},
      annotations: READ,
    },
    () => run(() => app.views.account()),
  );

  server.registerTool(
    'get_positions',
    {
      title: 'Open positions',
      description: 'Open positions with P&L, R multiple (vs. planned risk), pips to SL/TP, hours open and setup.',
      inputSchema: {},
      annotations: READ,
    },
    () => run(() => app.views.positions()),
  );

  server.registerTool(
    'get_orders',
    {
      title: 'Pending orders',
      description: 'Pending orders with price, SL/TP, pips from market, planned risk, expiry and age.',
      inputSchema: {},
      annotations: READ,
    },
    () => run(() => app.views.orders()),
  );

  server.registerTool(
    'get_symbol_info',
    {
      title: 'Symbol details',
      description: 'Digits, pip size, pip value in account currency (per unit and per lot), volume limits in units, bid/ask, current and session-average spread.',
      inputSchema: { symbol },
      annotations: READ,
    },
    ({ symbol: s }) => run(() => {
      const dep = depositInfo();
      return app.views.symbolInfo(s, dep.id, dep.name);
    }),
  );

  server.registerTool(
    'get_candles',
    {
      title: 'OHLC candles',
      description:
        'Raw OHLC in columnar form. Expensive in tokens: prefer get_smc_context and only ask for candles when you really need them (keep count small).',
      inputSchema: {
        symbol,
        timeframe: z.enum(TIMEFRAMES),
        count: z.number().int().min(1).max(500).default(100),
        includeForming: z.boolean().default(false).describe('Include the bar still forming (default: closed bars only)'),
      },
      annotations: READ,
    },
    ({ symbol: s, timeframe, count, includeForming }) => run(() => app.views.candles(s, timeframe, count, includeForming)),
  );

  server.registerTool(
    'get_smc_context',
    {
      title: 'Smart Money Concepts context',
      description:
        'Deterministic SMC read (closed candles, no repainting): trend and last BOS/CHoCH per timeframe, nearest valid order blocks and FVGs above/below with distance in pips, unswept EQH/EQL, PDH/PDL, PWH/PWL, NY midnight open, ADR and % used, premium/discount with OTE, current NY killzone and a suggested bias with its reasons. No raw candles.',
      inputSchema: {
        symbol,
        timeframes: z.array(z.enum(TIMEFRAMES)).min(1).max(4).default(['H4', 'H1', 'M15']),
      },
      annotations: READ,
    },
    ({ symbol: s, timeframes }) => run(() => app.smc.context(s, timeframes)),
  );

  server.registerTool(
    'preview_order',
    {
      title: 'Preview order (sends nothing)',
      description:
        'Runs the full server-side risk engine without sending anything: position size, risk in account currency, R:R and every rule with pass/fail. Use it before placing an order.',
      inputSchema: {
        symbol,
        side,
        orderType: z.enum(['LIMIT', 'MARKET']),
        entry: price.optional().describe('Limit price (required for LIMIT)'),
        stopLoss: price,
        takeProfit: price,
        riskPct,
        blockedUntil,
        newsEvents,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (args) =>
      run(async () => {
        const d = await app.risk.evaluate(args, { record: 'preview' });
        return { ok: d.ok, reasons: d.reasons, sizing: d.sizing ?? null, checks: d.checks };
      }),
  );

  server.registerTool(
    'place_limit_order',
    {
      title: 'Place limit order',
      description:
        'Places a LIMIT order with absolute SL/TP after the risk engine sizes and approves it. Size is computed by the server from RISK_PER_TRADE_PCT (you cannot set units). Returns the state confirmed by the broker execution event.',
      inputSchema: {
        symbol,
        side,
        entry: price,
        stopLoss: price,
        takeProfit: price,
        expiresAt: z.iso.datetime({ offset: true }).optional().describe('Good-till-date expiry (ISO-8601); omit for good-till-cancel'),
        label,
        thesis,
        setup,
        riskPct,
        idempotencyKey,
      },
      annotations: WRITE,
    },
    (args) => run(() => app.orders.placeLimit(args)),
  );

  server.registerTool(
    'place_market_order',
    {
      title: 'Place market order',
      description:
        'Market order, only if the risk engine allows it (spread, news window, limits). SL/TP are sent as distances from the fill price. Pass the calendar events you checked in newsEvents. Returns the confirmed fill.',
      inputSchema: { symbol, side, stopLoss: price, takeProfit: price, label, thesis, setup, riskPct, blockedUntil, newsEvents, idempotencyKey },
      annotations: WRITE,
    },
    (args) => run(() => app.orders.placeMarket(args)),
  );

  server.registerTool(
    'amend_order',
    {
      title: 'Amend pending limit order',
      description: 'Changes price, SL, TP or expiry of a pending LIMIT order. Re-runs the risk engine; the size can only stay the same or shrink.',
      inputSchema: {
        orderId: z.number().int().positive(),
        entry: price.optional(),
        stopLoss: price.optional(),
        takeProfit: price.optional(),
        expiresAt: z.iso.datetime({ offset: true }).optional(),
        reason,
        idempotencyKey,
      },
      annotations: WRITE,
    },
    (args) => run(() => app.orders.amendOrder(args)),
  );

  server.registerTool(
    'amend_position_sl_tp',
    {
      title: 'Amend position SL/TP',
      description: 'Sets new SL and TP on an open position (e.g. move SL to breakeven). Rejected if the new SL increases risk. Both SL and TP are required.',
      inputSchema: { positionId: z.number().int().positive(), stopLoss: price, takeProfit: price, reason, idempotencyKey },
      annotations: WRITE,
    },
    (args) => run(() => app.orders.amendPosition(args)),
  );

  server.registerTool(
    'close_position',
    {
      title: 'Close position',
      description: 'Closes an open position fully, or partially when units is given. Reason is mandatory and goes to the journal.',
      inputSchema: {
        positionId: z.number().int().positive(),
        units: z.number().positive().optional().describe('Units to close (omit to close everything)'),
        reason,
        idempotencyKey,
      },
      annotations: DESTRUCTIVE,
    },
    (args) => run(() => app.orders.closePosition(args)),
  );

  server.registerTool(
    'cancel_order',
    {
      title: 'Cancel pending order',
      description: 'Cancels a pending order. Reason is mandatory and goes to the journal.',
      inputSchema: { orderId: z.number().int().positive(), reason, idempotencyKey },
      annotations: DESTRUCTIVE,
    },
    (args) => run(() => app.orders.cancelOrder(args)),
  );
}
