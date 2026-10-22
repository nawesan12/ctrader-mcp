/** Typed errors surfaced by the cTrader client. */

export class CTraderError extends Error {
  override name = 'CTraderError';
}

/** ProtoOAErrorRes (2142), ProtoErrorRes (50) or ProtoOAOrderErrorEvent (2132). */
export class CTraderApiError extends CTraderError {
  override name = 'CTraderApiError';
  constructor(
    readonly source: 'ProtoOAErrorRes' | 'ProtoErrorRes' | 'ProtoOAOrderErrorEvent',
    readonly errorCode: string,
    readonly description?: string,
    readonly extra: { retryAfter?: number; maintenanceEndTimestamp?: number; orderId?: number; positionId?: number } = {},
  ) {
    super(`${source} ${errorCode}${description ? `: ${description}` : ''}`);
  }
}

export class CTraderTimeoutError extends CTraderError {
  override name = 'CTraderTimeoutError';
  constructor(
    readonly payloadType: number,
    readonly timeoutMs: number,
  ) {
    super(`Request ${payloadType} timed out after ${timeoutMs} ms`);
  }
}

export class CTraderDisconnectedError extends CTraderError {
  override name = 'CTraderDisconnectedError';
  /**
   * true when the request had already been written to the socket: the broker
   * may have received it, so the outcome is unknown (never blindly retry).
   */
  readonly sent: boolean;
  constructor(reason = 'connection closed', sent = false) {
    super(`cTrader connection unavailable: ${reason}`);
    this.sent = sent;
  }
}

/** The broker answered with something that does not match the expected schema/type. */
export class CTraderProtocolError extends CTraderError {
  override name = 'CTraderProtocolError';
}

/** Fatal: the configured account is live (or unknown). The process must stop. */
export class LiveAccountError extends CTraderError {
  override name = 'LiveAccountError';
}
