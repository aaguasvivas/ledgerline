import { ApiError } from './errors';

/**
 * Request-input limits. These are explicit product limits, deliberately far
 * below any platform ceiling (DO storage values, D1 rows, RPC frames), so an
 * oversized request always fails as a clean typed 4xx at the edge — never as an
 * opaque 500 from a storage layer deep inside a Durable Object.
 */
export const MAX_PAYLOAD_BYTES = 262_144; // 256 KiB
export const MAX_PAYLOAD_DEPTH = 64;
export const MAX_IDEMPOTENCY_KEY_LENGTH = 256;

/** Validate an Idempotency-Key header value (presence is checked separately). */
export function assertIdempotencyKey(key: string): void {
  if (key.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    throw new ApiError(
      400,
      'idempotency_key_invalid',
      `Idempotency-Key must be at most ${MAX_IDEMPOTENCY_KEY_LENGTH} characters`,
    );
  }
}

/**
 * Validate a parsed JSON payload before it reaches the hashing/storage path:
 * - nesting depth is capped (the recursive canonicalizer must never be the
 *   place a pathological input blows the call stack), and
 * - numbers must be finite (JSON grammar allows 1e999, which JSON.parse turns
 *   into Infinity and JSON.stringify would silently serialize as null — a
 *   type-changing mutation and a hash collision with a literal null).
 */
export function assertPayloadShape(value: unknown, depth = 0): void {
  if (depth > MAX_PAYLOAD_DEPTH) {
    throw new ApiError(
      400,
      'payload_too_deep',
      `Payload nesting exceeds ${MAX_PAYLOAD_DEPTH} levels`,
    );
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new ApiError(
      400,
      'invalid_payload',
      'Payload numbers must be finite (value overflows IEEE-754 double range)',
    );
  }
  if (Array.isArray(value)) {
    for (const item of value) assertPayloadShape(item, depth + 1);
  } else if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    for (const key of Object.keys(source)) {
      assertPayloadShape(source[key], depth + 1);
    }
  }
}
