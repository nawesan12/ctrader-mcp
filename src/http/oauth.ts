import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Response } from 'express';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import { InvalidClientMetadataError, InvalidGrantError, InvalidTargetError, InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { AuthorizationParams, OAuthServerProvider } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { OAuthClientInformationFull, OAuthTokenRevocationRequest, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { DB } from '../db/database.js';
import type { Logger } from '../logger.js';

/**
 * Minimal OAuth 2.1 authorization server for a SINGLE owner, so the server can
 * be added as a claude.ai custom connector (static request headers are a beta
 * limited to some organizations). Dynamic client registration + PKCE S256 are
 * handled by the SDK router; this provider stores clients, codes and tokens
 * (hashed) in SQLite and shows a consent page protected by OAUTH_OWNER_PASSWORD.
 *
 * MCP_AUTH_TOKEN (static bearer) is also accepted by verifyAccessToken.
 */

export const SCOPE = 'trade';
const ACCESS_TTL_S = 3600;
const REFRESH_TTL_S = 30 * 86_400;
const CODE_TTL_MS = 5 * 60_000;
const PENDING_TTL_MS = 10 * 60_000;
const MAX_CLIENTS = 50;
const MAX_ATTEMPTS_PER_REQUEST = 5;
const GLOBAL_FAILURE_LIMIT = 20;
const GLOBAL_LOCK_MS = 60 * 60_000;

/** Redirect URIs Claude uses (hosted apps) and loopback for Claude Code. */
export const CLAUDE_REDIRECTS = ['https://claude.ai/api/mcp/auth_callback', 'https://claude.com/api/mcp/auth_callback'];

export interface OAuthOptions {
  db: DB;
  /** undefined = OAuth disabled (only the static token works). */
  ownerPassword: string | undefined;
  staticToken: string | undefined;
  /** <PUBLIC_URL>/mcp — every token is bound to this resource. */
  resourceUrl: URL;
  extraRedirectUris: string[];
  logger: Logger;
  now?: () => number;
}

const sha256 = (s: string) => createHash('sha256').update(s).digest();
const hashHex = (s: string) => sha256(s).toString('hex');
const newSecret = () => randomBytes(32).toString('base64url');

/** Constant-time comparison of two secrets of any length. */
export function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(sha256(a), sha256(b));
}

export function isAllowedRedirect(uri: string, extra: string[]): boolean {
  if (CLAUDE_REDIRECTS.includes(uri) || extra.includes(uri)) return true;
  try {
    const u = new URL(uri);
    // RFC 8252 loopback redirect (Claude Code): any port, http only, no credentials.
    return u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1') && u.username === '' && u.password === '';
  } catch {
    return false;
  }
}

function sameResource(a: string, b: URL): boolean {
  const norm = (s: string) => {
    const u = new URL(s);
    u.hash = '';
    return u.href.replace(/\/$/, '');
  };
  try {
    return norm(a) === norm(b.href);
  } catch {
    return false;
  }
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export class SingleOwnerOAuthProvider implements OAuthServerProvider {
  private readonly now: () => number;
  private readonly log: Logger;
  private failures: number[] = [];

  constructor(private readonly o: OAuthOptions) {
    this.now = o.now ?? Date.now;
    this.log = o.logger.child({ component: 'oauth' });
  }

  get enabled(): boolean {
    return this.o.ownerPassword !== undefined;
  }

  // ------------------------------------------------------------------ clients (DCR)

  get clientsStore(): OAuthRegisteredClientsStore {
    return {
      getClient: (clientId: string) => {
        const row = this.o.db.prepare('SELECT data FROM oauth_clients WHERE client_id = ?').get(clientId) as { data: string } | undefined;
        return row ? (JSON.parse(row.data) as OAuthClientInformationFull) : undefined;
      },
      registerClient: (client: Omit<OAuthClientInformationFull, 'client_id' | 'client_id_issued_at'> & Partial<OAuthClientInformationFull>) => {
        if (!this.enabled) throw new InvalidClientMetadataError('OAuth is disabled on this server');
        const bad = client.redirect_uris.filter((u) => !isAllowedRedirect(String(u), this.o.extraRedirectUris));
        if (bad.length > 0) throw new InvalidClientMetadataError(`redirect_uri not allowed: ${bad.join(', ')}`);
        const full = client as OAuthClientInformationFull;
        const db = this.o.db;
        db.transaction(() => {
          const count = (db.prepare('SELECT COUNT(*) AS n FROM oauth_clients').get() as { n: number }).n;
          if (count >= MAX_CLIENTS) {
            db.prepare(
              `DELETE FROM oauth_clients WHERE client_id IN (
                 SELECT client_id FROM oauth_clients ORDER BY COALESCE(last_used_at, created_at) ASC LIMIT ?)`,
            ).run(count - MAX_CLIENTS + 1);
          }
          db.prepare('INSERT INTO oauth_clients (client_id, data, created_at) VALUES (?, ?, ?)').run(full.client_id, JSON.stringify(full), this.now());
        })();
        this.log.info({ clientId: full.client_id, name: full.client_name, redirects: full.redirect_uris }, 'oauth client registered');
        return full;
      },
    };
  }

  // ------------------------------------------------------------------ authorize + consent

  authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    if (!this.enabled) {
      res.status(403).type('text/plain').send('OAuth is disabled on this server (set OAUTH_OWNER_PASSWORD).');
      return Promise.resolve();
    }
    if (params.resource && !sameResource(params.resource.href, this.o.resourceUrl)) {
      throw new InvalidTargetError(`unknown resource ${params.resource.href}`);
    }
    const id = newSecret();
    this.o.db
      .prepare('INSERT INTO oauth_pending (id_hash, client_id, params, expires_at) VALUES (?, ?, ?, ?)')
      .run(hashHex(id), client.client_id, JSON.stringify({ ...params, resource: params.resource?.href, attempts: 0 }), this.now() + PENDING_TTL_MS);
    this.o.db.prepare('DELETE FROM oauth_pending WHERE expires_at < ?').run(this.now());
    sendConsentPage(res, { requestId: id, client, redirectUri: params.redirectUri });
    return Promise.resolve();
  }

  /**
   * POST /oauth/consent. Returns where to redirect, or a page to show again.
   * Wrong passwords count per request and globally (lockout).
   */
  handleConsent(body: { request_id?: unknown; password?: unknown; decision?: unknown }): { redirect: string } | { status: number; page: { requestId: string; client: OAuthClientInformationFull; redirectUri: string; error: string } } | { status: number; text: string } {
    const now = this.now();
    this.failures = this.failures.filter((t) => now - t < GLOBAL_LOCK_MS);
    if (this.failures.length >= GLOBAL_FAILURE_LIMIT) return { status: 429, text: 'Too many failed attempts. Try again later.' };

    const requestId = typeof body.request_id === 'string' ? body.request_id : '';
    const row = this.o.db.prepare('SELECT client_id, params, expires_at FROM oauth_pending WHERE id_hash = ?').get(hashHex(requestId)) as
      | { client_id: string; params: string; expires_at: number }
      | undefined;
    if (!row || row.expires_at < now) return { status: 400, text: 'This authorization request expired. Start the connection again from Claude.' };
    const params = JSON.parse(row.params) as { redirectUri: string; state?: string; codeChallenge: string; scopes?: string[]; resource?: string; attempts: number };
    const client = this.clientsStore.getClient(row.client_id) as OAuthClientInformationFull | undefined;
    if (!client) return { status: 400, text: 'Unknown client.' };

    const redirect = (q: Record<string, string>) => {
      const u = new URL(params.redirectUri);
      for (const [k, v] of Object.entries(q)) u.searchParams.set(k, v);
      if (params.state !== undefined) u.searchParams.set('state', params.state);
      return u.href;
    };

    if (body.decision !== 'approve') {
      this.o.db.prepare('DELETE FROM oauth_pending WHERE id_hash = ?').run(hashHex(requestId));
      return { redirect: redirect({ error: 'access_denied', error_description: 'The owner denied access' }) };
    }
    const password = typeof body.password === 'string' ? body.password : '';
    if (!safeEqual(password, this.o.ownerPassword ?? newSecret())) {
      this.failures.push(now);
      const attempts = params.attempts + 1;
      this.log.warn({ clientId: client.client_id, attempts }, 'oauth consent: wrong password');
      if (attempts >= MAX_ATTEMPTS_PER_REQUEST) {
        this.o.db.prepare('DELETE FROM oauth_pending WHERE id_hash = ?').run(hashHex(requestId));
        return { status: 403, text: 'Too many wrong passwords for this request.' };
      }
      this.o.db.prepare('UPDATE oauth_pending SET params = ? WHERE id_hash = ?').run(JSON.stringify({ ...params, attempts }), hashHex(requestId));
      return { status: 401, page: { requestId, client, redirectUri: params.redirectUri, error: 'Wrong password' } };
    }

    this.o.db.prepare('DELETE FROM oauth_pending WHERE id_hash = ?').run(hashHex(requestId));
    const code = newSecret();
    this.o.db
      .prepare('INSERT INTO oauth_codes (code_hash, client_id, code_challenge, redirect_uri, resource, scopes, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(hashHex(code), client.client_id, params.codeChallenge, params.redirectUri, params.resource ?? this.o.resourceUrl.href, SCOPE, now + CODE_TTL_MS);
    this.log.info({ clientId: client.client_id }, 'oauth consent approved');
    return { redirect: redirect({ code }) };
  }

  // ------------------------------------------------------------------ codes and tokens

  challengeForAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string): Promise<string> {
    const row = this.code(client, authorizationCode);
    return Promise.resolve(row.code_challenge);
  }

  exchangeAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string, _codeVerifier?: string, redirectUri?: string, resource?: URL): Promise<OAuthTokens> {
    // PKCE was already verified by the SDK token handler against challengeForAuthorizationCode.
    const row = this.code(client, authorizationCode);
    // single use: delete before issuing
    this.o.db.prepare('DELETE FROM oauth_codes WHERE code_hash = ?').run(hashHex(authorizationCode));
    if (redirectUri !== undefined && redirectUri !== row.redirect_uri) throw new InvalidGrantError('redirect_uri mismatch');
    if (resource && !sameResource(resource.href, this.o.resourceUrl)) throw new InvalidTargetError('resource mismatch');
    return Promise.resolve(this.issue(client.client_id, row.resource ?? this.o.resourceUrl.href));
  }

  exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string, _scopes?: string[], resource?: URL): Promise<OAuthTokens> {
    const h = hashHex(refreshToken);
    const row = this.o.db.prepare("SELECT client_id, resource, expires_at FROM oauth_tokens WHERE token_hash = ? AND kind = 'refresh'").get(h) as
      | { client_id: string; resource: string | null; expires_at: number }
      | undefined;
    if (!row || row.client_id !== client.client_id || row.expires_at < this.now() / 1000) throw new InvalidGrantError('invalid refresh token');
    if (resource && !sameResource(resource.href, this.o.resourceUrl)) throw new InvalidTargetError('resource mismatch');
    // rotation: the old refresh token dies with this exchange
    this.o.db.prepare('DELETE FROM oauth_tokens WHERE token_hash = ?').run(h);
    return Promise.resolve(this.issue(client.client_id, row.resource ?? this.o.resourceUrl.href));
  }

  verifyAccessToken(token: string): Promise<AuthInfo> {
    const nowS = Math.floor(this.now() / 1000);
    if (this.o.staticToken !== undefined && safeEqual(token, this.o.staticToken)) {
      return Promise.resolve({ token, clientId: 'static-token', scopes: [SCOPE], expiresAt: nowS + ACCESS_TTL_S, resource: this.o.resourceUrl });
    }
    const row = this.o.db.prepare("SELECT client_id, scopes, resource, expires_at FROM oauth_tokens WHERE token_hash = ? AND kind = 'access'").get(hashHex(token)) as
      | { client_id: string; scopes: string; resource: string | null; expires_at: number }
      | undefined;
    if (!row || row.expires_at < nowS) return Promise.reject(new InvalidTokenError('invalid or expired token'));
    this.o.db.prepare('UPDATE oauth_clients SET last_used_at = ? WHERE client_id = ?').run(this.now(), row.client_id);
    return Promise.resolve({
      token,
      clientId: row.client_id,
      scopes: row.scopes.split(' '),
      expiresAt: row.expires_at,
      resource: new URL(row.resource ?? this.o.resourceUrl.href),
    });
  }

  revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    this.o.db.prepare('DELETE FROM oauth_tokens WHERE token_hash = ? AND client_id = ?').run(hashHex(request.token), client.client_id);
    return Promise.resolve();
  }

  private code(client: OAuthClientInformationFull, code: string) {
    const row = this.o.db.prepare('SELECT client_id, code_challenge, redirect_uri, resource, expires_at FROM oauth_codes WHERE code_hash = ?').get(hashHex(code)) as
      | { client_id: string; code_challenge: string; redirect_uri: string; resource: string | null; expires_at: number }
      | undefined;
    if (!row || row.client_id !== client.client_id || row.expires_at < this.now()) throw new InvalidGrantError('invalid or expired authorization code');
    return row;
  }

  private issue(clientId: string, resource: string): OAuthTokens {
    const nowS = Math.floor(this.now() / 1000);
    const access = newSecret();
    const refresh = newSecret();
    const ins = this.o.db.prepare('INSERT INTO oauth_tokens (token_hash, kind, client_id, scopes, resource, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
    this.o.db.transaction(() => {
      ins.run(hashHex(access), 'access', clientId, SCOPE, resource, nowS + ACCESS_TTL_S, nowS);
      ins.run(hashHex(refresh), 'refresh', clientId, SCOPE, resource, nowS + REFRESH_TTL_S, nowS);
      this.o.db.prepare('DELETE FROM oauth_tokens WHERE expires_at < ?').run(nowS);
    })();
    return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL_S, refresh_token: refresh, scope: SCOPE };
  }
}

export function sendConsentPage(
  res: Response,
  p: { requestId: string; client: OAuthClientInformationFull; redirectUri: string; error?: string },
  status = 200,
): void {
  const host = (() => {
    try {
      return new URL(p.redirectUri).host;
    } catch {
      return p.redirectUri;
    }
  })();
  const name = p.client.client_name ?? 'An MCP client';
  res
    .status(status)
    .set({
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Cache-Control': 'no-store',
    })
    .type('html')
    .send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Authorize ctrader-mcp</title>
<style>body{font-family:system-ui,sans-serif;max-width:28rem;margin:3rem auto;padding:0 1rem;color:#222}
.box{border:1px solid #ccc;border-radius:8px;padding:1.25rem}.warn{color:#a00}code{background:#f3f3f3;padding:0 .25rem}
input{width:100%;padding:.5rem;margin:.5rem 0 1rem;box-sizing:border-box}button{padding:.5rem 1rem;margin-right:.5rem}</style></head>
<body><div class="box"><h2>Authorize trading access</h2>
<p><strong>${esc(name)}</strong> wants to use <strong>ctrader-mcp</strong>: read the demo account and place, amend and close orders (risk limits enforced by the server).</p>
<p>After approval you will be sent to <code>${esc(host)}</code>. Only continue if you started this connection yourself.</p>
${p.error ? `<p class="warn">${esc(p.error)}</p>` : ''}
<form method="post" action="/oauth/consent">
<input type="hidden" name="request_id" value="${esc(p.requestId)}">
<label for="pw">Owner password</label><input id="pw" type="password" name="password" autocomplete="current-password" autofocus>
<button type="submit" name="decision" value="approve">Approve</button><button type="submit" name="decision" value="deny">Deny</button>
</form></div></body></html>`);
}
