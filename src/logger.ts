import { pino, type Logger } from 'pino';

/** Paths redacted in every log line, at any nesting depth we use. */
export const REDACT_PATHS = [
  'accessToken',
  'refreshToken',
  'clientSecret',
  'authorization',
  'token',
  '*.accessToken',
  '*.refreshToken',
  '*.clientSecret',
  '*.authorization',
  '*.token',
  '*.*.accessToken',
  '*.*.refreshToken',
  '*.*.clientSecret',
  'req.headers.authorization',
];

export function createLogger(level = 'info', destination?: pino.DestinationStream): Logger {
  return pino(
    {
      level,
      redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
      base: { app: 'ctrader-mcp' },
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    destination,
  );
}

export type { Logger };
