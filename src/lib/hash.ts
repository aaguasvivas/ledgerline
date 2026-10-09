/**
 * Hash-chain primitives.
 *
 * Ledgerline's tamper-evidence comes from a SHA-256 hash chain over canonical
 * JSON. The rules are fixed and versioned so the chain can always be recomputed
 * and audited independently:
 *
 *   canonical JSON   = RFC 8785 (JSON Canonicalization Scheme)
 *   hash_0 (genesis) = SHA-256("ledgerline:v1:" + streamId)
 *   hash_n           = SHA-256(hash_{n-1} + "|" + canonicalJSON(payload_n) + "|" + seq_n)
 *
 * Every value is hex-encoded, lowercase.
 */

/** Domain-separation prefix; bump the version if the chain rules ever change. */
const GENESIS_PREFIX = 'ledgerline:v1:';

/**
 * Serialize JSON data (as produced by JSON.parse) to its RFC 8785 canonical
 * form: object members sorted by key in UTF-16 code-unit order, arrays left in
 * order, no insignificant whitespace, and strings and numbers formatted as
 * ECMAScript's JSON.stringify formats them (which is what RFC 8785 specifies).
 * Two values that are deeply equal as JSON always produce the same string, so
 * the hash is independent of how a client happened to order its keys.
 *
 * Members are emitted explicitly rather than by stringifying a re-sorted
 * object. Engines enumerate integer-like keys ("1", "10") before all others,
 * in numeric order, whatever order they were inserted in, so a sorted rebuild
 * still serializes {"9","10"} as 9-then-10 where RFC 8785 requires "10" first.
 * Reading `source[key]` per own key also keeps an own "__proto__" property
 * (which JSON.parse can create) as ordinary data.
 */
export function canonicalize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const members = Object.keys(source)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalize(source[key])}`);
    return `{${members.join(',')}}`;
  }
  return JSON.stringify(value);
}

/** SHA-256 of a UTF-8 string, returned as lowercase hex. */
export async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return toHex(new Uint8Array(digest));
}

/** Genesis hash for a stream: SHA-256("ledgerline:v1:" + streamId). */
export function genesisHash(streamId: string): Promise<string> {
  return sha256Hex(GENESIS_PREFIX + streamId);
}

/**
 * Next link in the chain:
 *   SHA-256(prevHash + "|" + canonicalJSON(payload) + "|" + seq)
 */
export function nextHash(
  prevHash: string,
  payload: unknown,
  seq: number,
): Promise<string> {
  return sha256Hex(`${prevHash}|${canonicalize(payload)}|${seq}`);
}

/** Encode bytes as lowercase hex. */
function toHex(bytes: Uint8Array): string {
  let hex = '';
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, '0');
  }
  return hex;
}
