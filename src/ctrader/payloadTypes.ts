/**
 * Payload type ids, copied from the official proto definitions
 * (github.com/spotware/openapi-proto-messages: OpenApiCommonModelMessages.proto,
 * OpenApiModelMessages.proto). Only the ones this project uses.
 */
export const PT = {
  // ProtoPayloadType (common)
  ERROR_RES: 50,
  HEARTBEAT_EVENT: 51,

  // ProtoOAPayloadType
  APPLICATION_AUTH_REQ: 2100,
  APPLICATION_AUTH_RES: 2101,
  ACCOUNT_AUTH_REQ: 2102,
  ACCOUNT_AUTH_RES: 2103,
  NEW_ORDER_REQ: 2106,
  CANCEL_ORDER_REQ: 2108,
  AMEND_ORDER_REQ: 2109,
  AMEND_POSITION_SLTP_REQ: 2110,
  CLOSE_POSITION_REQ: 2111,
  ASSET_LIST_REQ: 2112,
  ASSET_LIST_RES: 2113,
  SYMBOLS_LIST_REQ: 2114,
  SYMBOLS_LIST_RES: 2115,
  SYMBOL_BY_ID_REQ: 2116,
  SYMBOL_BY_ID_RES: 2117,
  SYMBOLS_FOR_CONVERSION_REQ: 2118,
  SYMBOLS_FOR_CONVERSION_RES: 2119,
  SYMBOL_CHANGED_EVENT: 2120,
  TRADER_REQ: 2121,
  TRADER_RES: 2122,
  TRADER_UPDATE_EVENT: 2123,
  RECONCILE_REQ: 2124,
  RECONCILE_RES: 2125,
  EXECUTION_EVENT: 2126,
  SUBSCRIBE_SPOTS_REQ: 2127,
  SUBSCRIBE_SPOTS_RES: 2128,
  UNSUBSCRIBE_SPOTS_REQ: 2129,
  UNSUBSCRIBE_SPOTS_RES: 2130,
  SPOT_EVENT: 2131,
  ORDER_ERROR_EVENT: 2132,
  DEAL_LIST_REQ: 2133,
  DEAL_LIST_RES: 2134,
  GET_TRENDBARS_REQ: 2137,
  GET_TRENDBARS_RES: 2138,
  OA_ERROR_RES: 2142,
  CASH_FLOW_HISTORY_LIST_REQ: 2143,
  GET_TICKDATA_REQ: 2145,
  ACCOUNTS_TOKEN_INVALIDATED_EVENT: 2147,
  CLIENT_DISCONNECT_EVENT: 2148,
  GET_ACCOUNTS_BY_ACCESS_TOKEN_REQ: 2149,
  GET_ACCOUNTS_BY_ACCESS_TOKEN_RES: 2150,
  ACCOUNT_DISCONNECT_EVENT: 2164,
  REFRESH_TOKEN_REQ: 2173,
  REFRESH_TOKEN_RES: 2174,
  ORDER_LIST_REQ: 2175,
  DEAL_LIST_BY_POSITION_ID_REQ: 2179,
  DEAL_LIST_BY_POSITION_ID_RES: 2180,
  ORDER_DETAILS_REQ: 2181,
  ORDER_DETAILS_RES: 2182,
  ORDER_LIST_BY_POSITION_ID_REQ: 2183,
  DEAL_OFFSET_LIST_REQ: 2185,
  GET_POSITION_UNREALIZED_PNL_REQ: 2187,
  GET_POSITION_UNREALIZED_PNL_RES: 2188,
} as const;

export type PayloadType = (typeof PT)[keyof typeof PT];

/**
 * Requests counted against the "historical data" limit (5 req/s per connection).
 * The docs do not publish an exhaustive list; these are the requests whose docs
 * describe them as historical data. See docs/DECISIONS.md.
 */
export const HISTORICAL_REQUESTS: ReadonlySet<number> = new Set([
  PT.GET_TRENDBARS_REQ,
  PT.GET_TICKDATA_REQ,
  PT.DEAL_LIST_REQ,
  PT.CASH_FLOW_HISTORY_LIST_REQ,
  PT.ORDER_LIST_REQ,
  PT.DEAL_LIST_BY_POSITION_ID_REQ,
  PT.ORDER_LIST_BY_POSITION_ID_REQ,
  PT.DEAL_OFFSET_LIST_REQ,
]);

/** ProtoOAErrorCode values (strings on the wire) that mean the access token must be refreshed. */
export const TOKEN_ERROR_CODES: ReadonlySet<string> = new Set(['OA_AUTH_TOKEN_EXPIRED', 'CH_ACCESS_TOKEN_INVALID']);

/** Protocol enums (numeric values from the proto files). */
export const TradeSide = { BUY: 1, SELL: 2 } as const;
export const OrderType = { MARKET: 1, LIMIT: 2, STOP: 3, STOP_LOSS_TAKE_PROFIT: 4, MARKET_RANGE: 5, STOP_LIMIT: 6 } as const;
export const OrderStatus = { ACCEPTED: 1, FILLED: 2, REJECTED: 3, EXPIRED: 4, CANCELLED: 5 } as const;
export const PositionStatus = { OPEN: 1, CLOSED: 2, CREATED: 3, ERROR: 4 } as const;
export const TimeInForce = { GOOD_TILL_DATE: 1, GOOD_TILL_CANCEL: 2, IMMEDIATE_OR_CANCEL: 3, FILL_OR_KILL: 4, MARKET_ON_OPEN: 5 } as const;
export const ExecutionType = {
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
} as const;
export const TrendbarPeriod = {
  M1: 1, M2: 2, M3: 3, M4: 4, M5: 5, M10: 6, M15: 7, M30: 8, H1: 9, H4: 10, H12: 11, D1: 12, W1: 13, MN1: 14,
} as const;
export type Timeframe = keyof typeof TrendbarPeriod;
