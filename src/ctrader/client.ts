import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { z } from 'zod';
import type { Logger } from '../logger.js';
import type { TokenPair } from '../db/tokenStore.js';
import { AccountState } from './accountState.js';
import {
  CTraderApiError,
  CTraderDisconnectedError,
  CTraderProtocolError,
  CTraderTimeoutError,
  LiveAccountError,
} from './errors.js';
import { HISTORICAL_REQUESTS, PT, TOKEN_ERROR_CODES } from './payloadTypes.js';
import { DEFAULT_LIMITS, SlidingWindowLimiter } from './rateLimiter.js';
import {
  AccountAuthResSchema,
  AccountListResSchema,
  ClientDisconnectEventSchema,
  ExecutionEventSchema,
  OAErrorResSchema,
  OrderErrorEventSchema,
  ProtoErrorResSchema,
  ReconcileResSchema,
  RefreshTokenResSchema,
  SpotEventSchema,
  TokenInvalidatedEventSchema,
  TraderResSchema,
  type CtidTraderAccount,
  type Envelope,
  type ExecutionEvent,
  type SpotEvent,
  type Trader,
} from './schemas.js';
import type { Transport, TransportFactory } from './transport.js';

/** Where the client reads and persists the OAuth token pair. */
export interface TokenPersistence {
  load(): TokenPair | undefined;
  save(pair: TokenPair): void;
}

export interface CTraderClientOptions {
  clientId: string;
  clientSecret: string;
  /** ctidTraderAccountId; when omitted the token must expose exactly one demo account. */
  accountId?: number | undefined;
  transportFactory: TransportFactory;
  tokens: TokenPersistence;
  logger: Logger;
  requestTimeoutMs?: number;
  heartbeatIntervalMs?: number;
  reconcileIntervalMs?: number;
  backoff?: { baseMs: number; maxMs: number };
  limits?: { nonHistorical: number; historical: number };
  random?: () => number;
}

export type ClientStatus = 'idle' | 'connecting' | 'ready' | 'reconnecting' | 'stopped' | 'fatal';

export interface ClientEvents {
  ready: [{ accountId: number; trader: Trader }];
  disconnected: [string];
  execution: [ExecutionEvent];
  spot: [SpotEvent];
  orderError: [CTraderApiError];
  reconciled: [{ at: number; positionsChanged: number; ordersChanged: number }];
  tokenRefreshed: [];
  fatal: [Error];
}

interface Pending {
  payloadType: number;
  expect: ReadonlySet<number>;
  resolve: (env: Envelope) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export interface RequestOptions {
  timeoutMs?: number;
  /** Internal: auth-phase requests run before the client is ready. */
  duringAuth?: boolean;
}

/** Exponential backoff with "equal jitter": half fixed, half random. */
export function computeBackoff(attempt: number, baseMs: number, maxMs: number, random: () => number): number {
  const exp = Math.min(maxMs, baseMs * 2 ** attempt);
  return Math.round(exp / 2 + random() * (exp / 2));
}

export class CTraderClient extends EventEmitter<ClientEvents> {
  readonly state = new AccountState();
  private readonly log: Logger;
  private readonly timeoutMs: number;
  private readonly heartbeatMs: number;
  private readonly reconcileMs: number;
  private readonly backoff: { baseMs: number; maxMs: number };
  private readonly random: () => number;
  private readonly limiters: { nonHistorical: SlidingWindowLimiter; historical: SlidingWindowLimiter };

  private transport: Transport | undefined;
  private readonly pending = new Map<string, Pending>();
  private status_: ClientStatus = 'idle';
  private connectingLoop = false;
  private attempt = 0;
  private heartbeatTimer: NodeJS.Timeout | undefined;
  private reconcileTimer: NodeJS.Timeout | undefined;
  private retryTimer: { timer: NodeJS.Timeout; wake: () => void } | undefined;
  private refreshInFlight: Promise<void> | undefined;
  private tokens: TokenPair;
  private accountId_: number | undefined;
  private trader_: Trader | undefined;
  private readonly spotSubscriptions = new Set<number>();
  lastError: string | undefined;

  constructor(private readonly opts: CTraderClientOptions) {
    super();
    this.log = opts.logger.child({ component: 'ctrader-client' });
    this.timeoutMs = opts.requestTimeoutMs ?? 10_000;
    this.heartbeatMs = opts.heartbeatIntervalMs ?? 10_000;
    this.reconcileMs = opts.reconcileIntervalMs ?? 5 * 60_000;
    this.backoff = opts.backoff ?? { baseMs: 1_000, maxMs: 60_000 };
    this.random = opts.random ?? Math.random;
    const limits = opts.limits ?? DEFAULT_LIMITS;
    this.limiters = {
      nonHistorical: new SlidingWindowLimiter(limits.nonHistorical),
      historical: new SlidingWindowLimiter(limits.historical),
    };
    const stored = opts.tokens.load();
    if (!stored) throw new Error('Token store is empty: bootstrap it before creating the client');
    this.tokens = stored;
    this.accountId_ = opts.accountId;
  }

  get status(): ClientStatus {
    return this.status_;
  }

  get accountId(): number {
    if (this.accountId_ === undefined) throw new CTraderDisconnectedError('account not authenticated yet');
    return this.accountId_;
  }

  get trader(): Trader | undefined {
    return this.trader_;
  }

  /** Start connecting in the background. Resolves when the first session is ready. */
  start(): Promise<void> {
    if (this.status_ !== 'idle') throw new Error(`client already started (${this.status_})`);
    const ready = new Promise<void>((resolve, reject) => {
      const onReady = () => {
        this.off('fatal', onFatal);
        resolve();
      };
      const onFatal = (err: Error) => {
        this.off('ready', onReady);
        reject(err);
      };
      this.once('ready', onReady);
      this.once('fatal', onFatal);
    });
    this.status_ = 'connecting';
    void this.connectLoop();
    return ready;
  }

  async stop(): Promise<void> {
    if (this.status_ !== 'fatal') this.status_ = 'stopped';
    this.clearTimers();
    if (this.retryTimer) {
      clearTimeout(this.retryTimer.timer);
      this.retryTimer.wake();
      this.retryTimer = undefined;
    }
    this.rejectAllPending(new CTraderDisconnectedError('client stopped'));
    const t = this.transport;
    this.transport = undefined;
    t?.close();
    this.limiters.historical.dispose();
    this.limiters.nonHistorical.dispose();
    await Promise.resolve();
  }

  /** Test hook / manual chaos: drop the socket, the client must recover by itself. */
  dropConnection(): void {
    this.transport?.close();
  }

  // ------------------------------------------------------------------ requests

  /** Send a request and wait for a response whose payloadType is in `expect`. */
  async request(payloadType: number, payload: object, expect: number | number[], opts: RequestOptions = {}): Promise<Envelope> {
    if (!opts.duringAuth && this.status_ !== 'ready') {
      throw new CTraderDisconnectedError(`client is ${this.status_}`);
    }
    const transport = this.transport;
    if (!transport) throw new CTraderDisconnectedError('no transport');

    await (HISTORICAL_REQUESTS.has(payloadType) ? this.limiters.historical : this.limiters.nonHistorical).acquire();
    if (this.transport !== transport || !transport.isOpen) throw new CTraderDisconnectedError('connection lost while queued');

    const clientMsgId = randomUUID();
    const timeoutMs = opts.timeoutMs ?? this.timeoutMs;
    return new Promise<Envelope>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(clientMsgId);
        reject(new CTraderTimeoutError(payloadType, timeoutMs));
      }, timeoutMs);
      this.pending.set(clientMsgId, {
        payloadType,
        expect: new Set(Array.isArray(expect) ? expect : [expect]),
        resolve,
        reject,
        timer,
      });
      try {
        transport.send({ clientMsgId, payloadType, payload });
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(clientMsgId);
        reject(new CTraderDisconnectedError((err as Error).message));
      }
    });
  }

  /** request() + schema validation of the response payload. */
  async call<S extends z.ZodType>(
    payloadType: number,
    payload: object,
    expect: number,
    schema: S,
    opts: RequestOptions = {},
  ): Promise<z.infer<S>> {
    const env = await this.request(payloadType, payload, expect, opts);
    return parsePayload(schema, env, `response to ${payloadType}`);
  }

  /** Account-scoped call: injects ctidTraderAccountId. */
  callAccount<S extends z.ZodType>(payloadType: number, payload: object, expect: number, schema: S, opts: RequestOptions = {}) {
    return this.call(payloadType, { ctidTraderAccountId: this.accountId, ...payload }, expect, schema, opts);
  }

  async reconcile(opts: RequestOptions = {}): Promise<void> {
    const res = await this.callAccount(PT.RECONCILE_REQ, {}, PT.RECONCILE_RES, ReconcileResSchema, opts);
    const diff = this.state.applyReconcile(res);
    if (diff.positionsChanged > 0 || diff.ordersChanged > 0) {
      this.log.info(diff, 'reconcile corrected in-memory state');
    }
    this.emit('reconciled', { at: this.state.lastReconcileAt ?? Date.now(), ...diff });
  }

  async refreshTrader(opts: RequestOptions = {}): Promise<Trader> {
    const res = await this.callAccount(PT.TRADER_REQ, {}, PT.TRADER_RES, TraderResSchema, opts);
    this.trader_ = res.trader;
    return res.trader;
  }

  async subscribeSpots(symbolIds: number[], opts: RequestOptions = {}): Promise<void> {
    const fresh = symbolIds.filter((id) => !this.spotSubscriptions.has(id));
    if (fresh.length === 0) return;
    try {
      await this.request(PT.SUBSCRIBE_SPOTS_REQ, { ctidTraderAccountId: this.accountId, symbolId: fresh }, PT.SUBSCRIBE_SPOTS_RES, opts);
    } catch (err) {
      if (!(err instanceof CTraderApiError && err.errorCode === 'ALREADY_SUBSCRIBED')) throw err;
    }
    for (const id of fresh) this.spotSubscriptions.add(id);
  }

  // ------------------------------------------------------------------ connection lifecycle

  private async connectLoop(): Promise<void> {
    if (this.connectingLoop) return;
    this.connectingLoop = true;
    try {
      while (this.status_ === 'connecting' || this.status_ === 'reconnecting') {
        const transport = this.opts.transportFactory();
        this.attach(transport);
        try {
          await transport.connect();
          this.log.info('websocket connected, authenticating');
          await this.authenticate();
          // A stop() may have happened while we were awaiting.
          if (this.status_ !== 'connecting' && this.status_ !== 'reconnecting') return;
          this.attempt = 0;
          this.lastError = undefined;
          this.status_ = 'ready';
          this.startTimers();
          this.log.info({ accountId: this.accountId_ }, 'cTrader session ready');
          this.emit('ready', { accountId: this.accountId, trader: this.trader_! });
          return;
        } catch (err) {
          if (err instanceof LiveAccountError) {
            this.fatal(err);
            return;
          }
          this.lastError = (err as Error).message;
          this.log.warn({ err: (err as Error).message, attempt: this.attempt }, 'connect/auth failed');
          if (this.transport === transport) {
            this.transport = undefined;
            transport.close();
          }
          this.rejectAllPending(new CTraderDisconnectedError('reconnecting'));
          if (this.status_ !== 'connecting' && this.status_ !== 'reconnecting') return;
          const delay = computeBackoff(this.attempt++, this.backoff.baseMs, this.backoff.maxMs, this.random);
          this.log.info({ delayMs: delay }, 'retrying connection');
          await new Promise<void>((resolve) => {
            this.retryTimer = { timer: setTimeout(resolve, delay), wake: resolve };
          });
          this.retryTimer = undefined;
        }
      }
    } finally {
      this.connectingLoop = false;
    }
  }

  private attach(transport: Transport): void {
    this.transport = transport;
    transport.on('message', (env) => {
      if (this.transport === transport) this.onMessage(env);
    });
    transport.on('error', (err) => {
      if (this.transport === transport) this.log.warn({ err: err.message }, 'transport error');
    });
    transport.on('close', (reason) => {
      if (this.transport !== transport) return;
      this.transport = undefined;
      this.onDisconnect(reason);
    });
  }

  private onDisconnect(reason: string): void {
    this.clearTimers();
    this.rejectAllPending(new CTraderDisconnectedError(reason));
    if (this.status_ === 'stopped' || this.status_ === 'fatal') return;
    this.log.warn({ reason }, 'disconnected from cTrader');
    this.emit('disconnected', reason);
    if (this.status_ === 'ready') {
      this.status_ = 'reconnecting';
      void this.connectLoop();
    }
    // If we were connecting, the loop's pending await rejects and it retries.
  }

  private async authenticate(): Promise<void> {
    const auth: RequestOptions = { duringAuth: true };
    await this.request(
      PT.APPLICATION_AUTH_REQ,
      { clientId: this.opts.clientId, clientSecret: this.opts.clientSecret },
      PT.APPLICATION_AUTH_RES,
      auth,
    );

    const accounts = await this.withTokenRetry(() =>
      this.call(PT.GET_ACCOUNTS_BY_ACCESS_TOKEN_REQ, { accessToken: this.tokens.accessToken }, PT.GET_ACCOUNTS_BY_ACCESS_TOKEN_RES, AccountListResSchema, auth),
    );
    this.accountId_ = selectDemoAccount(accounts.ctidTraderAccount, this.opts.accountId);

    await this.withTokenRetry(() =>
      this.call(
        PT.ACCOUNT_AUTH_REQ,
        { ctidTraderAccountId: this.accountId, accessToken: this.tokens.accessToken },
        PT.ACCOUNT_AUTH_RES,
        AccountAuthResSchema,
        auth,
      ),
    );
    await this.refreshTrader(auth);
    await this.reconcile(auth);
    if (this.spotSubscriptions.size > 0) {
      const ids = [...this.spotSubscriptions];
      this.spotSubscriptions.clear();
      await this.subscribeSpots(ids, auth);
    }
  }

  /** Run fn; on a token error refresh the pair once and retry exactly once. */
  private async withTokenRetry<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (!(err instanceof CTraderApiError && TOKEN_ERROR_CODES.has(err.errorCode))) throw err;
      this.log.warn({ code: err.errorCode }, 'access token rejected, refreshing');
      await this.refreshTokens();
      return fn();
    }
  }

  /** Single-flight ProtoOARefreshTokenReq. The new pair is persisted before use. */
  refreshTokens(): Promise<void> {
    this.refreshInFlight ??= (async () => {
      try {
        const res = await this.call(
          PT.REFRESH_TOKEN_REQ,
          { refreshToken: this.tokens.refreshToken },
          PT.REFRESH_TOKEN_RES,
          RefreshTokenResSchema,
          { duringAuth: true },
        );
        const pair: TokenPair = {
          accessToken: res.accessToken,
          refreshToken: res.refreshToken,
          expiresAt: expiresAtFrom(res.expiresIn),
        };
        // Old pair is invalidated by the broker as soon as this succeeds: persist first.
        this.opts.tokens.save(pair);
        this.tokens = pair;
        this.log.info({ expiresAt: pair.expiresAt ? new Date(pair.expiresAt).toISOString() : undefined }, 'token pair refreshed and persisted');
        this.emit('tokenRefreshed');
      } finally {
        this.refreshInFlight = undefined;
      }
    })();
    return this.refreshInFlight;
  }

  // ------------------------------------------------------------------ inbound

  private onMessage(env: Envelope): void {
    const pending = env.clientMsgId !== undefined ? this.pending.get(env.clientMsgId) : undefined;
    const apiError = toApiError(env);

    if (pending && env.clientMsgId !== undefined) {
      if (apiError) {
        this.settle(env.clientMsgId, pending);
        pending.reject(apiError);
      } else if (pending.expect.has(env.payloadType)) {
        this.settle(env.clientMsgId, pending);
        pending.resolve(env);
      } else if (env.payloadType !== PT.EXECUTION_EVENT && env.payloadType !== PT.SPOT_EVENT) {
        this.log.debug({ payloadType: env.payloadType, waitingFor: [...pending.expect] }, 'unexpected response type, still waiting');
      }
    } else if (apiError) {
      if (apiError.source === 'ProtoOAOrderErrorEvent') this.emit('orderError', apiError);
      else this.log.warn({ code: apiError.errorCode, description: apiError.description }, 'uncorrelated error from broker');
    }

    switch (env.payloadType) {
      case PT.HEARTBEAT_EVENT:
        return;
      case PT.EXECUTION_EVENT: {
        const ev = safeParse(ExecutionEventSchema, env);
        if (!ev) return this.log.warn('invalid ProtoOAExecutionEvent ignored');
        this.state.applyExecution(ev);
        this.emit('execution', ev);
        return;
      }
      case PT.SPOT_EVENT: {
        const ev = safeParse(SpotEventSchema, env);
        if (ev) this.emit('spot', ev);
        return;
      }
      case PT.ACCOUNTS_TOKEN_INVALIDATED_EVENT: {
        const ev = safeParse(TokenInvalidatedEventSchema, env);
        if (ev && this.accountId_ !== undefined && ev.ctidTraderAccountIds.includes(this.accountId_)) {
          this.log.warn({ reason: ev.reason }, 'access token invalidated by broker');
          void this.recoverFromInvalidatedToken();
        }
        return;
      }
      case PT.ACCOUNT_DISCONNECT_EVENT:
        this.log.warn('broker disconnected the account session, reconnecting');
        this.dropConnection();
        return;
      case PT.CLIENT_DISCONNECT_EVENT: {
        const ev = safeParse(ClientDisconnectEventSchema, env);
        this.log.warn({ reason: ev?.reason }, 'broker is closing the connection');
        return;
      }
      default:
        return;
    }
  }

  private async recoverFromInvalidatedToken(): Promise<void> {
    try {
      await this.refreshTokens();
      await this.call(
        PT.ACCOUNT_AUTH_REQ,
        { ctidTraderAccountId: this.accountId, accessToken: this.tokens.accessToken },
        PT.ACCOUNT_AUTH_RES,
        AccountAuthResSchema,
        { duringAuth: true },
      );
      this.log.info('account re-authorised with refreshed token');
    } catch (err) {
      this.log.error({ err: (err as Error).message }, 'token recovery failed, forcing reconnect');
      this.dropConnection();
    }
  }

  // ------------------------------------------------------------------ timers & helpers

  private startTimers(): void {
    this.clearTimers();
    this.heartbeatTimer = setInterval(() => {
      try {
        this.transport?.send({ payloadType: PT.HEARTBEAT_EVENT, payload: {} });
      } catch (err) {
        this.log.warn({ err: (err as Error).message }, 'heartbeat send failed');
      }
    }, this.heartbeatMs);
    this.reconcileTimer = setInterval(() => {
      this.reconcile().catch((err: unknown) => this.log.warn({ err: (err as Error).message }, 'periodic reconcile failed'));
    }, this.reconcileMs);
  }

  private clearTimers(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    this.heartbeatTimer = undefined;
    this.reconcileTimer = undefined;
  }

  private settle(id: string, p: Pending): void {
    clearTimeout(p.timer);
    this.pending.delete(id);
  }

  private rejectAllPending(err: Error): void {
    // Everything in `pending` was already written to the socket.
    const sentErr = err instanceof CTraderDisconnectedError ? new CTraderDisconnectedError(err.message.replace(/^cTrader connection unavailable: /, ''), true) : err;
    for (const [id, p] of this.pending) {
      this.settle(id, p);
      p.reject(sentErr);
    }
  }

  private fatal(err: Error): void {
    this.log.fatal({ err: err.message }, 'fatal cTrader client error');
    this.status_ = 'fatal';
    this.lastError = err.message;
    this.clearTimers();
    this.rejectAllPending(err);
    const t = this.transport;
    this.transport = undefined;
    t?.close();
    this.emit('fatal', err);
  }
}

/**
 * Demo-only guard. `isLive` exists only on ProtoOACtidTraderAccount (account
 * list), not on ProtoOATrader. Anything not explicitly `isLive === false` is
 * rejected, including accounts missing from the token's list.
 */
export function selectDemoAccount(accounts: CtidTraderAccount[], configured: number | undefined): number {
  if (configured !== undefined) {
    const acc = accounts.find((a) => a.ctidTraderAccountId === configured);
    if (!acc) throw new LiveAccountError(`Account ${configured} is not available for this access token; cannot verify it is demo`);
    if (acc.isLive !== false) throw new LiveAccountError(`Account ${configured} is LIVE (or unknown). This server only operates demo accounts. Aborting.`);
    return configured;
  }
  const demo = accounts.filter((a) => a.isLive === false);
  if (demo.length === 1) return demo[0]!.ctidTraderAccountId;
  const ids = demo.map((a) => a.ctidTraderAccountId).join(', ') || 'none';
  throw new LiveAccountError(`CTRADER_ACCOUNT_ID not set and the token has ${demo.length} demo accounts (${ids}). Set CTRADER_ACCOUNT_ID.`);
}

/**
 * expiresIn: the HTTP token endpoint documents seconds (2628000 ≈ 30 days); the
 * C# SDK sample treats the Protobuf field as Unix ms. Accept both.
 */
export function expiresAtFrom(expiresIn: number, now = Date.now()): number | undefined {
  if (!(expiresIn > 0)) return undefined;
  if (expiresIn > 1e11) return expiresIn; // already a Unix ms timestamp
  return now + expiresIn * 1000;
}

function toApiError(env: Envelope): CTraderApiError | undefined {
  switch (env.payloadType) {
    case PT.OA_ERROR_RES: {
      const e = safeParse(OAErrorResSchema, env);
      return e
        ? new CTraderApiError('ProtoOAErrorRes', e.errorCode, e.description, { retryAfter: e.retryAfter, maintenanceEndTimestamp: e.maintenanceEndTimestamp })
        : new CTraderApiError('ProtoOAErrorRes', 'UNPARSEABLE');
    }
    case PT.ERROR_RES: {
      const e = safeParse(ProtoErrorResSchema, env);
      return new CTraderApiError('ProtoErrorRes', e?.errorCode ?? 'UNPARSEABLE', e?.description);
    }
    case PT.ORDER_ERROR_EVENT: {
      const e = safeParse(OrderErrorEventSchema, env);
      return new CTraderApiError('ProtoOAOrderErrorEvent', e?.errorCode ?? 'UNPARSEABLE', e?.description, {
        orderId: e?.orderId,
        positionId: e?.positionId,
      });
    }
    default:
      return undefined;
  }
}

function safeParse<S extends z.ZodType>(schema: S, env: Envelope): z.infer<S> | undefined {
  const r = schema.safeParse(env.payload ?? {});
  return r.success ? r.data : undefined;
}

export function parsePayload<S extends z.ZodType>(schema: S, env: Envelope, what: string): z.infer<S> {
  const r = schema.safeParse(env.payload ?? {});
  if (!r.success) {
    const issues = r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new CTraderProtocolError(`Invalid ${what}: ${issues}`);
  }
  return r.data;
}
