import { ApiError } from './errors';

/**
 * Request-input limits. These are explicit product limits, deliberately far
 * below any platform ceiling (DO storage values, D1 rows, RPC frames), so an
 * oversized request always fails as a clean typed 4xx at the edge, never as an
 * opaque 500 from a storage layer deep inside a Durable Object.
 */
export const MAX_PAYLOAD_BYTES = 262_144; // 256 KiB
export const MAX_PAYLOAD_DEPTH = 64;
export const MAX_IDEMPOTENCY_KEY_LENGTH = 256;

/**
 * Read a request body as UTF-8 text without ever buffering more than
 * `maxBytes`. A declared Content-Length over the cap is refused before reading;
 * a body without one (chunked) is counted as it streams and abandoned the
 * moment it crosses the cap. Bytes that are not valid UTF-8 are refused rather
 * than silently replaced, so what gets hashed is exactly what the client sent.
 */
export async function readBodyText(
  req: Request,
  maxBytes: number,
): Promise<string> {
  const tooLarge = () =>
    new ApiError(413, 'payload_too_large', `Payload exceeds ${maxBytes} bytes`);

  if (Number(req.headers.get('Content-Length')) > maxBytes) throw tooLarge();
  if (!req.body) return '';

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw tooLarge();
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    throw new ApiError(400, 'invalid_payload', 'Request body must be UTF-8');
  }
}

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
 * A lone UTF-16 surrogate in u-mode: a well-formed pair matches as one astral
 * code point, so only unpaired halves hit General_Category=Surrogate.
 */
const LONE_SURROGATE = /\p{Cs}/u;

/**
 * Validate a parsed JSON payload before it reaches the hashing/storage path:
 * - nesting depth is capped (the recursive canonicalizer must never be the
 *   place a pathological input blows the call stack),
 * - numbers must be finite (JSON grammar allows 1e999, which JSON.parse turns
 *   into Infinity and JSON.stringify would silently serialize as null, a
 *   type-changing mutation and a hash collision with a literal null), and
 * - strings and keys must be valid Unicode. JSON escapes can smuggle in an
 *   unpaired surrogate ("\ud800"), which I-JSON (RFC 7493) forbids and which
 *   has no RFC 8785 canonical form, so external verifiers could not agree on
 *   its bytes.
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
  if (typeof value === 'string') {
    assertWellFormed(value);
  } else if (Array.isArray(value)) {
    for (const item of value) assertPayloadShape(item, depth + 1);
  } else if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    for (const key of Object.keys(source)) {
      assertWellFormed(key);
      assertPayloadShape(source[key], depth + 1);
    }
  }
}

function assertWellFormed(text: string): void {
  if (LONE_SURROGATE.test(text)) {
    throw new ApiError(
      400,
      'invalid_payload',
      'Payload strings must be valid Unicode (no unpaired surrogates)',
    );
  }
}
