import { describe, expect, it } from 'vitest';
import {
  conversionRate,
  moneyFromProto,
  normalizeSymbolName,
  normalizeVolume,
  pipValuePerUnit,
  priceDistanceToRelative,
  priceToPips,
  protoPriceToNumber,
  trendbarToCandle,
  trendbarsToCandles,
  unitsToVolume,
  volumeToUnits,
} from '../../src/ctrader/normalize.js';

// Asset ids are arbitrary in tests.
const USD = 1, EUR = 2, GBP = 3, JPY = 4, XAU = 5;

describe('prices', () => {
  it('converts protocol integers with factor 1e5 and rounds to digits', () => {
    expect(protoPriceToNumber(108_451, 5)).toBe(1.08451);
    expect(protoPriceToNumber(15_012_345, 3)).toBe(150.123); // USDJPY, 150.12345 -> 3 digits
    expect(protoPriceToNumber(15_012_355, 3)).toBe(150.124);
    expect(protoPriceToNumber(265_012_000, 2)).toBe(2650.12); // XAUUSD
  });

  it('converts distances to relative SL/TP protocol units', () => {
    expect(priceDistanceToRelative(0.0015)).toBe(150);
    expect(priceDistanceToRelative(0.25)).toBe(25_000);
    expect(() => priceDistanceToRelative(0)).toThrow();
  });

  it('measures pips with pipPosition', () => {
    expect(priceToPips(0.0015, 4)).toBeCloseTo(15, 10);
    expect(priceToPips(0.25, 2)).toBeCloseTo(25, 10);
  });

  it('scales money by moneyDigits', () => {
    expect(moneyFromProto(10053099944, 8)).toBeCloseTo(100.53099944, 10);
    expect(moneyFromProto(1234567, 2)).toBe(12345.67);
  });
});

describe('trendbars', () => {
  it('rebuilds OHLC from low + deltas with UTC timestamps', () => {
    const c = trendbarToCandle(
      { volume: 321, low: 108_000, deltaOpen: 120, deltaHigh: 250, deltaClose: 40, utcTimestampInMinutes: 28_333_440 },
      5,
    );
    expect(c).toEqual({
      time: '2023-11-15T00:00:00.000Z',
      t: 28_333_440 * 60_000,
      open: 1.0812,
      high: 1.0825,
      low: 1.08,
      close: 1.0804,
      volume: 321,
    });
  });

  it('treats missing deltas as zero and sorts by time', () => {
    const cs = trendbarsToCandles(
      [
        { volume: 1, low: 15_000_000, utcTimestampInMinutes: 120 },
        { volume: 1, low: 15_010_000, deltaHigh: 5_000, utcTimestampInMinutes: 60 },
      ],
      3,
    );
    expect(cs.map((c) => c.t)).toEqual([3_600_000, 7_200_000]);
    expect(cs[0]).toMatchObject({ open: 150.1, high: 150.15, low: 150.1, close: 150.1 });
  });

  it('rejects bars without low or timestamp', () => {
    expect(() => trendbarToCandle({ volume: 1 }, 5)).toThrow();
  });
});

describe('volume', () => {
  const spec = { minVolume: 100_000, maxVolume: 10_000_000_000, stepVolume: 100_000 }; // 1k units min/step

  it('converts units <-> protocol cents', () => {
    expect(unitsToVolume(10_000)).toBe(1_000_000);
    expect(volumeToUnits(1_000)).toBe(10);
  });

  it('rounds DOWN to stepVolume', () => {
    expect(normalizeVolume(unitsToVolume(12_345), spec)).toEqual({ ok: true, volume: 1_200_000 });
    expect(normalizeVolume(unitsToVolume(1_999.99), spec)).toEqual({ ok: true, volume: 100_000 });
  });

  it('rejects below minVolume', () => {
    const r = normalizeVolume(unitsToVolume(999), spec);
    expect(r.ok).toBe(false);
  });

  it('caps at maxVolume (still multiple of step)', () => {
    expect(normalizeVolume(20_000_000_000, spec)).toEqual({ ok: true, volume: 10_000_000_000 });
  });

  it('handles float noise exactly at a step boundary', () => {
    expect(normalizeVolume(unitsToVolume(0.29 * 100_000), { stepVolume: 100_000 })).toEqual({ ok: true, volume: 2_900_000 });
  });
});

describe('conversion and pip value (USD account)', () => {
  it('EURUSD: quote = deposit -> $10 per pip per 100k', () => {
    const rate = conversionRate(USD, USD, []);
    expect(pipValuePerUnit(4, rate) * 100_000).toBeCloseTo(10, 10);
  });

  it('USDJPY @150.00: quote JPY -> USD divides by USDJPY -> $6.6667 per pip per 100k', () => {
    const rate = conversionRate(JPY, USD, [{ baseAssetId: USD, quoteAssetId: JPY, price: 150 }]);
    expect(pipValuePerUnit(2, rate) * 100_000).toBeCloseTo(6.666_666_7, 6);
  });

  it('EURGBP with GBPUSD @1.2700: quote GBP -> USD multiplies -> $12.70 per pip per 100k', () => {
    const rate = conversionRate(GBP, USD, [{ baseAssetId: GBP, quoteAssetId: USD, price: 1.27 }]);
    expect(pipValuePerUnit(4, rate) * 100_000).toBeCloseTo(12.7, 10);
  });

  it('XAUUSD pipPosition 1: $0.10 per pip per ounce', () => {
    expect(pipValuePerUnit(1, conversionRate(USD, USD, []))).toBeCloseTo(0.1, 12);
  });

  it('two-leg chain: JPY -> EUR account via USDJPY and EURUSD', () => {
    // 1 JPY = 1/150 USD = (1/150)/1.08 EUR
    const rate = conversionRate(JPY, EUR, [
      { baseAssetId: USD, quoteAssetId: JPY, price: 150 },
      { baseAssetId: EUR, quoteAssetId: USD, price: 1.08 },
    ]);
    expect(rate).toBeCloseTo(1 / 150 / 1.08, 12);
    expect(pipValuePerUnit(2, rate) * 100_000).toBeCloseTo(6.172_839_5, 6);
  });

  it('EURUSD with a EUR account: quote USD -> EUR divides by EURUSD', () => {
    const rate = conversionRate(USD, EUR, [{ baseAssetId: EUR, quoteAssetId: USD, price: 1.25 }]);
    expect(pipValuePerUnit(4, rate) * 100_000).toBeCloseTo(8, 10);
  });

  it('rejects a broken chain or non-positive prices', () => {
    expect(() => conversionRate(JPY, USD, [{ baseAssetId: EUR, quoteAssetId: GBP, price: 0.85 }])).toThrow(/broken/);
    expect(() => conversionRate(JPY, USD, [{ baseAssetId: USD, quoteAssetId: JPY, price: 0 }])).toThrow();
    expect(() => conversionRate(XAU, USD, [{ baseAssetId: XAU, quoteAssetId: EUR, price: 2000 }])).toThrow(/ends at/);
  });
});

describe('symbol names', () => {
  it('normalises separators and case', () => {
    expect(normalizeSymbolName('EUR/USD')).toBe('EURUSD');
    expect(normalizeSymbolName('xau-usd')).toBe('XAUUSD');
  });
});
