import type { ProtoTrendbar } from './schemas.js';

/**
 * Pure conversions between protocol units and business units.
 *
 * - Protocol integer prices (spot bid/ask, trendbars, relative SL/TP) are in
 *   1/100000 of a price unit (help.ctrader.com/open-api/symbol-data).
 * - Absolute prices in orders/positions are already doubles.
 * - Volumes are in cents of a unit: 1000 in protocol = 10.00 units.
 * - Money values are scaled by 10^moneyDigits (sent with each message).
 */

export const PRICE_FACTOR = 100_000;

export function roundTo(value: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round((value + Number.EPSILON * Math.sign(value)) * f) / f;
}

/** Integer protocol price -> price rounded to the symbol digits. */
export function protoPriceToNumber(raw: number, digits: number): number {
  return roundTo(raw / PRICE_FACTOR, digits);
}

/** Price distance -> relative SL/TP in protocol units (1/100000). */
export function priceDistanceToRelative(distance: number): number {
  if (!(distance > 0)) throw new RangeError('distance must be > 0');
  return Math.round(distance * PRICE_FACTOR);
}

export function pipSize(pipPosition: number): number {
  // 1 / 10^n is exact for display (10 ** -4 prints 0.00009999999999999999)
  return 1 / 10 ** pipPosition;
}

export function priceToPips(distance: number, pipPosition: number): number {
  return distance / pipSize(pipPosition);
}

export function moneyFromProto(raw: number, moneyDigits: number | undefined): number {
  return raw / 10 ** (moneyDigits ?? 2);
}

// ---------------------------------------------------------------- volume

export function unitsToVolume(units: number): number {
  return Math.round(units * 100);
}

export function volumeToUnits(volume: number): number {
  return volume / 100;
}

export interface VolumeSpec {
  minVolume?: number | undefined;
  maxVolume?: number | undefined;
  stepVolume?: number | undefined;
}

export type VolumeCheck = { ok: true; volume: number } | { ok: false; reason: string; volume: number };

/**
 * Round a desired volume (protocol cents) DOWN to stepVolume and validate it
 * against min/max. Never rounds up: rounding up would increase the risk.
 */
export function normalizeVolume(desiredVolume: number, spec: VolumeSpec): VolumeCheck {
  const step = spec.stepVolume && spec.stepVolume > 0 ? spec.stepVolume : 1;
  let volume = Math.floor(desiredVolume / step + 1e-9) * step;
  if (spec.maxVolume !== undefined && volume > spec.maxVolume) {
    volume = Math.floor(spec.maxVolume / step) * step;
  }
  if (volume <= 0) return { ok: false, reason: 'volume rounds to zero', volume: 0 };
  if (spec.minVolume !== undefined && volume < spec.minVolume) {
    return { ok: false, reason: `volume ${volume} below minVolume ${spec.minVolume}`, volume };
  }
  return { ok: true, volume };
}

// ---------------------------------------------------------------- trendbars

export interface Candle {
  /** Bar open time, ISO-8601 UTC. */
  time: string;
  /** Bar open time, Unix ms. */
  t: number;
  open: number;
  high: number;
  low: number;
  close: number;
  /** Volume in ticks, as sent by the broker. */
  volume: number;
}

/** ProtoOATrendbar -> OHLC. low is absolute; open/close/high are deltas over low. */
export function trendbarToCandle(bar: ProtoTrendbar, digits: number): Candle {
  if (bar.low === undefined || bar.utcTimestampInMinutes === undefined) {
    throw new RangeError('trendbar without low or timestamp');
  }
  const low = bar.low;
  const t = bar.utcTimestampInMinutes * 60_000;
  return {
    time: new Date(t).toISOString(),
    t,
    open: protoPriceToNumber(low + (bar.deltaOpen ?? 0), digits),
    high: protoPriceToNumber(low + (bar.deltaHigh ?? 0), digits),
    low: protoPriceToNumber(low, digits),
    close: protoPriceToNumber(low + (bar.deltaClose ?? 0), digits),
    volume: bar.volume,
  };
}

export function trendbarsToCandles(bars: ProtoTrendbar[], digits: number): Candle[] {
  return bars.map((b) => trendbarToCandle(b, digits)).sort((a, b) => a.t - b.t);
}

// ---------------------------------------------------------------- conversion / pip value

/** One leg of a conversion chain: a symbol with its assets and a current mid price. */
export interface ConversionLeg {
  baseAssetId: number;
  quoteAssetId: number;
  /** Price of 1 base in quote. */
  price: number;
}

/**
 * Rate to convert 1 unit of `fromAsset` into `toAsset`, walking a chain of
 * symbols (as returned by ProtoOASymbolsForConversionReq). Each leg is either
 * FROM/X (multiply) or X/FROM (divide).
 */
export function conversionRate(fromAsset: number, toAsset: number, chain: ConversionLeg[]): number {
  let current = fromAsset;
  let rate = 1;
  for (const leg of chain) {
    if (!(leg.price > 0)) throw new RangeError('conversion price must be > 0');
    if (leg.baseAssetId === current) {
      rate *= leg.price;
      current = leg.quoteAssetId;
    } else if (leg.quoteAssetId === current) {
      rate /= leg.price;
      current = leg.baseAssetId;
    } else {
      throw new Error(`conversion chain broken at asset ${current}`);
    }
  }
  if (current !== toAsset) throw new Error(`conversion chain ends at ${current}, expected ${toAsset}`);
  return rate;
}

/**
 * Value of one pip for ONE unit of base, in the deposit currency.
 * A pip is 10^-pipPosition in quote currency, then converted quote -> deposit.
 */
export function pipValuePerUnit(pipPosition: number, quoteToDepositRate: number): number {
  if (!(quoteToDepositRate > 0)) throw new RangeError('quoteToDepositRate must be > 0');
  return pipSize(pipPosition) * quoteToDepositRate;
}

/** Normalised symbol name used for lookups: "EUR/USD" -> "EURUSD". */
export function normalizeSymbolName(name: string): string {
  return name.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
}
