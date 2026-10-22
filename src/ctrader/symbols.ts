import type { DB } from '../db/database.js';
import type { Logger } from '../logger.js';
import type { CTraderClient } from './client.js';
import { conversionRate, normalizeSymbolName, pipValuePerUnit, protoPriceToNumber, type ConversionLeg } from './normalize.js';
import { PT } from './payloadTypes.js';
import {
  AssetListResSchema,
  SymbolByIdResSchema,
  SymbolsForConversionResSchema,
  SymbolsListResSchema,
  type Asset,
  type LightSymbol,
  type ProtoSymbol,
  type SpotEvent,
} from './schemas.js';

/** Everything we need about a symbol, merged from the light list + full details. */
export interface SymbolInfo {
  symbolId: number;
  name: string;
  key: string;
  baseAssetId: number;
  quoteAssetId: number;
  baseAsset: string;
  quoteAsset: string;
  digits: number;
  pipPosition: number;
  /** Volumes in protocol cents (1/100 unit). */
  minVolume: number | undefined;
  maxVolume: number | undefined;
  stepVolume: number | undefined;
  lotSize: number | undefined;
}

export interface Quote {
  bid: number;
  ask: number;
  mid: number;
  spread: number;
  at: number;
}

/** Narrow client surface used here, so tests can pass a fake. */
export type SymbolClient = Pick<CTraderClient, 'callAccount' | 'subscribeSpots' | 'on'>;

const DETAILS_MAX_AGE_MS = 24 * 60 * 60_000;

/**
 * Symbol + asset cache (memory and SQLite) and live quote book.
 * Prices from spot events are protocol integers (1/100000).
 */
export class SymbolService {
  private assets = new Map<number, Asset>();
  private light = new Map<number, LightSymbol>();
  private byKey = new Map<string, number>();
  private details = new Map<number, SymbolInfo>();
  private quotes = new Map<number, Quote>();
  private readonly log: Logger;

  constructor(
    private readonly client: SymbolClient,
    private readonly db: DB,
    logger: Logger,
  ) {
    this.log = logger.child({ component: 'symbols' });
    this.loadFromDb();
    client.on('spot', (ev) => this.onSpot(ev));
  }

  /** Download assets + light symbol list (cheap, 2 requests). */
  async refreshLists(): Promise<void> {
    const [assets, symbols] = await Promise.all([
      this.client.callAccount(PT.ASSET_LIST_REQ, {}, PT.ASSET_LIST_RES, AssetListResSchema),
      this.client.callAccount(PT.SYMBOLS_LIST_REQ, { includeArchivedSymbols: false }, PT.SYMBOLS_LIST_RES, SymbolsListResSchema),
    ]);
    this.assets = new Map(assets.asset.map((a) => [a.assetId, a]));
    this.light = new Map(symbols.symbol.map((s) => [s.symbolId, s]));
    this.byKey = new Map(symbols.symbol.filter((s) => s.symbolName).map((s) => [normalizeSymbolName(s.symbolName!), s.symbolId]));
    const now = new Date().toISOString();
    const insert = this.db.prepare('INSERT OR REPLACE INTO assets (asset_id, name, data, updated_at) VALUES (?, ?, ?, ?)');
    this.db.transaction(() => {
      for (const a of assets.asset) insert.run(a.assetId, a.name, JSON.stringify(a), now);
    })();
    this.log.info({ assets: this.assets.size, symbols: this.light.size }, 'symbol lists refreshed');
  }

  /** Resolve "EURUSD" / "EUR/USD" to full symbol details (cached 24h). */
  async get(name: string): Promise<SymbolInfo> {
    if (this.byKey.size === 0) await this.refreshLists();
    const id = this.byKey.get(normalizeSymbolName(name));
    if (id === undefined) throw new Error(`Unknown symbol ${name}`);
    return this.getById(id);
  }

  async getById(symbolId: number): Promise<SymbolInfo> {
    const cached = this.details.get(symbolId);
    if (cached) return cached;
    const [info] = await this.fetchDetails([symbolId]);
    if (!info) throw new Error(`Symbol ${symbolId} not returned by broker`);
    return info;
  }

  async fetchDetails(symbolIds: number[]): Promise<SymbolInfo[]> {
    if (this.light.size === 0) await this.refreshLists();
    const res = await this.client.callAccount(PT.SYMBOL_BY_ID_REQ, { symbolId: symbolIds }, PT.SYMBOL_BY_ID_RES, SymbolByIdResSchema);
    const now = new Date().toISOString();
    const insert = this.db.prepare('INSERT OR REPLACE INTO symbols (symbol_id, name, data, updated_at) VALUES (?, ?, ?, ?)');
    const out: SymbolInfo[] = [];
    this.db.transaction(() => {
      for (const s of res.symbol) {
        const info = this.merge(s);
        this.details.set(info.symbolId, info);
        insert.run(info.symbolId, info.name, JSON.stringify(info), now);
        out.push(info);
      }
    })();
    return out;
  }

  /** Subscribe to spots (needed for quotes, spread and conversions). */
  async ensureQuotes(symbolIds: number[]): Promise<void> {
    await this.client.subscribeSpots(symbolIds);
  }

  getQuote(symbolId: number): Quote | undefined {
    return this.quotes.get(symbolId);
  }

  /** Rate to convert 1 unit of `fromAssetId` into `toAssetId` using live quotes. */
  async conversionRate(fromAssetId: number, toAssetId: number): Promise<number> {
    if (fromAssetId === toAssetId) return 1;
    const res = await this.client.callAccount(
      PT.SYMBOLS_FOR_CONVERSION_REQ,
      { firstAssetId: fromAssetId, lastAssetId: toAssetId },
      PT.SYMBOLS_FOR_CONVERSION_RES,
      SymbolsForConversionResSchema,
    );
    if (res.symbol.length === 0) throw new Error(`No conversion path from asset ${fromAssetId} to ${toAssetId}`);
    await this.ensureQuotes(res.symbol.map((s) => s.symbolId));
    const legs: ConversionLeg[] = [];
    for (const s of res.symbol) {
      const q = this.quotes.get(s.symbolId) ?? (await this.waitForQuote(s.symbolId));
      if (s.baseAssetId === undefined || s.quoteAssetId === undefined) throw new Error(`Conversion symbol ${s.symbolId} lacks assets`);
      legs.push({ baseAssetId: s.baseAssetId, quoteAssetId: s.quoteAssetId, price: q.mid });
    }
    return conversionRate(fromAssetId, toAssetId, legs);
  }

  /** Pip value for one unit of the symbol, in the deposit currency. */
  async pipValuePerUnit(symbol: SymbolInfo, depositAssetId: number): Promise<number> {
    const rate = await this.conversionRate(symbol.quoteAssetId, depositAssetId);
    return pipValuePerUnit(symbol.pipPosition, rate);
  }

  assetName(assetId: number): string | undefined {
    return this.assets.get(assetId)?.name;
  }

  waitForQuote(symbolId: number, timeoutMs = 5_000): Promise<Quote> {
    const existing = this.quotes.get(symbolId);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setInterval(() => {
        const q = this.quotes.get(symbolId);
        if (q) {
          clearInterval(timer);
          clearTimeout(to);
          resolve(q);
        }
      }, 50);
      const to = setTimeout(() => {
        clearInterval(timer);
        reject(new Error(`No quote for symbol ${symbolId} within ${timeoutMs} ms`));
      }, timeoutMs);
    });
  }

  private onSpot(ev: SpotEvent): void {
    const info = this.details.get(ev.symbolId);
    const digits = info?.digits ?? 5;
    const prev = this.quotes.get(ev.symbolId);
    // A spot event may carry only the side that changed.
    const bid = ev.bid !== undefined ? protoPriceToNumber(ev.bid, digits) : prev?.bid;
    const ask = ev.ask !== undefined ? protoPriceToNumber(ev.ask, digits) : prev?.ask;
    if (bid === undefined || ask === undefined || bid <= 0 || ask <= 0) return;
    this.quotes.set(ev.symbolId, { bid, ask, mid: (bid + ask) / 2, spread: ask - bid, at: ev.timestamp ?? Date.now() });
  }

  private merge(s: ProtoSymbol): SymbolInfo {
    const light = this.light.get(s.symbolId);
    if (!light?.symbolName || light.baseAssetId === undefined || light.quoteAssetId === undefined) {
      throw new Error(`Symbol ${s.symbolId} missing from light list`);
    }
    return {
      symbolId: s.symbolId,
      name: light.symbolName,
      key: normalizeSymbolName(light.symbolName),
      baseAssetId: light.baseAssetId,
      quoteAssetId: light.quoteAssetId,
      baseAsset: this.assets.get(light.baseAssetId)?.name ?? String(light.baseAssetId),
      quoteAsset: this.assets.get(light.quoteAssetId)?.name ?? String(light.quoteAssetId),
      digits: s.digits,
      pipPosition: s.pipPosition,
      minVolume: s.minVolume,
      maxVolume: s.maxVolume,
      stepVolume: s.stepVolume,
      lotSize: s.lotSize,
    };
  }

  private loadFromDb(): void {
    const cutoff = new Date(Date.now() - DETAILS_MAX_AGE_MS).toISOString();
    const rows = this.db.prepare('SELECT data FROM symbols WHERE updated_at >= ?').all(cutoff) as Array<{ data: string }>;
    for (const r of rows) {
      const info = JSON.parse(r.data) as SymbolInfo;
      this.details.set(info.symbolId, info);
    }
  }
}
