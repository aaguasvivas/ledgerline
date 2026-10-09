/**
 * Hash-chain primitives.
 *
 * Ledgerline's tamper-evidence comes from a SHA-256 hash chain over canonical
 * JSON. The rules are fixed and versioned so a chain can always be recomputed
 * and audited independently (v2, current):
 *
 *   canonical JSON   = RFC 8785 (JSON Canonicalization Scheme)
 *   hash_0 (genesis) = SHA-256("ledgerline:v2:" + streamId)
 *   hash_n           = SHA-256(hash_{n-1} + "|" + canonicalJSON(payload_n) + "|" + seq_n)
 *
 * Every value is hex-encoded, lowercase. A stream records the version it was
 * created under and keeps it for life, so a rule change never re-judges
 * existing history: v1 streams keep appending and verifying under v1 rules.
 */

/**
 * Chain-rule versions.
 * - 1: canonical form built by re-sorting object keys and calling
 *   JSON.stringify. Engines enumerate integer-like keys ("1", "10") first, in
 *   numeric order, so it diverges from RFC 8785 for such keys.
 * - 2: RFC 8785 canonical form. The genesis prefix carries the version, so a
 *   v1 and a v2 chain can never be mistaken for one another.
 */
export type ChainVersion = 1 | 2;

/** The version new streams are created under. */
export const CHAIN_VERSION: ChainVersion = 2;

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

/**
 * The v1 canonical form, kept so streams created under v1 keep verifying.
 * Do not use for new chains: see ChainVersion.
 */
export function canonicalizeV1(value: unknown): string {
  return JSON.stringify(sortDeepV1(value));
}

function sortDeepV1(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeepV1);
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    // Null prototype, so an own "__proto__" key stays an ordinary property.
    const sorted = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(source).sort()) {
      sorted[key] = sortDeepV1(source[key]);
    }
    return sorted;
  }
  return value;
}

/** The canonical form a chain version hashes (and stores in the read model). */
export function canonicalizeFor(version: ChainVersion): (value: unknown) => string {
  return version === 1 ? canonicalizeV1 : canonicalize;
}

/** SHA-256 of a UTF-8 string, returned as lowercase hex. */
export async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return toHex(new Uint8Array(digest));
}

/** Genesis hash for a stream: SHA-256("ledgerline:v<version>:" + streamId). */
export function genesisHash(
  streamId: string,
  version: ChainVersion = CHAIN_VERSION,
): Promise<string> {
  return sha256Hex(`ledgerline:v${version}:${streamId}`);
}

/**
 * Next link in the chain:
 *   SHA-256(prevHash + "|" + canonicalJSON(payload) + "|" + seq)
 * with the canonical form of the given chain version.
 */
export function nextHash(
  prevHash: string,
  payload: unknown,
  seq: number,
  version: ChainVersion = CHAIN_VERSION,
): Promise<string> {
  return sha256Hex(`${prevHash}|${canonicalizeFor(version)(payload)}|${seq}`);
}

/** Encode bytes as lowercase hex. */
function toHex(bytes: Uint8Array): string {
  let hex = '';
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, '0');
  }
  return hex;
}
