import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { EnvelopeSchema, type Envelope } from './schemas.js';

/**
 * Wire transport. The client only knows about envelopes
 * ({ payloadType, payload, clientMsgId }), so a Protobuf transport (port 5035)
 * can replace this one without touching the client or the tools.
 */
export interface Transport {
  connect(): Promise<void>;
  send(message: Envelope): void;
  close(): void;
  readonly isOpen: boolean;
  on(event: 'message', listener: (message: Envelope) => void): this;
  on(event: 'close', listener: (reason: string) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
}

export type TransportFactory = () => Transport;

export interface JsonWsTransportOptions {
  url: string;
  connectTimeoutMs?: number;
  wsOptions?: WebSocket.ClientOptions;
}

/** JSON over WebSocket (demo.ctraderapi.com:5036). */
export class JsonWsTransport extends EventEmitter implements Transport {
  private ws: WebSocket | undefined;

  constructor(private readonly opts: JsonWsTransportOptions) {
    super();
  }

  get isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.opts.url, { handshakeTimeout: this.opts.connectTimeoutMs ?? 10_000, ...this.opts.wsOptions });
      this.ws = ws;
      let opened = false;

      ws.on('open', () => {
        opened = true;
        resolve();
      });
      ws.on('message', (data) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(rawToString(data));
        } catch {
          this.emit('error', new Error('Received non-JSON frame'));
          return;
        }
        const env = EnvelopeSchema.safeParse(parsed);
        if (!env.success) {
          this.emit('error', new Error('Received frame without a valid envelope'));
          return;
        }
        this.emit('message', env.data);
      });
      ws.on('error', (err) => {
        if (!opened) reject(err);
        else this.emit('error', err);
      });
      ws.on('close', (code, reason) => {
        if (!opened) reject(new Error(`WebSocket closed before open (${code})`));
        this.emit('close', `ws closed (${code}${reason.length > 0 ? ` ${reason.toString()}` : ''})`);
      });
    });
  }

  send(message: Envelope): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) throw new Error('WebSocket is not open');
    this.ws.send(JSON.stringify(message));
  }

  close(): void {
    const ws = this.ws;
    if (!ws) return;
    if (ws.readyState === WebSocket.CONNECTING) ws.terminate();
    else ws.close(1000, 'client shutdown');
  }
}

function rawToString(data: WebSocket.RawData): string {
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data).toString('utf8');
}
