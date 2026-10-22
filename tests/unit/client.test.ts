import { afterEach, describe, expect, it, vi } from 'vitest';
import { CTraderClient, computeBackoff, expiresAtFrom, selectDemoAccount } from '../../src/ctrader/client.js';
import { CTraderApiError, CTraderDisconnectedError, CTraderTimeoutError, LiveAccountError } from '../../src/ctrader/errors.js';
import { PT } from '../../src/ctrader/payloadTypes.js';
import { FakeBroker, MemoryTokens, position, silentLogger } from '../helpers/fakeBroker.js';

const clients: CTraderClient[] = [];

function makeClient(broker: FakeBroker, tokens = new MemoryTokens(), extra: Partial<ConstructorParameters<typeof CTraderClient>[0]> = {}) {
  const client = new CTraderClient({
    clientId: 'cid',
    clientSecret: 'secret',
    transportFactory: broker.transportFactory,
    tokens,
    logger: silentLogger,
    requestTimeoutMs: 200,
    heartbeatIntervalMs: 20,
    reconcileIntervalMs: 60_000,
    backoff: { baseMs: 5, maxMs: 20 },
    ...extra,
  });
  clients.push(client);
  return { client, tokens };
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.stop()));
});

describe('auth flow', () => {
  it('runs app auth -> account list -> account auth -> trader -> reconcile in order', async () => {
    const broker = new FakeBroker();
    broker.positions = [position(7)];
    const { client } = makeClient(broker);
    await client.start();

    expect(client.status).toBe('ready');
    expect(client.accountId).toBe(1001);
    expect(broker.sent.map((m) => m.payloadType)).toEqual([
      PT.APPLICATION_AUTH_REQ,
      PT.GET_ACCOUNTS_BY_ACCESS_TOKEN_REQ,
      PT.ACCOUNT_AUTH_REQ,
      PT.TRADER_REQ,
      PT.RECONCILE_REQ,
    ]);
    expect(client.trader?.depositAssetId).toBe(15);
    expect(client.state.getPositions().map((p) => p.positionId)).toEqual([7]);
    // every request carries a unique clientMsgId
    const ids = broker.sent.map((m) => m.clientMsgId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('sends heartbeats every interval once ready', async () => {
    const broker = new FakeBroker();
    const { client } = makeClient(broker);
    await client.start();
    await vi.waitFor(() => expect(broker.count(PT.HEARTBEAT_EVENT)).toBeGreaterThanOrEqual(2), { timeout: 500 });
  });
});

describe('demo-only guard', () => {
  it('aborts with a fatal error when the configured account is live', async () => {
    const broker = new FakeBroker();
    broker.accounts = [{ ctidTraderAccountId: 2002, isLive: true, traderLogin: 1 }];
    const { client } = makeClient(broker, undefined, { accountId: 2002 });
    const fatal = vi.fn();
    client.on('fatal', fatal);
    await expect(client.start()).rejects.toBeInstanceOf(LiveAccountError);
    expect(client.status).toBe('fatal');
    expect(fatal).toHaveBeenCalledOnce();
    expect(broker.count(PT.ACCOUNT_AUTH_REQ)).toBe(0); // never authorised the live account
  });

  it('selectDemoAccount: accepts explicit demo, rejects live/unknown/missing flag', () => {
    const accs = [
      { ctidTraderAccountId: 1, isLive: false },
      { ctidTraderAccountId: 2, isLive: true },
      { ctidTraderAccountId: 3 },
    ];
    expect(selectDemoAccount(accs, 1)).toBe(1);
    expect(() => selectDemoAccount(accs, 2)).toThrow(LiveAccountError);
    expect(() => selectDemoAccount(accs, 3)).toThrow(LiveAccountError);
    expect(() => selectDemoAccount(accs, 99)).toThrow(/not available/);
  });

  it('selectDemoAccount: auto-selects only when exactly one demo account exists', () => {
    expect(selectDemoAccount([{ ctidTraderAccountId: 1, isLive: false }, { ctidTraderAccountId: 2, isLive: true }], undefined)).toBe(1);
    expect(() =>
      selectDemoAccount([{ ctidTraderAccountId: 1, isLive: false }, { ctidTraderAccountId: 2, isLive: false }], undefined),
    ).toThrow(/Set CTRADER_ACCOUNT_ID/);
  });
});

describe('token refresh', () => {
  it('refreshes once on CH_ACCESS_TOKEN_INVALID, persists the new pair and retries', async () => {
    const broker = new FakeBroker();
    broker.validAccessTokens = new Set(['AT_OTHER']); // AT1 is expired
    broker.validRefreshTokens = new Map([['RT1', { accessToken: 'AT2', refreshToken: 'RT2' }]]);
    const tokens = new MemoryTokens();
    const { client } = makeClient(broker, tokens);
    const refreshed = vi.fn();
    client.on('tokenRefreshed', refreshed);
    await client.start();

    expect(broker.count(PT.REFRESH_TOKEN_REQ)).toBe(1);
    expect(tokens.saved).toHaveLength(1);
    expect(tokens.saved[0]).toMatchObject({ accessToken: 'AT2', refreshToken: 'RT2' });
    expect(tokens.saved[0]!.expiresAt).toBeGreaterThan(Date.now());
    expect(refreshed).toHaveBeenCalledOnce();
    const accountAuth = broker.sent.filter((m) => m.payloadType === PT.ACCOUNT_AUTH_REQ).at(-1);
    expect((accountAuth?.payload as { accessToken: string }).accessToken).toBe('AT2');
  });

  it('does not loop when the refreshed token is also rejected', async () => {
    const broker = new FakeBroker();
    broker.validAccessTokens = new Set(['NOPE']);
    // refresh "succeeds" but hands back a token the account auth still rejects
    broker.handlers.push((m, reply) => {
      if (m.payloadType !== PT.REFRESH_TOKEN_REQ) return false;
      reply(PT.REFRESH_TOKEN_RES, { accessToken: 'BAD', refreshToken: 'RT9', tokenType: 'bearer', expiresIn: 10 });
      return true;
    });
    const { client } = makeClient(broker, undefined, { backoff: { baseMs: 10_000, maxMs: 10_000 } });
    void client.start().catch(() => undefined);
    await vi.waitFor(() => expect(client.lastError).toMatch(/CH_ACCESS_TOKEN_INVALID/), { timeout: 1000 });
    expect(broker.count(PT.REFRESH_TOKEN_REQ)).toBe(1);
    expect(broker.count(PT.GET_ACCOUNTS_BY_ACCESS_TOKEN_REQ)).toBe(2);
  });

  it('handles ProtoOAAccountsTokenInvalidatedEvent by refreshing and re-authorising', async () => {
    const broker = new FakeBroker();
    const tokens = new MemoryTokens();
    const { client } = makeClient(broker, tokens);
    await client.start();
    broker.push(PT.ACCOUNTS_TOKEN_INVALIDATED_EVENT, { ctidTraderAccountIds: [1001], reason: 'expired' });
    await vi.waitFor(() => expect(broker.count(PT.ACCOUNT_AUTH_REQ)).toBe(2));
    expect(tokens.saved.at(-1)?.accessToken).toBe('AT2');
  });

  it('expiresAtFrom accepts seconds and unix-ms', () => {
    expect(expiresAtFrom(2628000, 1_000)).toBe(1_000 + 2628000 * 1000);
    expect(expiresAtFrom(1_900_000_000_000, 1_000)).toBe(1_900_000_000_000);
    expect(expiresAtFrom(0)).toBeUndefined();
  });
});

describe('request correlation and errors', () => {
  it('matches responses by clientMsgId even when out of order', async () => {
    const broker = new FakeBroker();
    const held: Array<() => void> = [];
    broker.handlers.push((m, reply) => {
      if (m.payloadType !== PT.ASSET_LIST_REQ) return false;
      const tag = (m.payload as { tag: number }).tag;
      held.push(() => reply(PT.ASSET_LIST_RES, { asset: [{ assetId: tag, name: `A${tag}` }] }));
      if (held.length === 2) {
        held[1]!();
        held[0]!();
      }
      return true;
    });
    const { client } = makeClient(broker);
    await client.start();
    const [a, b] = await Promise.all([
      client.request(PT.ASSET_LIST_REQ, { tag: 1 }, PT.ASSET_LIST_RES),
      client.request(PT.ASSET_LIST_REQ, { tag: 2 }, PT.ASSET_LIST_RES),
    ]);
    expect((a.payload as { asset: Array<{ assetId: number }> }).asset[0]!.assetId).toBe(1);
    expect((b.payload as { asset: Array<{ assetId: number }> }).asset[0]!.assetId).toBe(2);
  });

  it('rejects with a typed CTraderApiError on ProtoOAErrorRes and ProtoErrorRes', async () => {
    const broker = new FakeBroker();
    broker.handlers.push((m, reply) => {
      if (m.payloadType === PT.SYMBOLS_LIST_REQ) reply(PT.OA_ERROR_RES, { errorCode: 'SYMBOL_NOT_FOUND', description: 'x', retryAfter: 3 });
      else if (m.payloadType === PT.ASSET_LIST_REQ) reply(PT.ERROR_RES, { errorCode: 'UNKNOWN_ERROR' });
      else return false;
      return true;
    });
    const { client } = makeClient(broker);
    await client.start();
    const e1 = await client.request(PT.SYMBOLS_LIST_REQ, {}, PT.SYMBOLS_LIST_RES).catch((e: unknown) => e);
    expect(e1).toBeInstanceOf(CTraderApiError);
    expect(e1).toMatchObject({ source: 'ProtoOAErrorRes', errorCode: 'SYMBOL_NOT_FOUND', extra: { retryAfter: 3 } });
    const e2 = await client.request(PT.ASSET_LIST_REQ, {}, PT.ASSET_LIST_RES).catch((e: unknown) => e);
    expect(e2).toMatchObject({ source: 'ProtoErrorRes', errorCode: 'UNKNOWN_ERROR' });
  });

  it('rejects order requests with ProtoOAOrderErrorEvent', async () => {
    const broker = new FakeBroker();
    broker.handlers.push((m, reply) => {
      if (m.payloadType !== PT.NEW_ORDER_REQ) return false;
      reply(PT.ORDER_ERROR_EVENT, { ctidTraderAccountId: 1001, errorCode: 'TRADING_BAD_VOLUME', description: 'bad' });
      return true;
    });
    const { client } = makeClient(broker);
    await client.start();
    await expect(client.request(PT.NEW_ORDER_REQ, {}, PT.EXECUTION_EVENT)).rejects.toMatchObject({
      source: 'ProtoOAOrderErrorEvent',
      errorCode: 'TRADING_BAD_VOLUME',
    });
  });

  it('times out unanswered requests with CTraderTimeoutError', async () => {
    const broker = new FakeBroker();
    const { client } = makeClient(broker);
    await client.start();
    await expect(client.request(PT.DEAL_LIST_REQ, {}, PT.DEAL_LIST_RES, { timeoutMs: 30 })).rejects.toBeInstanceOf(CTraderTimeoutError);
  });

  it('refuses requests while not ready', async () => {
    const broker = new FakeBroker();
    const { client } = makeClient(broker);
    await expect(client.request(PT.ASSET_LIST_REQ, {}, PT.ASSET_LIST_RES)).rejects.toBeInstanceOf(CTraderDisconnectedError);
  });

  it('validates response payloads with zod', async () => {
    const broker = new FakeBroker();
    broker.handlers.push((m, reply) => {
      if (m.payloadType !== PT.TRADER_REQ || broker.count(PT.TRADER_REQ) < 2) return false;
      reply(PT.TRADER_RES, { ctidTraderAccountId: 1001, trader: { balance: 'not-a-number' } });
      return true;
    });
    const { client } = makeClient(broker);
    await client.start();
    await expect(client.refreshTrader()).rejects.toThrow(/Invalid response to 2121/);
  });
});

describe('reconnection', () => {
  it('rejects in-flight requests, reconnects, re-authenticates and reconciles after a drop', async () => {
    const broker = new FakeBroker();
    const { client } = makeClient(broker);
    await client.start();
    const disconnected = vi.fn();
    client.on('disconnected', disconnected);

    const inflight = client.request(PT.DEAL_LIST_REQ, {}, PT.DEAL_LIST_RES, { timeoutMs: 5_000 });
    broker.positions = [position(42)];
    const readyAgain = new Promise((r) => client.once('ready', r));
    client.dropConnection();

    await expect(inflight).rejects.toBeInstanceOf(CTraderDisconnectedError);
    await readyAgain;
    expect(disconnected).toHaveBeenCalledOnce();
    expect(broker.connections).toHaveLength(2);
    expect(broker.count(PT.APPLICATION_AUTH_REQ)).toBe(2);
    expect(broker.count(PT.ACCOUNT_AUTH_REQ)).toBe(2);
    expect(client.state.getPositions().map((p) => p.positionId)).toEqual([42]);
    expect(client.status).toBe('ready');
  });

  it('retries with backoff when the connection is refused', async () => {
    const broker = new FakeBroker();
    broker.refuseConnections = 3;
    const { client } = makeClient(broker);
    await client.start();
    expect(client.status).toBe('ready');
    expect(broker.connections).toHaveLength(1);
  });

  it('re-subscribes spots after reconnecting', async () => {
    const broker = new FakeBroker();
    const { client } = makeClient(broker);
    await client.start();
    await client.subscribeSpots([1, 2]);
    const readyAgain = new Promise((r) => client.once('ready', r));
    client.dropConnection();
    await readyAgain;
    const subs = broker.sent.filter((m) => m.payloadType === PT.SUBSCRIBE_SPOTS_REQ);
    expect(subs).toHaveLength(2);
    expect((subs[1]!.payload as { symbolId: number[] }).symbolId).toEqual([1, 2]);
  });

  it('does not reconnect after stop()', async () => {
    const broker = new FakeBroker();
    const { client } = makeClient(broker);
    await client.start();
    await client.stop();
    await new Promise((r) => setTimeout(r, 50));
    expect(broker.connections).toHaveLength(1);
    expect(client.status).toBe('stopped');
  });

  it('computeBackoff grows exponentially, is capped and jittered', () => {
    expect(computeBackoff(0, 1000, 60_000, () => 0)).toBe(500);
    expect(computeBackoff(0, 1000, 60_000, () => 1)).toBe(1000);
    expect(computeBackoff(3, 1000, 60_000, () => 1)).toBe(8000);
    expect(computeBackoff(20, 1000, 60_000, () => 1)).toBe(60_000);
    expect(computeBackoff(20, 1000, 60_000, () => 0)).toBe(30_000);
  });
});

describe('execution events and reconcile', () => {
  it('applies execution events to in-memory state', async () => {
    const broker = new FakeBroker();
    const { client } = makeClient(broker);
    await client.start();
    const seen = vi.fn();
    client.on('execution', seen);
    broker.push(PT.EXECUTION_EVENT, { ctidTraderAccountId: 1001, executionType: 3, position: position(9) });
    await vi.waitFor(() => expect(client.state.getPosition(9)).toBeDefined());
    broker.push(PT.EXECUTION_EVENT, { ctidTraderAccountId: 1001, executionType: 3, position: position(9, 1, 2) });
    await vi.waitFor(() => expect(client.state.getPosition(9)).toBeUndefined());
    expect(seen).toHaveBeenCalledTimes(2);
  });

  it('periodic reconcile corrects drift', async () => {
    const broker = new FakeBroker();
    const { client } = makeClient(broker, undefined, { reconcileIntervalMs: 30 });
    await client.start();
    broker.positions = [position(5)];
    await vi.waitFor(() => expect(client.state.getPosition(5)).toBeDefined(), { timeout: 500 });
  });
});
