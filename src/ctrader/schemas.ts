import { z } from 'zod';

/**
 * Zod schemas for the broker responses/events we consume. Field names and types
 * follow the official .proto files. Fields we do not use are stripped.
 *
 * int64 values can arrive as JSON numbers or as strings (proto3 JSON mapping);
 * both are accepted and must fit in a JS safe integer.
 */
export const int64 = z.union([z.number(), z.string()]).transform((v, ctx) => {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isSafeInteger(n)) {
    ctx.addIssue({ code: 'custom', message: `int64 out of safe range: ${String(v)}` });
    return z.NEVER;
  }
  return n;
});

/** Protocol enum: accept the numeric value or its proto name. */
function protoEnum<T extends Record<string, number>>(values: T) {
  const byName = new Map(Object.entries(values));
  const numbers = new Set(Object.values(values));
  return z.union([z.number(), z.string()]).transform((v, ctx) => {
    const n = typeof v === 'number' ? v : byName.get(v);
    if (n === undefined || !numbers.has(n)) {
      ctx.addIssue({ code: 'custom', message: `unknown enum value ${String(v)}` });
      return z.NEVER;
    }
    return n as T[keyof T];
  });
}

const TradeSideE = protoEnum({ BUY: 1, SELL: 2 });
const OrderTypeE = protoEnum({ MARKET: 1, LIMIT: 2, STOP: 3, STOP_LOSS_TAKE_PROFIT: 4, MARKET_RANGE: 5, STOP_LIMIT: 6 });
const OrderStatusE = protoEnum({
  ORDER_STATUS_ACCEPTED: 1,
  ORDER_STATUS_FILLED: 2,
  ORDER_STATUS_REJECTED: 3,
  ORDER_STATUS_EXPIRED: 4,
  ORDER_STATUS_CANCELLED: 5,
});
const PositionStatusE = protoEnum({
  POSITION_STATUS_OPEN: 1,
  POSITION_STATUS_CLOSED: 2,
  POSITION_STATUS_CREATED: 3,
  POSITION_STATUS_ERROR: 4,
});
const ExecutionTypeE = protoEnum({
  ORDER_ACCEPTED: 2,
  ORDER_FILLED: 3,
  ORDER_REPLACED: 4,
  ORDER_CANCELLED: 5,
  ORDER_EXPIRED: 6,
  ORDER_REJECTED: 7,
  ORDER_CANCEL_REJECTED: 8,
  SWAP: 9,
  DEPOSIT_WITHDRAW: 10,
  ORDER_PARTIAL_FILL: 11,
  BONUS_DEPOSIT_WITHDRAW: 12,
});
const TrendbarPeriodE = protoEnum({
  M1: 1, M2: 2, M3: 3, M4: 4, M5: 5, M10: 6, M15: 7, M30: 8, H1: 9, H4: 10, H12: 11, D1: 12, W1: 13, MN1: 14,
});

/** Envelope of every message on the JSON channel. */
export const EnvelopeSchema = z.object({
  payloadType: z.number().int(),
  payload: z.unknown().optional(),
  clientMsgId: z.string().optional(),
});
export type Envelope = z.infer<typeof EnvelopeSchema>;

export const ProtoErrorResSchema = z.object({
  errorCode: z.string(),
  description: z.string().optional(),
  maintenanceEndTimestamp: int64.optional(),
});

export const OAErrorResSchema = z.object({
  ctidTraderAccountId: int64.optional(),
  errorCode: z.string(),
  description: z.string().optional(),
  maintenanceEndTimestamp: int64.optional(),
  retryAfter: int64.optional(),
});

export const OrderErrorEventSchema = z.object({
  ctidTraderAccountId: int64,
  errorCode: z.string(),
  orderId: int64.optional(),
  positionId: int64.optional(),
  description: z.string().optional(),
});

export const CtidTraderAccountSchema = z.object({
  ctidTraderAccountId: int64,
  isLive: z.boolean().optional(),
  traderLogin: int64.optional(),
  brokerTitleShort: z.string().optional(),
});
export const AccountListResSchema = z.object({
  ctidTraderAccount: z.array(CtidTraderAccountSchema).default([]),
});
export type CtidTraderAccount = z.infer<typeof CtidTraderAccountSchema>;

export const AccountAuthResSchema = z.object({ ctidTraderAccountId: int64 });

export const RefreshTokenResSchema = z.object({
  accessToken: z.string().min(1),
  tokenType: z.string(),
  expiresIn: int64,
  refreshToken: z.string().min(1),
});
export type RefreshTokenRes = z.infer<typeof RefreshTokenResSchema>;

export const TokenInvalidatedEventSchema = z.object({
  ctidTraderAccountIds: z.array(int64).default([]),
  reason: z.string().optional(),
});

export const ClientDisconnectEventSchema = z.object({ reason: z.string().optional() });

export const TraderSchema = z.object({
  ctidTraderAccountId: int64,
  balance: int64,
  depositAssetId: int64,
  leverageInCents: z.number().optional(),
  accountType: z.union([z.number(), z.string()]).optional(),
  brokerName: z.string().optional(),
  traderLogin: int64.optional(),
  moneyDigits: z.number().int().nonnegative().optional(),
});
export const TraderResSchema = z.object({ ctidTraderAccountId: int64, trader: TraderSchema });
export type Trader = z.infer<typeof TraderSchema>;

export const AssetSchema = z.object({
  assetId: int64,
  name: z.string(),
  displayName: z.string().optional(),
  digits: z.number().int().optional(),
});
export const AssetListResSchema = z.object({ asset: z.array(AssetSchema).default([]) });
export type Asset = z.infer<typeof AssetSchema>;

export const LightSymbolSchema = z.object({
  symbolId: int64,
  symbolName: z.string().optional(),
  enabled: z.boolean().optional(),
  baseAssetId: int64.optional(),
  quoteAssetId: int64.optional(),
  symbolCategoryId: int64.optional(),
  description: z.string().optional(),
});
export const SymbolsListResSchema = z.object({ symbol: z.array(LightSymbolSchema).default([]) });
export const SymbolsForConversionResSchema = z.object({ symbol: z.array(LightSymbolSchema).default([]) });
export type LightSymbol = z.infer<typeof LightSymbolSchema>;

export const SymbolSchema = z.object({
  symbolId: int64,
  digits: z.number().int().nonnegative(),
  pipPosition: z.number().int(),
  maxVolume: int64.optional(),
  minVolume: int64.optional(),
  stepVolume: int64.optional(),
  lotSize: int64.optional(),
  slDistance: z.number().optional(),
  tpDistance: z.number().optional(),
  tradingMode: z.union([z.number(), z.string()]).optional(),
  enableShortSelling: z.boolean().optional(),
});
export const SymbolByIdResSchema = z.object({ symbol: z.array(SymbolSchema).default([]) });
export type ProtoSymbol = z.infer<typeof SymbolSchema>;

export const TrendbarSchema = z.object({
  volume: int64,
  period: TrendbarPeriodE.optional(),
  low: int64.optional(),
  deltaOpen: int64.optional(),
  deltaClose: int64.optional(),
  deltaHigh: int64.optional(),
  utcTimestampInMinutes: z.number().int().nonnegative().optional(),
});
export const TrendbarsResSchema = z.object({
  period: TrendbarPeriodE,
  trendbar: z.array(TrendbarSchema).default([]),
  symbolId: int64.optional(),
  hasMore: z.boolean().optional(),
});
export type ProtoTrendbar = z.infer<typeof TrendbarSchema>;

export const TradeDataSchema = z.object({
  symbolId: int64,
  volume: int64,
  tradeSide: TradeSideE,
  openTimestamp: int64.optional(),
  label: z.string().optional(),
  comment: z.string().optional(),
  closeTimestamp: int64.optional(),
});

export const PositionSchema = z.object({
  positionId: int64,
  tradeData: TradeDataSchema,
  positionStatus: PositionStatusE,
  swap: int64,
  price: z.number().optional(),
  stopLoss: z.number().optional(),
  takeProfit: z.number().optional(),
  utcLastUpdateTimestamp: int64.optional(),
  commission: int64.optional(),
  usedMargin: int64.optional(),
  moneyDigits: z.number().int().nonnegative().optional(),
  trailingStopLoss: z.boolean().optional(),
});
export type Position = z.infer<typeof PositionSchema>;

export const OrderSchema = z.object({
  orderId: int64,
  tradeData: TradeDataSchema,
  orderType: OrderTypeE,
  orderStatus: OrderStatusE,
  expirationTimestamp: int64.optional(),
  executionPrice: z.number().optional(),
  executedVolume: int64.optional(),
  utcLastUpdateTimestamp: int64.optional(),
  closingOrder: z.boolean().optional(),
  limitPrice: z.number().optional(),
  stopPrice: z.number().optional(),
  stopLoss: z.number().optional(),
  takeProfit: z.number().optional(),
  clientOrderId: z.string().optional(),
  positionId: int64.optional(),
  relativeStopLoss: int64.optional(),
  relativeTakeProfit: int64.optional(),
});
export type Order = z.infer<typeof OrderSchema>;

export const ClosePositionDetailSchema = z.object({
  entryPrice: z.number(),
  grossProfit: int64,
  swap: int64,
  commission: int64,
  balance: int64,
  quoteToDepositConversionRate: z.number().optional(),
  closedVolume: int64.optional(),
  moneyDigits: z.number().int().nonnegative().optional(),
  pnlConversionFee: int64.optional(),
});

export const DealSchema = z.object({
  dealId: int64,
  orderId: int64,
  positionId: int64,
  volume: int64,
  filledVolume: int64,
  symbolId: int64,
  createTimestamp: int64,
  executionTimestamp: int64,
  executionPrice: z.number().optional(),
  tradeSide: TradeSideE,
  dealStatus: z.union([z.number(), z.string()]),
  commission: int64.optional(),
  closePositionDetail: ClosePositionDetailSchema.optional(),
  moneyDigits: z.number().int().nonnegative().optional(),
});
export type Deal = z.infer<typeof DealSchema>;

export const ReconcileResSchema = z.object({
  ctidTraderAccountId: int64,
  position: z.array(PositionSchema).default([]),
  order: z.array(OrderSchema).default([]),
});
export type ReconcileRes = z.infer<typeof ReconcileResSchema>;

export const ExecutionEventSchema = z.object({
  ctidTraderAccountId: int64,
  executionType: ExecutionTypeE,
  position: PositionSchema.optional(),
  order: OrderSchema.optional(),
  deal: DealSchema.optional(),
  errorCode: z.string().optional(),
  isServerEvent: z.boolean().optional(),
});
export type ExecutionEvent = z.infer<typeof ExecutionEventSchema>;

export const SpotEventSchema = z.object({
  ctidTraderAccountId: int64,
  symbolId: int64,
  bid: int64.optional(),
  ask: int64.optional(),
  timestamp: int64.optional(),
});
export type SpotEvent = z.infer<typeof SpotEventSchema>;

export const UnrealizedPnlResSchema = z.object({
  positionUnrealizedPnL: z
    .array(z.object({ positionId: int64, grossUnrealizedPnL: int64, netUnrealizedPnL: int64 }))
    .default([]),
  moneyDigits: z.number().int().nonnegative(),
});

export const DealListResSchema = z.object({
  deal: z.array(DealSchema).default([]),
  hasMore: z.boolean().default(false),
});
