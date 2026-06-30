import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppEnv } from '../lib/auth';
import { authenticate } from '../lib/auth';
import { ApiError, errorBody } from '../lib/errors';
import { canonicalize } from '../lib/hash';
import { streamStub } from '../do/stream';

/**
 * The Ledgerline HTTP API.
 *
 * The Worker is a stateless front door: it authenticates, routes to the
 * authoritative StreamDO, and projects confirmed writes into the D1 read model.
 * Ordering and integrity live in the Durable Object; D1 is an
 * eventually-consistent query side (CQRS).
 */
const app = new Hono<AppEnv>();

/** Liveness probe — unauthenticated, no rate limit. */
app.get('/health', (c) => c.json({ status: 'ok' }));

// ---------------------------------------------------------------------------
// /v1/streams — every route requires a valid bearer key.
// ---------------------------------------------------------------------------
const streams = new Hono<AppEnv>();
streams.use('*', authenticate);

/** Throw 404 (not 403) unless the authenticated key owns the stream. */
async function requireOwnedStream(c: Context<AppEnv>, id: string): Promise<void> {
  const row = await c.env.DB.prepare(
    'SELECT owner_key_hash FROM streams WHERE id = ?',
  )
    .bind(id)
    .first<{ owner_key_hash: string }>();

  if (!row || row.owner_key_hash !== c.get('keyHash')) {
    throw new ApiError(404, 'stream_not_found', 'Stream not found');
  }
}

/** POST /v1/streams → create a stream. */
streams.post('/', async (c) => {
  const id = crypto.randomUUID();
  await streamStub(c.env, id).create(id);
  await c.env.DB.prepare(
    'INSERT INTO streams (id, owner_key_hash, created_at) VALUES (?, ?, ?)',
  )
    .bind(id, c.get('keyHash'), Date.now())
    .run();
  return c.json({ id }, 201);
});

/** POST /v1/streams/:id/events → append (idempotent by Idempotency-Key). */
streams.post('/:id/events', async (c) => {
  const idempotencyKey = c.req.header('Idempotency-Key');
  if (!idempotencyKey) {
    throw new ApiError(
      400,
      'idempotency_key_required',
      'Idempotency-Key header is required',
    );
  }

  const id = c.req.param('id');
  await requireOwnedStream(c, id);

  let payload: unknown;
  try {
    payload = await c.req.json();
  } catch {
    throw new ApiError(400, 'invalid_payload', 'Request body must be valid JSON');
  }

  const result = await streamStub(c.env, id).append(payload, idempotencyKey);

  // Project to the D1 read model. INSERT OR IGNORE makes this idempotent: an
  // idempotent replay (or a retried request after a prior mirror failure) is a
  // no-op or a self-heal, never a duplicate.
  await c.env.DB.prepare(
    'INSERT OR IGNORE INTO events (stream_id, seq, hash, prev_hash, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  )
    .bind(
      id,
      result.seq,
      result.hash,
      result.prevHash,
      canonicalize(payload),
      result.createdAt,
    )
    .run();

  if (result.replay) c.header('Idempotent-Replay', 'true');
  return c.json({ seq: result.seq, hash: result.hash }, result.replay ? 200 : 201);
});

/** GET /v1/streams/:id/events → paginated events from D1. */
streams.get('/:id/events', async (c) => {
  const id = c.req.param('id');
  await requireOwnedStream(c, id);

  const after = Math.max(0, toInt(c.req.query('after'), 0));
  const limit = Math.min(200, Math.max(1, toInt(c.req.query('limit'), 50)));

  const { results } = await c.env.DB.prepare(
    'SELECT seq, hash, prev_hash, payload, created_at FROM events WHERE stream_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?',
  )
    .bind(id, after, limit)
    .all<{
      seq: number;
      hash: string;
      prev_hash: string;
      payload: string;
      created_at: number;
    }>();

  const events = results.map((r) => ({
    seq: r.seq,
    hash: r.hash,
    prevHash: r.prev_hash,
    payload: JSON.parse(r.payload),
    createdAt: r.created_at,
  }));
  const nextAfter =
    events.length === limit ? events[events.length - 1].seq : null;

  return c.json({ events, nextAfter });
});

/** GET /v1/streams/:id/head → O(1) count + head hash from the DO. */
streams.get('/:id/head', async (c) => {
  const id = c.req.param('id');
  await requireOwnedStream(c, id);
  return c.json(await streamStub(c.env, id).head());
});

/** GET /v1/streams/:id/stats → total + per-minute rollups from the DO. */
streams.get('/:id/stats', async (c) => {
  const id = c.req.param('id');
  await requireOwnedStream(c, id);
  return c.json(await streamStub(c.env, id).stats());
});

/** GET /v1/streams/:id/verify → recompute the chain authoritatively. */
streams.get('/:id/verify', async (c) => {
  const id = c.req.param('id');
  await requireOwnedStream(c, id);
  return c.json(await streamStub(c.env, id).verify());
});

app.route('/v1/streams', streams);

// ---------------------------------------------------------------------------
// Error handling — uniform JSON envelopes.
// ---------------------------------------------------------------------------
app.notFound((c) => c.json(errorBody('not_found', 'Not found'), 404));

app.onError((err, c) => {
  if (err instanceof ApiError) {
    return c.json(errorBody(err.code, err.message), err.status);
  }
  console.error('unhandled_error', err);
  return c.json(errorBody('internal_error', 'Internal server error'), 500);
});

/** Parse an integer query param, falling back to a default. */
function toInt(value: string | undefined, fallback: number): number {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isNaN(n) ? fallback : n;
}

export { app };
