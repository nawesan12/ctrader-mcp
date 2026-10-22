import { z } from 'zod';

const csv = z
  .string()
  .default('')
  .transform((s) =>
    s
      .split(',')
      .map((x) => x.trim().toUpperCase())
      .filter((x) => x.length > 0),
  );

const optionalInt = z
  .string()
  .optional()
  .transform((s, ctx) => {
    if (s === undefined || s.trim() === '') return undefined;
    const n = Number(s);
    if (!Number.isSafeInteger(n) || n <= 0) {
      ctx.addIssue({ code: 'custom', message: 'must be a positive integer' });
      return z.NEVER;
    }
    return n;
  });

const pct = z.coerce.number().positive().max(100);

export const ConfigSchema = z.object({
  CTRADER_CLIENT_ID: z.string().min(1),
  CTRADER_CLIENT_SECRET: z.string().min(1),
  CTRADER_ACCESS_TOKEN: z.string().optional(),
  CTRADER_REFRESH_TOKEN: z.string().optional(),
  CTRADER_ACCOUNT_ID: optionalInt,
  // Hard guard: this version only ever talks to the demo environment.
  CTRADER_ENV: z.literal('demo', { error: 'CTRADER_ENV must be "demo" (live is out of scope)' }),
  MCP_AUTH_TOKEN: z.string().optional(),
  PORT: z.coerce.number().int().positive().default(8787),
  DATA_DIR: z.string().default('./data'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  RISK_PER_TRADE_PCT: pct.default(0.5),
  MAX_OPEN_RISK_PCT: pct.default(2),
  MAX_TRADES_PER_SYMBOL_PER_DAY: z.coerce.number().int().positive().default(3),
  DAILY_LOSS_LIMIT_PCT: pct.default(2),
  ALLOWED_SYMBOLS: csv,
  TZ_SESSIONS: z.string().default('America/New_York'),
});

export type Config = z.infer<typeof ConfigSchema>;

/** Demo endpoint for JSON over WebSocket (help.ctrader.com/open-api/proxies-endpoints). */
export const CTRADER_DEMO_JSON_URL = 'wss://demo.ctraderapi.com:5036';

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = ConfigSchema.safeParse(env);
  if (!parsed.success) {
    // Only field names and messages: never echo values, they may be secrets.
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration: ${issues}`);
  }
  return parsed.data;
}
