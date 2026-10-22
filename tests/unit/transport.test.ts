import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { CTraderClient } from '../../src/ctrader/client.js';
import { PT } from '../../src/ctrader/payloadTypes.js';
import type { Envelope } from '../../src/ctrader/schemas.js';
import { JsonWsTransport } from '../../src/ctrader/transport.js';
import { MemoryTokens, silentLogger } from '../helpers/fakeBroker.js';

let server: WebSocketServer | undefined;

afterEach(async () => {
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = undefined;
});

/** Minimal JSON broker over a real WebSocket, to exercise JsonWsTransport end to end. */
async function startServer(onMsg: (m: Envelope, send: (e: Envelope) => void) => void): Promise<string> {
  server = new WebSocketServer({ port: 0 });
  server.on('connection', (ws) => {
    ws.on('message', (raw) => {
      const m = JSON.parse((raw as Buffer).toString('utf8')) as Envelope;
      onMsg(m, (e) => ws.send(JSON.stringify(e)));
    });
  });
  await new Promise((r) => server!.once('listening', r));
  return `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe('JsonWsTransport', () => {
  it('sends/receives JSON envelopes and drives a full client auth over a real socket', async () => {
    const url = await startServer((m, send) => {
      const reply = (payloadType: number, payload: object) => send({ payloadType, payload, clientMsgId: m.clientMsgId });
      const p = m.payload as Record<string, unknown>;
      switch (m.payloadType) {
        case PT.APPLICATION_AUTH_REQ:
          return reply(PT.APPLICATION_AUTH_RES, {});
        case PT.GET_ACCOUNTS_BY_ACCESS_TOKEN_REQ:
          // int64 as strings + enum-free payload: proves the JSON parsing path
          return reply(PT.GET_ACCOUNTS_BY_ACCESS_TOKEN_RES, { accessToken: 'x', ctidTraderAccount: [{ ctidTraderAccountId: '77', isLive: false }] });
        case PT.ACCOUNT_AUTH_REQ:
          return reply(PT.ACCOUNT_AUTH_RES, { ctidTraderAccountId: p.ctidTraderAccountId as number });
        case PT.TRADER_REQ:
          return reply(PT.TRADER_RES, { ctidTraderAccountId: 77, trader: { ctidTraderAccountId: 77, balance: '100000', depositAssetId: 15, moneyDigits: 2 } });
        case PT.RECONCILE_REQ:
          return reply(PT.RECONCILE_RES, { ctidTraderAccountId: 77 });
      }
    });

    const client = new CTraderClient({
      clientId: 'id',
      clientSecret: 's',
      transportFactory: () => new JsonWsTransport({ url }),
      tokens: new MemoryTokens(),
      logger: silentLogger,
      heartbeatIntervalMs: 60_000,
    });
    await client.start();
    expect(client.accountId).toBe(77);
    expect(client.trader?.balance).toBe(100000);

    // Server-side close -> client goes to reconnecting and comes back.
    const back = new Promise((r) => client.once('ready', r));
    for (const ws of server!.clients) ws.terminate();
    await back;
    expect(client.status).toBe('ready');
    await client.stop();
  });

  it('rejects connect() when nothing listens', async () => {
    const t = new JsonWsTransport({ url: 'ws://127.0.0.1:1', connectTimeoutMs: 500 });
    t.on('close', () => undefined);
    await expect(t.connect()).rejects.toThrow();
  });
});
