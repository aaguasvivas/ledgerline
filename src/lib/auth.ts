import type { Context, Next } from 'hono';
import type { Env } from '../types';
import { sha256Hex } from './hash';
import { ApiError } from './errors';

/** Context variables set by the auth middleware for downstream handlers. */
export interface Vars {
  keyHash: string;
  keyName: string;
  ratePerMin: number;
}

/** Hono environment shared across the worker. */
export type AppEnv = { Bindings: Env; Variables: Vars };

const KEY_PREFIX = 'lk_';

/** Hash an API key for storage/lookup. Keys are never stored in the clear. */
export function hashApiKey(rawKey: string): Promise<string> {
  return sha256Hex(rawKey);
}

/** Generate a fresh, high-entropy API key (192 bits, hex, `lk_` prefixed). */
export function generateApiKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  let hex = '';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  return KEY_PREFIX + hex;
}

/** Length-checked, constant-time string comparison (no early exit on mismatch). */
function timingSafeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  if (ea.length !== eb.length) return false;
  let diff = 0;
  for (let i = 0; i < ea.length; i++) diff |= ea[i] ^ eb[i];
  return diff === 0;
}

/**
 * Validate an admin secret. Fails closed: returns false when the expected
 * secret is unconfigured or the provided one is missing, and otherwise compares
 * in constant time.
 */
export function verifyAdminSecret(
  provided: string | undefined,
  expected: string | undefined,
): boolean {
  if (!expected || !provided) return false;
  return timingSafeEqual(provided, expected);
}

interface ApiKeyRow {
  key_hash: string;
  name: string;
  rate_per_min: number;
}

/**
 * Bearer-token auth middleware. Resolves `Authorization: Bearer <key>` to a
 * stored key by SHA-256 hash and exposes the key's identity + rate limit to
 * downstream handlers. Rejects missing or unknown keys with 401.
 */
export async function authenticate(
  c: Context<AppEnv>,
  next: Next,
): Promise<void> {
  const header = c.req.header('Authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) {
    throw new ApiError(
      401,
      'unauthorized',
      'Missing or malformed Authorization header',
    );
  }

  const keyHash = await hashApiKey(token);
  const row = await c.env.DB.prepare(
    'SELECT key_hash, name, rate_per_min FROM api_keys WHERE key_hash = ?',
  )
    .bind(keyHash)
    .first<ApiKeyRow>();

  if (!row) {
    throw new ApiError(401, 'unauthorized', 'Invalid API key');
  }

  c.set('keyHash', row.key_hash);
  c.set('keyName', row.name);
  c.set('ratePerMin', row.rate_per_min);
  await next();
}
