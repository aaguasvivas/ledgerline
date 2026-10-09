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
import {
  MAX_PAYLOAD_BYTES,
  assertIdempotencyKey,
  assertPayloadShape,
  readBodyText,
} from '../lib/validate';
import { log } from '../lib/log';
import { mirrorStatement } from '../lib/read-model';
import { streamStub } from '../do/stream';
import { renderLanding } from './landing';
import OG_IMAGE from './og.png';

/**
 * The Ledgerline HTTP API.
 *
 * The Worker is a stateless front door: it authenticates, routes to the
 * authoritative StreamDO, and projects confirmed writes into the D1 read model.
 * Ordering and integrity live in the Durable Object; D1 is an
 * eventually-consistent query side (CQRS).
 */
const app = new Hono<AppEnv>();

/** Landing page with the interactive chain demo: static, no server state. */
app.get('/', (c) => c.html(renderLanding(new URL(c.req.url).origin)));

/** The walkthrough used to live here; keep existing links working. */
app.get('/demo', (c) => c.redirect('/#tamper', 301));

/** Social preview card referenced by the landing page's Open Graph tags. */
app.get('/og.png', (c) =>
  c.body(OG_IMAGE, 200, {
    'Content-Type': 'image/png',
    'Cache-Control': 'public, max-age=86400',
  }),
);

/** Liveness probe: unauthenticated, no rate limit. */
app.get('/health', (c) => c.json({ status: 'ok' }));

// ---------------------------------------------------------------------------
// POST /v1/keys: admin-only key minting, guarded by ADMIN_SECRET.
// Not bearer-authed and not rate-limited (it predates any key).
// ---------------------------------------------------------------------------
app.post('/v1/keys', async (c) => {
  // Fail closed: rejects when the header is missing AND when ADMIN_SECRET is
  // not configured (otherwise undefined === undefined would open the endpoint).
  if (!verifyAdminSecret(c.req.header('X-Admin-Secret'), c.env.ADMIN_SECRET)) {
    throw new ApiError(403, 'forbidden', 'Invalid or missing admin secret');
  }

  // An empty body means "all defaults"; anything else must be a JSON object.
  // Silently defaulting a malformed body would mint a key the admin did not
  // ask for (wrong rate, no name).
  let body: { name?: unknown; rate_per_min?: unknown } = {};
  const raw = await readBodyText(c.req.raw, 4096);
  if (raw.trim() !== '') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = undefined;
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new ApiError(400, 'invalid_body', 'Request body must be a JSON object');
    }
    body = parsed as typeof body;
  }

  const name = typeof body.name === 'string' ? body.name : 'unnamed';
  if (name.length > 128) {
    throw new ApiError(400, 'invalid_name', 'name must be at most 128 characters');
  }

  // Missing rate defaults to 60; an explicitly provided rate must be a finite
  // positive integer; floor BEFORE validating so 0.5 cannot slip through as 0,
  // and non-finite values (JSON 1e999 parses to Infinity) get a 400, not a 500
  // from the D1 bind.
  let ratePerMin = 60;
  if (body.rate_per_min !== undefined) {
    const rate =
      typeof body.rate_per_min === 'number'
        ? Math.floor(body.rate_per_min)
        : NaN;
    if (!Number.isFinite(rate) || rate < 1) {
      throw new ApiError(
        400,
        'invalid_rate',
        'rate_per_min must be a positive integer',
      );
    }
    ratePerMin = rate;
  }

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
// /v1/streams: every route requires a valid bearer key and is rate-limited.
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
  // Unlike the event mirror, this insert IS load-bearing (ownership checks
  // read it), so a failure correctly fails the request. The client retries
  // with a fresh UUID; the first DO's meta record is orphaned, an accepted,
  // rare (~100-byte, infra-failure-only) cost of DO-first ordering, which is
  // the safer direction: the reverse order would leave an owned stream whose
  // authoritative state does not exist.
  await c.env.DB.prepare(
    'INSERT INTO streams (id, owner_key_hash, created_at) VALUES (?, ?, ?)',
  )
    .bind(id, c.get('keyHash'), Date.now())
    .run();
  return c.json({ id }, 201);
});

/**
 * POST /v1/streams/:id/events → append (idempotent by Idempotency-Key).
 *
 * 201 for a new event; 200 + `Idempotent-Replay: true` for a retry of the same
 * key and payload; 422 when the key is reused with a different payload, as the
 * IETF Idempotency-Key draft specifies.
 */
streams.post('/:id/events', async (c) => {
  const idempotencyKey = c.req.header('Idempotency-Key');
  if (!idempotencyKey) {
    throw new ApiError(
      400,
      'idempotency_key_required',
      'Idempotency-Key header is required',
    );
  }
  assertIdempotencyKey(idempotencyKey);

  const id = c.req.param('id');
  await requireOwnedStream(c, id);

  const raw = await readBodyText(c.req.raw, MAX_PAYLOAD_BYTES);

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new ApiError(400, 'invalid_payload', 'Request body must be valid JSON');
  }
  assertPayloadShape(payload);

  const result = await streamStub(c.env, id).append(payload, idempotencyKey);
  if (result.status === 'conflict') {
    throw new ApiError(
      422,
      'idempotency_key_reused',
      `Idempotency-Key was already used for seq ${result.seq} with a different payload`,
    );
  }

  // Fast-path projection into the D1 read model, so a read right after this
  // write usually sees it. The DO commit above is durable and authoritative,
  // and its outbox alarm guarantees delivery to D1 regardless, so a failure
  // here must not fail the request: the client would never learn the
  // {seq, hash} of an event that exists.
  try {
    await mirrorStatement(c.env.DB, id, result).run();
  } catch (err) {
    log.warn('mirror_deferred', {
      streamId: id,
      seq: result.seq,
      message: err instanceof Error ? err.message : String(err),
    });
  }

  const replayed = result.status === 'replayed';
  if (replayed) c.header('Idempotent-Replay', 'true');
  return c.json({ seq: result.seq, hash: result.hash }, replayed ? 200 : 201);
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

  // seq is gap-free at the authority, so a hole here is an event D1 has not
  // received yet. End the page before it: a reader whose cursor moved past the
  // hole would never see that event, even after the outbox fills it.
  const contiguous: typeof results = [];
  for (const r of results) {
    if (r.seq !== after + contiguous.length + 1) break;
    contiguous.push(r);
  }

  const events = contiguous.map((r) => ({
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
// Error handling: uniform JSON envelopes.
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

/**
 * Parse an integer query param, falling back to a default. Number() rather
 * than parseInt(): "1e3" is 1000, not 1, and any trailing garbage ("12abc")
 * is rejected wholesale instead of silently truncated.
 */
function toInt(value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  return Number.isInteger(n) ? n : fallback;
}

export { app };
