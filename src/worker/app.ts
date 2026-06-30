import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppEnv } from '../lib/auth';
import {
  authenticate,
  generateApiKey,
  hashApiKey,
  verifyAdminSecret,
} from '../lib/auth';
import { rateLimit } from '../lib/rate-limit';
import { ApiError, errorBody } from '../lib/errors';
import { log } from '../lib/log';
import { streamStub } from '../do/stream';
import { LANDING_HTML } from './landing';

/**
 * The Ledgerline HTTP API.
 *
 * The Worker is a stateless front door: it authenticates, routes to the
 * authoritative StreamDO, and projects confirmed writes into the D1 read model.
 * Ordering and integrity live in the Durable Object; D1 is an
 * eventually-consistent query side (CQRS).
 */
const app = new Hono<AppEnv>();

/** Tiny static landing page. */
app.get('/', (c) => c.html(LANDING_HTML));

/** Liveness probe — unauthenticated, no rate limit. */
app.get('/health', (c) => c.json({ status: 'ok' }));

// ---------------------------------------------------------------------------
// POST /v1/keys — admin-only key minting, guarded by ADMIN_SECRET.
// Not bearer-authed and not rate-limited (it predates any key).
// ---------------------------------------------------------------------------
app.post('/v1/keys', async (c) => {
  // Fail closed: rejects when the header is missing AND when ADMIN_SECRET is
  // not configured (otherwise undefined === undefined would open the endpoint).
  if (!verifyAdminSecret(c.req.header('X-Admin-Secret'), c.env.ADMIN_SECRET)) {
    throw new ApiError(403, 'forbidden', 'Invalid or missing admin secret');
  }

  let body: { name?: unknown; rate_per_min?: unknown } = {};
  try {
    body = await c.req.json();
  } catch {
    // Empty/invalid body is fine — fall back to defaults.
  }

  const name = typeof body.name === 'string' ? body.name : 'unnamed';
  const ratePerMin =
    typeof body.rate_per_min === 'number' && body.rate_per_min > 0
      ? Math.floor(body.rate_per_min)
      : 60;

  const rawKey = generateApiKey();
  const keyHash = await hashApiKey(rawKey);
  await c.env.DB.prepare(
    'INSERT INTO api_keys (key_hash, name, rate_per_min, created_at) VALUES (?, ?, ?, ?)',
  )
    .bind(keyHash, name, ratePerMin, Date.now())
    .run();

  log.info('key_minted', { name, ratePerMin });
  // The raw key is returned exactly once and never stored in the clear.
  return c.json({ key: rawKey, name, rate_per_min: ratePerMin }, 201);
});

// ---------------------------------------------------------------------------
// /v1/streams — every route requires a valid bearer key and is rate-limited.
// ---------------------------------------------------------------------------
const streams = new Hono<AppEnv>();
streams.use('*', authenticate);
streams.use('*', rateLimit);

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
      // The DO returns the authoritative canonical payload (the original event
      // on a replay), so the stored payload always hashes to result.hash.
      result.canonicalPayload,
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
  log.error('unhandled_error', {
    message: err instanceof Error ? err.message : String(err),
  });
  return c.json(errorBody('internal_error', 'Internal server error'), 500);
});

/** Parse an integer query param, falling back to a default. */
function toInt(value: string | undefined, fallback: number): number {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isNaN(n) ? fallback : n;
}

export { app };
