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

/** Comma separated list, values kept as written (URLs are case sensitive). */
const list = z
  .string()
  .default('')
  .transform((s) => s.split(',').map((x) => x.trim()).filter((x) => x.length > 0));

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
  /** Static bearer (Claude Code, or claude.ai orgs with the request-headers beta). Empty = disabled. */
  MCP_AUTH_TOKEN: z
    .string()
    .optional()
    .transform((v) => (v && v.trim() !== '' ? v.trim() : undefined))
    .refine((v) => v === undefined || v.length >= 32, 'MCP_AUTH_TOKEN must be at least 32 characters (e.g. `openssl rand -hex 32`)'),
  /** Password for the OAuth consent page (claude.ai custom connector). Empty = OAuth disabled. */
  OAUTH_OWNER_PASSWORD: z
    .string()
    .optional()
    .transform((v) => (v && v !== '' ? v : undefined))
    .refine((v) => v === undefined || v.length >= 16, 'OAUTH_OWNER_PASSWORD must be at least 16 characters'),
  /** Public HTTPS base URL, e.g. https://mcp.example.com (the MCP endpoint is <PUBLIC_URL>/mcp). */
  PUBLIC_URL: z
    .string()
    .url()
    .optional()
    .transform((v) => (v ? v.replace(/\/+$/, '') : undefined)),
  /** Extra redirect URIs accepted at client registration (comma separated). */
  OAUTH_EXTRA_REDIRECT_URIS: list,
  /** 1 when running behind a reverse proxy (Caddy / cloudflared) that sets X-Forwarded-For. */
  TRUST_PROXY: z
    .string()
    .optional()
    .transform((v) => v === '1' || v === 'true'),
  /** Optional comma separated Origin allowlist for /mcp. Empty = Origin is not checked (auth still required). */
  MCP_ALLOWED_ORIGINS: list,
  RATE_LIMIT_PER_MIN: z.coerce.number().int().positive().default(120),
  HOST: z.string().default('0.0.0.0'),
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
