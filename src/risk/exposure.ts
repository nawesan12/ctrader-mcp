/**
 * Net risk per currency. A position risking R (deposit currency) on BASE/QUOTE
 * is "long BASE R, short QUOTE R" when buying, and the reverse when selling.
 * Example: long USDJPY (+USD, -JPY) and short EURUSD (-EUR, +USD) => +2R USD.
 */

export type Side = 'BUY' | 'SELL';

export interface RiskExposure {
  baseAsset: string;
  quoteAsset: string;
  side: Side;
  /** Amount at risk in deposit currency (>= 0). */
  risk: number;
}

export function netCurrencyRisk(items: RiskExposure[]): Map<string, number> {
  const net = new Map<string, number>();
  const add = (ccy: string, v: number) => net.set(ccy, (net.get(ccy) ?? 0) + v);
  for (const it of items) {
    const sign = it.side === 'BUY' ? 1 : -1;
    add(it.baseAsset, sign * it.risk);
    add(it.quoteAsset, -sign * it.risk);
  }
  return net;
}

export interface CurrencyBreach {
  currency: string;
  before: number;
  after: number;
}

/**
 * Currencies whose |net risk| grows with the candidate trade AND ends above
 * `limitAmount`. A trade that reduces an already-large exposure is allowed.
 */
export function currencyBreaches(existing: RiskExposure[], candidate: RiskExposure, limitAmount: number): CurrencyBreach[] {
  const before = netCurrencyRisk(existing);
  const after = netCurrencyRisk([...existing, candidate]);
  const out: CurrencyBreach[] = [];
  for (const ccy of [candidate.baseAsset, candidate.quoteAsset]) {
    const b = before.get(ccy) ?? 0;
    const a = after.get(ccy) ?? 0;
    if (Math.abs(a) > Math.abs(b) + 1e-9 && Math.abs(a) > limitAmount + 1e-9) out.push({ currency: ccy, before: b, after: a });
  }
  return out;
}
