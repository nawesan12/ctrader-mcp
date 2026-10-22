import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import type { DB } from './database.js';

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  /** Unix ms when the access token expires, if known. */
  expiresAt?: number;
}

const KEY_CONTEXT = 'ctrader-mcp/token-store/v1';

/**
 * Persists the OAuth token pair encrypted with AES-256-GCM. The key is derived
 * with scrypt from CTRADER_CLIENT_SECRET and a random per-record salt.
 *
 * Source-of-truth rule: the env tokens only bootstrap an empty store. Once a
 * pair is stored (e.g. after a refresh, which invalidates the old pair), the
 * stored pair wins.
 */
export class TokenStore {
  constructor(
    private readonly db: DB,
    private readonly secret: string,
  ) {
    if (secret.length === 0) throw new Error('TokenStore needs a non-empty secret');
  }

  load(): TokenPair | undefined {
    const row = this.db.prepare('SELECT salt, iv, tag, ciphertext FROM tokens WHERE id = 1').get() as
      | { salt: Buffer; iv: Buffer; tag: Buffer; ciphertext: Buffer }
      | undefined;
    if (!row) return undefined;
    const decipher = createDecipheriv('aes-256-gcm', this.key(row.salt), row.iv);
    decipher.setAuthTag(row.tag);
    const plain = Buffer.concat([decipher.update(row.ciphertext), decipher.final()]).toString('utf8');
    return JSON.parse(plain) as TokenPair;
  }

  save(pair: TokenPair): void {
    const salt = randomBytes(16);
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key(salt), iv);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(pair), 'utf8'), cipher.final()]);
    this.db
      .prepare(
        `INSERT INTO tokens (id, salt, iv, tag, ciphertext, updated_at) VALUES (1, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET salt = excluded.salt, iv = excluded.iv, tag = excluded.tag,
           ciphertext = excluded.ciphertext, updated_at = excluded.updated_at`,
      )
      .run(salt, iv, cipher.getAuthTag(), ciphertext, new Date().toISOString());
  }

  /** Stored pair if any, otherwise bootstrap from env values (and persist them). */
  loadOrBootstrap(envPair: { accessToken?: string | undefined; refreshToken?: string | undefined }): TokenPair {
    const stored = this.load();
    if (stored) return stored;
    if (!envPair.accessToken || !envPair.refreshToken) {
      throw new Error('No stored tokens and CTRADER_ACCESS_TOKEN / CTRADER_REFRESH_TOKEN are not set');
    }
    const pair = { accessToken: envPair.accessToken, refreshToken: envPair.refreshToken };
    this.save(pair);
    return pair;
  }

  private key(salt: Buffer): Buffer {
    return scryptSync(this.secret, Buffer.concat([Buffer.from(KEY_CONTEXT), salt]), 32);
  }
}
