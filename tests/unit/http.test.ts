/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment --
   HTTP bodies are untyped JSON. */
import { createHash, randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assertAuthConfig, createHttpApp, listen, type HttpConfig } from '../../src/http/server.js';
import { isAllowedRedirect } from '../../src/http/oauth.js';
import { silentLogger } from '../helpers/fakeBroker.js';
import { harness, type Harness } from '../helpers/harness.js';

const STATIC = 's'.repeat(40);
const PASSWORD = 'correct horse battery staple';
const PUBLIC = 'http://localhost:8787';
const CLAUDE_CB = 'https://claude.ai/api/mcp/auth_callback';

const baseConfig: HttpConfig = {
  MCP_AUTH_TOKEN: STATIC,
  OAUTH_OWNER_PASSWORD: PASSWORD,
  PUBLIC_URL: PUBLIC,
  OAUTH_EXTRA_REDIRECT_URIS: [],
  TRUST_PROXY: false,
  MCP_ALLOWED_ORIGINS: [],
  RATE_LIMIT_PER_MIN: 1000,
  PORT: 8787,
};

let h: Harness;
beforeEach(async () => {
  h = await harness();
});
afterEach(async () => {
  await h.close();
});

const make = (over: Partial<HttpConfig> = {}) => createHttpApp({ app: h.app, db: h.db, config: { ...baseConfig, ...over }, logger: silentLogger, version: '0.0.0-test' }).http;
const rpc = (method: string, params: object = {}, id = 1) => ({ jsonrpc: '2.0', id, method, params });
const ACCEPT = 'application/json, text/event-stream';

describe('config guard', () => {
  it('refuses to start without any auth, and OAuth without PUBLIC_URL', () => {
    expect(() => assertAuthConfig({ ...baseConfig, MCP_AUTH_TOKEN: undefined, OAUTH_OWNER_PASSWORD: undefined })).toThrow(/No authentication/);
    expect(() => assertAuthConfig({ ...baseConfig, PUBLIC_URL: undefined })).toThrow(/PUBLIC_URL/);
  });
});

describe('health', () => {
  it('needs no auth and exposes no secrets', async () => {
    const r = await request(make()).get('/health');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: 'ok', ctrader: 'ready', version: '0.0.0-test' });
    expect(r.body.lastReconcileAt).toMatch(/^\d{4}-/);
    expect(JSON.stringify(r.body)).not.toMatch(new RegExp(`${STATIC}|${PASSWORD}`));
  });
});

describe('/mcp protection', () => {
  it('401 without token, with a resource_metadata pointer for OAuth discovery', async () => {
    const r = await request(make()).post('/mcp').set('Accept', ACCEPT).send(rpc('tools/list'));
    expect(r.status).toBe(401);
    expect(r.headers['www-authenticate']).toContain(`resource_metadata="${PUBLIC}/.well-known/oauth-protected-resource/mcp"`);
  });

  it('401 with a wrong token (same length too)', async () => {
    const app = make();
    expect((await request(app).post('/mcp').set('Authorization', 'Bearer nope').send(rpc('tools/list'))).status).toBe(401);
    expect((await request(app).post('/mcp').set('Authorization', `Bearer ${'x'.repeat(40)}`).send(rpc('tools/list'))).status).toBe(401);
  });

  it('static bearer works end to end with the real MCP HTTP client', async () => {
    const srv = await listen(make(), 0, '127.0.0.1');
    try {
      const port = (srv.server.address() as AddressInfo).port;
      const client = new Client({ name: 'http-test', version: '1' });
      await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${STATIC}` } } }));
      const { tools } = await client.listTools();
      expect(tools.length).toBe(15);
      const r = (await client.callTool({ name: 'get_account', arguments: {} })) as { content: Array<{ text: string }> };
      expect(JSON.parse(r.content[0]!.text)).toMatchObject({ currency: 'USD', balance: 10_000 });
      await client.close();
    } finally {
      await srv.close();
    }
  });

  it('body over 1 MB -> 413', async () => {
    const big = { ...rpc('tools/list'), pad: 'x'.repeat(1_100_000) };
    const r = await request(make()).post('/mcp').set('Authorization', `Bearer ${STATIC}`).set('Accept', ACCEPT).send(big);
    expect(r.status).toBe(413);
  });

  it('CORS closed: preflight 403 and no Access-Control headers', async () => {
    const app = make();
    const pre = await request(app).options('/mcp').set('Origin', 'https://evil.example').set('Access-Control-Request-Method', 'POST');
    expect(pre.status).toBe(403);
    expect(pre.headers['access-control-allow-origin']).toBeUndefined();
    const post = await request(app).post('/mcp').set('Origin', 'https://evil.example').set('Authorization', `Bearer ${STATIC}`).set('Accept', ACCEPT).send(rpc('tools/list'));
    expect(post.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('Origin allowlist when configured', async () => {
    const app = make({ MCP_ALLOWED_ORIGINS: ['https://claude.ai'] });
    const bad = await request(app).post('/mcp').set('Origin', 'https://evil.example').set('Authorization', `Bearer ${STATIC}`).send(rpc('tools/list'));
    expect(bad.status).toBe(403);
  });

  it('rate limit per IP -> 429', async () => {
    const app = make({ RATE_LIMIT_PER_MIN: 3 });
    const codes: number[] = [];
    for (let i = 0; i < 4; i++) codes.push((await request(app).post('/mcp').send(rpc('tools/list'))).status);
    expect(codes).toEqual([401, 401, 401, 429]);
  });

  it('GET/DELETE are 405 (stateless server)', async () => {
    const app = make();
    expect((await request(app).get('/mcp').set('Authorization', `Bearer ${STATIC}`)).status).toBe(405);
    expect((await request(app).delete('/mcp').set('Authorization', `Bearer ${STATIC}`)).status).toBe(405);
  });
});

describe('OAuth for claude.ai custom connectors', () => {
  const pkce = () => {
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    return { verifier, challenge };
  };

  async function register(app: ReturnType<typeof make>, redirect = CLAUDE_CB) {
    return request(app).post('/register').send({ client_name: 'Claude', redirect_uris: [redirect], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] });
  }

  async function authorizeAndConsent(app: ReturnType<typeof make>, clientId: string, challenge: string, password = PASSWORD) {
    const auth = await request(app)
      .get('/authorize')
      .query({ response_type: 'code', client_id: clientId, redirect_uri: CLAUDE_CB, code_challenge: challenge, code_challenge_method: 'S256', state: 'xyz', resource: `${PUBLIC}/mcp` });
    expect(auth.status).toBe(200);
    expect(auth.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(auth.text).toContain('claude.ai');
    const requestId = /name="request_id" value="([^"]+)"/.exec(auth.text)![1]!;
    return request(app).post('/oauth/consent').type('form').send({ request_id: requestId, password, decision: 'approve' });
  }

  it('publishes discovery metadata', async () => {
    const app = make();
    const pr = await request(app).get('/.well-known/oauth-protected-resource/mcp');
    expect(pr.body).toMatchObject({ resource: `${PUBLIC}/mcp`, authorization_servers: [`${PUBLIC}/`] });
    const as = await request(app).get('/.well-known/oauth-authorization-server');
    expect(as.body).toMatchObject({ code_challenge_methods_supported: ['S256'], registration_endpoint: `${PUBLIC}/register` });
  });

  it('full flow: register -> authorize -> consent -> token -> call -> refresh (rotated)', async () => {
    const app = make();
    const reg = await register(app);
    expect(reg.status).toBe(201);
    const clientId = reg.body.client_id as string;
    const { verifier, challenge } = pkce();

    const consent = await authorizeAndConsent(app, clientId, challenge);
    expect(consent.status).toBe(302);
    const cb = new URL(consent.headers.location!);
    expect(cb.origin + cb.pathname).toBe(CLAUDE_CB);
    expect(cb.searchParams.get('state')).toBe('xyz');
    const code = cb.searchParams.get('code')!;

    const tok = await request(app).post('/token').type('form').send({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: clientId, redirect_uri: CLAUDE_CB, resource: `${PUBLIC}/mcp` });
    expect(tok.status).toBe(200);
    expect(tok.body).toMatchObject({ token_type: 'Bearer', expires_in: 3600, scope: 'trade' });

    const list = await request(app).post('/mcp').set('Authorization', `Bearer ${tok.body.access_token}`).set('Accept', ACCEPT).send(rpc('tools/list'));
    expect(list.status).toBe(200);
    expect(list.body.result.tools.length).toBe(15);

    // code is single use
    const reuse = await request(app).post('/token').type('form').send({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: clientId });
    expect(reuse.status).toBe(400);
    expect(reuse.body.error).toBe('invalid_grant');

    // refresh rotates
    const ref = await request(app).post('/token').type('form').send({ grant_type: 'refresh_token', refresh_token: tok.body.refresh_token, client_id: clientId });
    expect(ref.status).toBe(200);
    expect(ref.body.refresh_token).not.toBe(tok.body.refresh_token);
    const old = await request(app).post('/token').type('form').send({ grant_type: 'refresh_token', refresh_token: tok.body.refresh_token, client_id: clientId });
    expect(old.body.error).toBe('invalid_grant');

    // tokens are stored hashed
    const stored = h.db.prepare('SELECT token_hash FROM oauth_tokens').all() as Array<{ token_hash: string }>;
    expect(stored.map((s) => s.token_hash)).not.toContain(tok.body.access_token);
  });

  it('wrong PKCE verifier is rejected', async () => {
    const app = make();
    const clientId = (await register(app)).body.client_id as string;
    const { challenge } = pkce();
    const code = new URL((await authorizeAndConsent(app, clientId, challenge)).headers.location!).searchParams.get('code')!;
    const tok = await request(app).post('/token').type('form').send({ grant_type: 'authorization_code', code, code_verifier: pkce().verifier, client_id: clientId });
    expect(tok.status).toBe(400);
    expect(tok.body.error).toBe('invalid_grant');
  });

  it('wrong password re-renders the form (401); deny redirects with access_denied', async () => {
    const app = make();
    const clientId = (await register(app)).body.client_id as string;
    const bad = await authorizeAndConsent(app, clientId, pkce().challenge, 'not the password');
    expect(bad.status).toBe(401);
    expect(bad.text).toContain('Wrong password');

    const auth = await request(app).get('/authorize').query({ response_type: 'code', client_id: clientId, redirect_uri: CLAUDE_CB, code_challenge: pkce().challenge, code_challenge_method: 'S256', state: 's2' });
    const requestId = /name="request_id" value="([^"]+)"/.exec(auth.text)![1]!;
    const deny = await request(app).post('/oauth/consent').type('form').send({ request_id: requestId, decision: 'deny' });
    expect(deny.status).toBe(302);
    expect(new URL(deny.headers.location!).searchParams.get('error')).toBe('access_denied');
  });

  it('only Claude / loopback redirect URIs can register', async () => {
    const app = make();
    expect((await register(app, 'https://evil.example/cb')).status).toBe(400);
    expect((await register(app, 'http://localhost:53682/callback')).status).toBe(201);
    expect(isAllowedRedirect('https://claude.com/api/mcp/auth_callback', [])).toBe(true);
    expect(isAllowedRedirect('http://127.0.0.1:1/callback', [])).toBe(true);
    expect(isAllowedRedirect('http://user:pw@localhost:1/cb', [])).toBe(false);
    expect(isAllowedRedirect('https://localhost/cb', [])).toBe(false);
  });

  it('OAuth endpoints are absent when OAUTH_OWNER_PASSWORD is not set', async () => {
    const app = make({ OAUTH_OWNER_PASSWORD: undefined });
    expect((await request(app).get('/.well-known/oauth-authorization-server')).status).toBe(404);
    const r = await request(app).post('/mcp').send(rpc('tools/list'));
    expect(r.status).toBe(401);
    expect(r.headers['www-authenticate']).not.toContain('resource_metadata');
  });
});
