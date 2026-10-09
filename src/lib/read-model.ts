/**
 * The D1 read model's single write path.
 *
 * Two writers project committed events into D1: the Worker (inline, right
 * after an append, so reads usually see a write immediately) and the
 * StreamDO's outbox alarm (afterwards, so a failed inline write is always
 * repaired). Both go through this statement, and INSERT OR IGNORE keyed on
 * (stream_id, seq) makes every projection idempotent: the second writer to
 * arrive is a no-op, never a duplicate.
 */
export interface MirrorRow {
  seq: number;
  hash: string;
  prevHash: string;
  /** Canonical JSON of the authoritative payload; it hashes to `hash`. */
  canonicalPayload: string;
  createdAt: number;
}

export function mirrorStatement(
  db: D1Database,
  streamId: string,
  row: MirrorRow,
): D1PreparedStatement {
  return db
    .prepare(
      'INSERT OR IGNORE INTO events (stream_id, seq, hash, prev_hash, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .bind(
      streamId,
      row.seq,
      row.hash,
      row.prevHash,
      row.canonicalPayload,
      row.createdAt,
    );
}
