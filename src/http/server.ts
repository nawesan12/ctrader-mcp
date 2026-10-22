import type { Server } from 'node:http';
import express, { type NextFunction, type Request, type Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { getOAuthProtectedResourceMetadataUrl, mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { App } from '../app.js';
import type { Config } from '../config.js';
import type { DB } from '../db/database.js';
import type { Logger } from '../logger.js';
import { registerTools } from '../mcp/tools.js';
import { SCOPE, SingleOwnerOAuthProvider, sendConsentPage } from './oauth.js';

export type HttpConfig = Pick<
  Config,
  'MCP_AUTH_TOKEN' | 'OAUTH_OWNER_PASSWORD' | 'PUBLIC_URL' | 'OAUTH_EXTRA_REDIRECT_URIS' | 'TRUST_PROXY' | 'MCP_ALLOWED_ORIGINS' | 'RATE_LIMIT_PER_MIN' | 'PORT'
>;

export interface HttpOptions {
  app: App;
  db: DB;
  config: HttpConfig;
  logger: Logger;
  version: string;
  now?: () => number;
}

const MAX_BODY = '1mb';

/** Refuse to run without authentication, and OAuth without a public HTTPS URL. */
export function assertAuthConfig(c: HttpConfig): void {
  if (!c.MCP_AUTH_TOKEN && !c.OAUTH_OWNER_PASSWORD) {
    throw new Error('No authentication configured: set MCP_AUTH_TOKEN and/or OAUTH_OWNER_PASSWORD');
  }
  if (c.OAUTH_OWNER_PASSWORD && !c.PUBLIC_URL) throw new Error('OAUTH_OWNER_PASSWORD requires PUBLIC_URL (e.g. https://mcp.example.com)');
}

export function createHttpApp(o: HttpOptions) {
  assertAuthConfig(o.config);
  const log = o.logger.child({ component: 'http' });
  const startedAt = (o.now ?? Date.now)();
  const publicUrl = o.config.PUBLIC_URL ?? `http://localhost:${o.config.PORT}`;
  const resourceUrl = new URL(`${publicUrl}/mcp`);
  const oauth = new SingleOwnerOAuthProvider({
    db: o.db,
    ownerPassword: o.config.OAUTH_OWNER_PASSWORD,
    staticToken: o.config.MCP_AUTH_TOKEN,
    resourceUrl,
    extraRedirectUris: o.config.OAUTH_EXTRA_REDIRECT_URIS,
    logger: o.logger,
    now: o.now,
  });

  const http = express();
  http.disable('x-powered-by');
  // Behind Caddy/cloudflared the client IP comes in X-Forwarded-For (one trusted hop).
  http.set('trust proxy', o.config.TRUST_PROXY ? 1 : false);
  http.use((_req, res, next) => {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
    next();
  });

  // ---------------------------------------------------------------- health (no auth, no secrets)
  http.get('/health', (_req, res) => {
    const c = o.app.client;
    const ready = c.status === 'ready';
    res.status(ready ? 200 : 503).json({
      status: ready ? 'ok' : 'degraded',
      ctrader: c.status,
      lastReconcileAt: c.state.lastReconcileAt ? new Date(c.state.lastReconcileAt).toISOString() : null,
      lastError: c.lastError ?? null,
      version: o.version,
      uptimeS: Math.round(((o.now ?? Date.now)() - startedAt) / 1000),
    });
  });

  // ---------------------------------------------------------------- OAuth (claude.ai custom connector)
  if (oauth.enabled) {
    http.use(
      mcpAuthRouter({
        provider: oauth,
        issuerUrl: new URL(publicUrl),
        resourceServerUrl: resourceUrl,
        scopesSupported: [SCOPE],
        resourceName: 'ctrader-mcp',
      }),
    );
    const consentLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 20, standardHeaders: 'draft-8', legacyHeaders: false });
    http.post('/oauth/consent', consentLimiter, express.urlencoded({ extended: false, limit: '10kb' }), (req: Request, res: Response) => {
      const r = oauth.handleConsent((req.body ?? {}) as Record<string, unknown>);
      if ('redirect' in r) return res.redirect(302, r.redirect);
      if ('page' in r) return sendConsentPage(res, r.page, r.status);
      return res.status(r.status).type('text/plain').send(r.text);
    });
  }

  // ---------------------------------------------------------------- MCP endpoint
  const mcpLimiter = rateLimit({
    windowMs: 60_000,
    limit: o.config.RATE_LIMIT_PER_MIN,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { jsonrpc: '2.0', error: { code: -32000, message: 'Too many requests' }, id: null },
  });
  const originCheck = (req: Request, res: Response, next: NextFunction) => {
    const origin = req.get('origin');
    // CORS stays closed: no Access-Control-* headers are ever sent for /mcp.
    if (origin && o.config.MCP_ALLOWED_ORIGINS.length > 0 && !o.config.MCP_ALLOWED_ORIGINS.includes(origin)) {
      log.warn({ origin }, 'rejected /mcp request from a non-allowed Origin');
      return res.status(403).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Origin not allowed' }, id: null });
    }
    next();
  };
  const auth = requireBearerAuth({
    verifier: oauth,
    resourceMetadataUrl: oauth.enabled ? getOAuthProtectedResourceMetadataUrl(resourceUrl) : undefined,
    expectedResource: resourceUrl,
  });

  http.options('/mcp', (_req, res) => res.status(403).end());
  http.post('/mcp', mcpLimiter, originCheck, auth, express.json({ limit: MAX_BODY }), async (req: Request, res: Response) => {
    // Stateless: a fresh server + transport per request (no session state to leak or lose on restart).
    const server = new McpServer({ name: 'ctrader-mcp', version: o.version });
    registerTools(server, o.app);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      log.error({ err: (err as Error).message }, 'mcp request failed');
      if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null });
    }
  });
  const notAllowed = (_req: Request, res: Response) =>
    res.status(405).set('Allow', 'POST').json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed (stateless server: POST only)' }, id: null });
  http.get('/mcp', mcpLimiter, originCheck, auth, notAllowed);
  http.delete('/mcp', mcpLimiter, originCheck, auth, notAllowed);

  // ---------------------------------------------------------------- fallbacks
  http.use((_req, res) => res.status(404).json({ error: 'not found' }));
  http.use((err: Error & { status?: number; type?: string }, _req: Request, res: Response, _next: NextFunction) => {
    if (err.type === 'entity.too.large') return res.status(413).json({ error: `body larger than ${MAX_BODY}` });
    if (err.status && err.status >= 400 && err.status < 500) return res.status(err.status).json({ error: err.message });
    log.error({ err: err.message }, 'unhandled http error');
    return res.status(500).json({ error: 'internal error' });
  });

  return { http, oauth };
}

/** Listen and return a close() that stops accepting and waits for in-flight requests (max 10 s). */
export function listen(http: express.Express, port: number, host: string): Promise<{ server: Server; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server = http.listen(port, host, () => {
      resolve({
        server,
        close: () =>
          new Promise<void>((done) => {
            const force = setTimeout(() => {
              server.closeAllConnections();
              done();
            }, 10_000);
            server.close(() => {
              clearTimeout(force);
              done();
            });
            server.closeIdleConnections();
          }),
      });
    });
    server.once('error', reject);
  });
}
