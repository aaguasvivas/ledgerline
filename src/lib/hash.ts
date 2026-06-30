/**
 * Hash-chain primitives.
 *
 * Ledgerline's tamper-evidence comes from a SHA-256 hash chain over canonical
 * JSON. The rules are fixed and versioned so the chain can always be recomputed
 * and audited independently:
 *
 *   canonical JSON = object keys sorted recursively, no whitespace
 *   hash_0 (genesis) = SHA-256("ledgerline:v1:" + streamId)
 *   hash_n           = SHA-256(hash_{n-1} + "|" + canonicalJSON(payload_n) + "|" + seq_n)
 *
 * Every value is hex-encoded, lowercase.
 */

/** Domain-separation prefix; bump the version if the chain rules ever change. */
const GENESIS_PREFIX = 'ledgerline:v1:';

/**
 * Serialize a JSON value to its canonical string form: object keys sorted
 * recursively, arrays left in order, no insignificant whitespace. Two values
 * that are deeply equal as JSON always produce the same string, so the hash is
 * independent of key insertion order.
 */
export function canonicalize(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

/** Recursively rebuild a value with object keys in sorted order. */
function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortDeep);
  }
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      sorted[key] = sortDeep(source[key]);
    }
    return sorted;
  }
  return value;
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
