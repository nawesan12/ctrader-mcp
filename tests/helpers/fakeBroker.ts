import { EventEmitter } from 'node:events';
import { pino } from 'pino';
import type { TokenPair } from '../../src/db/tokenStore.js';
import { PT } from '../../src/ctrader/payloadTypes.js';
import type { Envelope } from '../../src/ctrader/schemas.js';
import type { Transport } from '../../src/ctrader/transport.js';

export const silentLogger = pino({ level: 'silent' });

type Handler = (msg: Envelope, reply: (payloadType: number, payload: object) => void) => boolean | void;

/** In-memory transport wired to a FakeBroker. */
export class FakeTransport extends EventEmitter implements Transport {
  isOpen = false;
  constructor(private readonly broker: FakeBroker) {
    super();
  }
  connect(): Promise<void> {
    if (this.broker.refuseConnections > 0) {
      this.broker.refuseConnections--;
      return Promise.reject(new Error('ECONNREFUSED'));
    }
    this.isOpen = true;
    this.broker.connections.push(this);
    return Promise.resolve();
  }
  send(message: Envelope): void {
    if (!this.isOpen) throw new Error('not open');
    this.broker.sent.push(message);
    queueMicrotask(() => this.broker.handle(message, this));
  }
  close(): void {
    if (!this.isOpen) return;
    this.isOpen = false;
    queueMicrotask(() => this.emit('close', 'closed'));
  }
  deliver(message: Envelope): void {
    if (this.isOpen) this.emit('message', message);
  }
}

export class FakeBroker {
  sent: Envelope[] = [];
  connections: FakeTransport[] = [];
  refuseConnections = 0;
  validAccessTokens = new Set(['AT1']);
  validRefreshTokens = new Map([['RT1', { accessToken: 'AT2', refreshToken: 'RT2' }]]);
  accounts = [{ ctidTraderAccountId: 1001, isLive: false, traderLogin: 5001 }];
  positions: object[] = [];
  orders: object[] = [];
  /** Custom handlers run first; return true to mark the message as handled. */
  handlers: Handler[] = [];

  transportFactory = () => new FakeTransport(this);

  get current(): FakeTransport | undefined {
    return this.connections.at(-1);
  }

  count(payloadType: number): number {
    return this.sent.filter((m) => m.payloadType === payloadType).length;
  }

  push(payloadType: number, payload: object): void {
    this.current?.deliver({ payloadType, payload });
  }

  handle(msg: Envelope, t: FakeTransport): void {
    const reply = (payloadType: number, payload: object) => t.deliver({ payloadType, payload, clientMsgId: msg.clientMsgId });
    for (const h of this.handlers) if (h(msg, reply)) return;
    const p = (msg.payload ?? {}) as Record<string, unknown>;
    const tokenError = () => reply(PT.OA_ERROR_RES, { errorCode: 'CH_ACCESS_TOKEN_INVALID', description: 'Access token is invalid' });
    switch (msg.payloadType) {
      case PT.HEARTBEAT_EVENT:
        return;
      case PT.APPLICATION_AUTH_REQ:
        return reply(PT.APPLICATION_AUTH_RES, {});
      case PT.GET_ACCOUNTS_BY_ACCESS_TOKEN_REQ:
        if (!this.validAccessTokens.has(p.accessToken as string)) return tokenError();
        return reply(PT.GET_ACCOUNTS_BY_ACCESS_TOKEN_RES, { accessToken: p.accessToken as string, ctidTraderAccount: this.accounts });
      case PT.ACCOUNT_AUTH_REQ:
        if (!this.validAccessTokens.has(p.accessToken as string)) return tokenError();
        return reply(PT.ACCOUNT_AUTH_RES, { ctidTraderAccountId: p.ctidTraderAccountId as number });
      case PT.REFRESH_TOKEN_REQ: {
        const next = this.validRefreshTokens.get(p.refreshToken as string);
        if (!next) return reply(PT.OA_ERROR_RES, { errorCode: 'CH_ACCESS_TOKEN_INVALID' });
        this.validRefreshTokens.delete(p.refreshToken as string);
        this.validAccessTokens.clear();
        this.validAccessTokens.add(next.accessToken);
        return reply(PT.REFRESH_TOKEN_RES, { ...next, tokenType: 'bearer', expiresIn: 2628000 });
      }
      case PT.TRADER_REQ:
        return reply(PT.TRADER_RES, {
          ctidTraderAccountId: p.ctidTraderAccountId as number,
          trader: { ctidTraderAccountId: p.ctidTraderAccountId as number, balance: 1000000, depositAssetId: 15, moneyDigits: 2 },
        });
      case PT.RECONCILE_REQ:
        return reply(PT.RECONCILE_RES, { ctidTraderAccountId: p.ctidTraderAccountId as number, position: this.positions, order: this.orders });
      case PT.SUBSCRIBE_SPOTS_REQ:
        return reply(PT.SUBSCRIBE_SPOTS_RES, { ctidTraderAccountId: p.ctidTraderAccountId as number });
      default:
        return; // unanswered -> request times out
    }
  }
}

export class MemoryTokens {
  saved: TokenPair[] = [];
  constructor(private pair: TokenPair | undefined = { accessToken: 'AT1', refreshToken: 'RT1' }) {}
  load(): TokenPair | undefined {
    return this.pair;
  }
  save(pair: TokenPair): void {
    this.pair = pair;
    this.saved.push(pair);
  }
}

export function position(id: number, symbolId = 1, status = 1) {
  return {
    positionId: id,
    tradeData: { symbolId, volume: 100000, tradeSide: 1, openTimestamp: 1_700_000_000_000 },
    positionStatus: status,
    swap: 0,
    price: 1.1,
    stopLoss: 1.09,
    takeProfit: 1.12,
    moneyDigits: 2,
  };
}
