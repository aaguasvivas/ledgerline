# Ledgerline

**An append-only log that can prove its own history.** Event streams with exactly-once writes, gap-free ordering, and a tamper-evident SHA-256 hash chain, running at the edge on Cloudflare Workers and Durable Objects.

[![CI](https://github.com/aaguasvivas/ledgerline/actions/workflows/ci.yml/badge.svg)](https://github.com/aaguasvivas/ledgerline/actions/workflows/ci.yml)
![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white)
![TypeScript strict](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)
![License](https://img.shields.io/badge/license-MIT-blue)

**Live:** [ledgerline.adelsonaguasvivas.workers.dev](https://ledgerline.adelsonaguasvivas.workers.dev): try to tamper with a real hash chain and watch `verify` catch you, in your browser.

![Append, replay the same Idempotency-Key, verify the chain](docs/demo.gif)

Exactly-once in one screen: the retried `Idempotency-Key` returns the original `{seq, hash}` with `Idempotent-Replay: true` and no second event, then one call verifies the whole hash chain.

---

## What & why

Ledgerline is the integrity core behind ledgers, audit trails, and event-sourced systems, exposed as a small HTTP API. It provides three guarantees that are each easy to claim and collectively the hard part of any append-only system:

1. **Exactly-once appends.** Every write carries an `Idempotency-Key`, recorded in the same atomic write as the event. A retry gets the *original* result back and never creates a second event; reusing a key with a *different* body is refused with `422`, so a client bug can't masquerade as a success.
2. **Gap-free per-stream ordering.** Every stream is one Durable Object, a single-threaded actor with its own storage. Appends serialize into a strictly increasing, gap-free sequence with no distributed locks, leases, or consensus round-trips.
3. **A tamper-evident audit log.** Each event is linked into a SHA-256 hash chain over [RFC 8785](https://www.rfc-editor.org/rfc/rfc8785) canonical JSON, so changing any past event breaks every hash after it. One `GET …/verify` call re-walks the chain and names the first broken event. The spec is public, so anyone can re-verify a chain without trusting the server.

Around that core: a D1 read model fed by a transactional outbox (it can lag, but it can't lose an event), per-key token-bucket rate limiting, and per-minute rollups.

**Engineering highlights**

- **Tests that check the mechanism, not just the outcome.** The concurrency suite forces the race that `blockConcurrencyWhile` defends against, so deleting the guard makes it fail.
- **Conformance-tested.** The canonical form is pinned to RFC 8785's own worked examples, which is how a key-ordering bug in an earlier canonicalizer surfaced.
- **88 tests in the real Workers runtime** (workerd), against real Durable Objects and a local D1. Nothing about the platform is mocked.

---

## Architecture

The Worker is a stateless front door. The guarantees live in two kinds of Durable Object; D1 is a queryable **read model**. This is a deliberate [CQRS](#the-consistency-model) split: the Durable Object is the **authoritative write side**, D1 the **eventually-consistent read side**.

```mermaid
flowchart LR
    C([Client]) -- "HTTPS" --> W["Worker (Hono)<br/>auth · rate limit · route"]
    W -- "take()" --> RL["RateLimiterDO<br/>one per API key<br/>token bucket"]
    W -- "append() · head() · verify() · stats()" --> S["StreamDO: the authority<br/>one per stream<br/>seq · idempotency · hash chain"]
    W -. "inline mirror (fast path)" .-> D[("D1 read model<br/>events · streams · api_keys")]
    S -. "outbox alarm (guaranteed)" .-> D
    W -- "GET /events (paginated)" --> D
    style S stroke:#E3B341,stroke-width:2px
```

**The life of an append**

```mermaid
sequenceDiagram
    autonumber
    participant C as Client
    participant W as Worker
    participant R as RateLimiterDO
    participant S as StreamDO
    participant D as D1
    C->>W: POST /v1/streams/:id/events (Idempotency-Key)
    W->>D: resolve key hash, check stream ownership
    W->>R: take() one token
    R-->>W: allowed (or 429 + Retry-After)
    W->>S: append(payload, key)
    Note over S: one atomic write: event, key record,<br/>rollup, head, outbox alarm
    S-->>W: created / replayed / conflict
    W->>D: INSERT OR IGNORE (fast path, may fail)
    W-->>C: 201 {seq, hash} (200 on replay, 422 on conflict)
    S--)D: alarm sweeps anything D1 is missing, retrying until it lands
```

`head`, `verify`, and `stats` always read from the **Durable Object**, so they reflect the true state even when the D1 projection is a few milliseconds behind.

---

## Quickstart

> **Prerequisites:** Node **≥ 22** (the test runtime, `miniflare`, uses `node:sqlite`). An `.nvmrc` pins it; run `nvm use`.

```bash
git clone https://github.com/aaguasvivas/ledgerline.git && cd ledgerline
npm install

# Local secret for the admin key-minting endpoint (git-ignored).
echo 'ADMIN_SECRET = "local-dev-secret"' > .dev.vars

# Create the local D1 tables, then start the edge runtime locally.
npm run migrate:local
npm run dev                      # → http://localhost:8787 (the demo page is at /)
```

In another terminal, walk the whole API. (`jq` optional, for pretty output.)

```bash
BASE=http://localhost:8787

# 0. Mint an API key (admin-only; the raw key is shown exactly once).
KEY=$(curl -s -X POST $BASE/v1/keys \
  -H 'X-Admin-Secret: local-dev-secret' \
  -H 'Content-Type: application/json' \
  -d '{"name":"demo","rate_per_min":1000}' | jq -r .key)

# 1. Create a stream.
SID=$(curl -s -X POST $BASE/v1/streams \
  -H "Authorization: Bearer $KEY" | jq -r .id)

# 2. Append an event with an idempotency key.
curl -s -X POST $BASE/v1/streams/$SID/events \
  -H "Authorization: Bearer $KEY" \
  -H 'Idempotency-Key: invoice-001' \
  -H 'Content-Type: application/json' \
  -d '{"amount":100,"currency":"USD"}'
# → {"seq":1,"hash":"6d8a9d…"}

# 3. Retry the SAME key and body → original result, no new event, replay header.
curl -si -X POST $BASE/v1/streams/$SID/events \
  -H "Authorization: Bearer $KEY" \
  -H 'Idempotency-Key: invoice-001' \
  -H 'Content-Type: application/json' \
  -d '{"amount":100,"currency":"USD"}' | grep -i 'idempotent-replay'
# → Idempotent-Replay: true

# 4. Reuse the key with a DIFFERENT body → refused, nothing written.
curl -s -X POST $BASE/v1/streams/$SID/events \
  -H "Authorization: Bearer $KEY" \
  -H 'Idempotency-Key: invoice-001' \
  -H 'Content-Type: application/json' \
  -d '{"amount":99999,"currency":"USD"}'
# → {"error":{"code":"idempotency_key_reused",…}}   (HTTP 422)

# 5. Read the O(1) head and verify the whole chain.
curl -s $BASE/v1/streams/$SID/head   -H "Authorization: Bearer $KEY"
# → {"count":1,"headHash":"6d8a9d…"}
curl -s $BASE/v1/streams/$SID/verify -H "Authorization: Bearer $KEY"
# → {"valid":true}
```

---

## API reference

All `/v1/streams/*` endpoints require `Authorization: Bearer <api-key>` and are rate-limited per key. Errors use a uniform envelope:

```json
{ "error": { "code": "stream_not_found", "message": "Stream not found" } }
```

Status codes: `400` bad request · `401` unauthenticated · `403` admin-forbidden · `404` not found / not owned · `413` payload too large · `422` idempotency key reused with a different payload · `429` rate-limited.

### `GET /health`
Liveness probe; unauthenticated. → `{ "status": "ok" }`

### `POST /v1/keys`: mint an API key (admin)
Guarded by `X-Admin-Secret: <ADMIN_SECRET>` (fails closed when the secret is unset). The raw key is returned **once** and only its SHA-256 hash is stored. An empty body mints with defaults (`name: "unnamed"`, `rate_per_min: 60`); a non-empty body must be a JSON object (`400 invalid_body`).

```bash
curl -X POST $BASE/v1/keys -H 'X-Admin-Secret: …' \
  -H 'Content-Type: application/json' -d '{"name":"acme","rate_per_min":120}'
# → 201 {"key":"lk_…48hex…","name":"acme","rate_per_min":120}
```

### `POST /v1/streams`: create a stream
```bash
curl -X POST $BASE/v1/streams -H "Authorization: Bearer $KEY"
# → 201 {"id":"6f729257-d269-4f02-a3b4-7b651a966ae1"}
```

### `POST /v1/streams/:id/events`: append
Requires header `Idempotency-Key`; the body is an arbitrary JSON payload.

```bash
curl -X POST $BASE/v1/streams/$SID/events -H "Authorization: Bearer $KEY" \
  -H 'Idempotency-Key: k1' -H 'Content-Type: application/json' -d '{"note":"hello"}'
# → 201 {"seq":2,"hash":"68984989…"}
```

| Request | Response |
|---|---|
| New key | `201 {seq, hash}` |
| Repeated key, same payload (compared in canonical form, so key order and whitespace don't matter) | `200 {seq, hash}` of the **original** event + `Idempotent-Replay: true`; nothing written |
| Repeated key, different payload | `422 idempotency_key_reused`; nothing written (as the [IETF Idempotency-Key draft](https://datatracker.ietf.org/doc/draft-ietf-httpapi-idempotency-key-header/) specifies) |
| Missing key / key over 256 chars | `400 idempotency_key_required` / `400 idempotency_key_invalid` |

- **Limits** (explicit product caps, enforced as typed errors at the edge): body ≤ 256 KiB, counted while streaming so an oversized upload is never buffered (`413 payload_too_large`); nesting ≤ 64 levels (`400 payload_too_deep`); valid UTF-8, finite numbers, and no unpaired UTF-16 surrogates (`400 invalid_payload`). The last two keep every accepted payload representable in RFC 8785: JSON `1e999` would otherwise silently become `null`.
- Idempotency keys are retained for the **life of the stream**: a key permanently maps to its original event, so retries are safe at any later time, unlike TTL-based schemes.

### `GET /v1/streams/:id/events?after=<seq>&limit=<n>`: paginated read (D1)
`after` defaults to `0`, `limit` defaults to `50` (max `200`).
```json
{
  "events": [
    { "seq": 1, "hash": "6d8a9d…", "prevHash": "90bc43…",
      "payload": { "amount": 100, "currency": "USD" }, "createdAt": 1782806126825 }
  ],
  "nextAfter": null
}
```
`nextAfter` is the cursor for the next page (the last `seq` when a full page was returned), or `null` at the end.

### `GET /v1/streams/:id/head`: O(1) head (Durable Object)
→ `{ "count": 2, "headHash": "68984989…" }`

### `GET /v1/streams/:id/stats`: per-minute rollups (Durable Object)
→ `{ "total": 2, "perMinute": [ { "minute": 29713435, "count": 2 } ] }`
(`minute` = `floor(epochMs / 60000)`; only the last 60 minutes with activity are returned.)

### `GET /v1/streams/:id/verify`: recompute the chain (authoritative)
Re-walks the chain from genesis over the Durable Object's events and reports the first seq that is missing, out of order, or fails to link; then checks the result against the stream's committed head, so **tail truncation** (the classic ledger rollback) is caught too.
→ `{ "valid": true }` or `{ "valid": false, "brokenAt": 2 }`

---

## The hash chain (precise spec)

Tamper-evidence is fully specified and versioned, so anyone can recompute and audit a chain independently:

```
canonical JSON   = RFC 8785 (JSON Canonicalization Scheme)
hash_0 (genesis) = SHA-256("ledgerline:v1:" + streamId)                          (hex)
hash_n           = SHA-256(hash_{n-1} + "|" + canonicalJSON(payload_n) + "|" + n)  (hex)
```

Each stored event keeps both `prevHash` and `hash`. `verify` walks from genesis and, for every event, checks that its `seq` is the next one, that its stored `prevHash` equals the recomputed previous hash, and that its stored `hash` equals the recomputed link. The first failure is `brokenAt`. It then compares the recomputed head with the stream's committed head (count + head hash), so a **truncated tail** is reported too. Because every link folds in the previous hash, altering event *k* invalidates *k* and everything after it.

**For external verifiers.** Use any RFC 8785 implementation; the canonical form is pinned by the RFC's own worked examples plus known-answer SHA-256 vectors in `test/hash.test.ts`. In particular:
- Object members are sorted by key in **UTF-16 code-unit** order, numeric-string keys included (`"10"` sorts before `"9"`).
- Strings are serialized as ECMAScript `JSON.stringify` emits them, with non-ASCII characters unescaped (`"héllo 🚀"`).
- Numbers use ECMAScript number-to-string form (`-0` → `0`, `1e21` → `1e+21`, `1.5e-7` → `1.5e-7`); integers beyond 2^53 lose precision at `JSON.parse`, like in any JS service.
- Python's `json.dumps(sort_keys=True)` is **not** a substitute: it writes `1.5e-07` and sorts keys outside the Basic Multilingual Plane differently. Use an RFC 8785 library.

---

## Design decisions

**Why a Durable Object gives ordering + exactly-once without locks.**
A Durable Object is a single-threaded actor with its own consistent storage, so two appends to one stream never run in parallel. The remaining hazard is *interleaving across `await`s*: an append reads `meta`, awaits a SHA-256 digest, then writes. Durable Object input gates already hold new requests back during storage operations, and in workerd today a `crypto.subtle` digest doesn't open the gate either, but that is a runtime detail, not a contract. Ledgerline makes atomicity explicit by running each mutation in `ctx.blockConcurrencyWhile(...)`, and the test suite forces the digest to yield so the guard is actually exercised: without it, 20 concurrent appends collapse onto duplicate sequence numbers. The event, idempotency record, rollup bucket, head, and outbox alarm are written with no `await` in between, so they commit as one atomic write.

**The consistency model.**
The Durable Object is the **source of truth**; D1 is an **eventually-consistent projection**:
- Writes need strong ordering and atomicity → Durable Object.
- Reads need rich querying, pagination, and horizontal read scale → D1/SQLite.

Projection uses a **transactional outbox**. Every append arms a Durable Object alarm in the same atomic write as the event; the alarm sweeps everything past a confirmed watermark into D1 in batches and advances the watermark. On failure it reschedules itself instead of throwing, because platform alarm retries are finite and a D1 outage might not be. The Worker also mirrors inline right after each append, so a read immediately after a write usually sees it. Both writers use `INSERT OR IGNORE` keyed on `(stream_id, seq)`, so whichever lands second is a no-op. A failed inline write is logged (`mirror_deferred`) and the client still gets its authoritative `{seq, hash}`: failing the request over a non-authoritative projection would tell the client its durable write didn't happen.

**Why idempotency keys give exactly-once, and why a mismatched body is a 422.**
"Exactly-once delivery" is impossible over an unreliable network, but **exactly-once *effect*** is achievable: make the write idempotent and let the client retry. The Durable Object stores `idem:{key} → {seq, hash}` in the same atomic commit as the event. A retry with the same payload short-circuits to the stored result. A retry with a different payload almost always means a client bug (a recycled counter, a key derived from the wrong field); answering it with the original result would tell that client a write succeeded when it never happened, so it is a `422`, as the IETF draft specifies and as Stripe does. Records never expire: unlike TTL-based schemes (Stripe's 24 h window), a key is reserved for the stream's lifetime, so storage grows with the event log the ledger keeps anyway.

**Auth that doesn't leak.**
API keys are stored only as SHA-256 hashes. Stream ownership is enforced on every request, and a caller asking about a stream it doesn't own receives `404`, not `403`, so existence is never disclosed.

---

## Trade-offs

Every guarantee has a price; these are the ones worth raising in a design review.

- **One stream, one actor.** Ordering is cheap because a stream never spans machines, which also caps one stream's write rate at what a single Durable Object can serialize. Scale comes from many streams, not one hot one.
- **Tamper-evident, not tamper-proof.** Someone able to rewrite *all* of storage could rebuild a self-consistent chain. Clients that keep the hashes they were handed will see the head change; anchoring heads externally (signed checkpoints, a transparency log) would close the gap.
- **Verification is O(n).** `verify` re-walks the whole stream. Long-lived streams would want signed checkpoints so a verify starts from the last one.
- **Idempotency keys never expire.** Retries are safe at any distance in time, at the cost of one small record per event for the life of the stream.
- **Reads can trail writes.** Paginated `events` read D1, which can lag by milliseconds; the outbox guarantees it catches up.
- **One region per stream.** A Durable Object lives in one location, so far-away clients pay a round trip on writes: the price of a single, strongly consistent order.

---

## Concepts at work

| Component | Concept | How it shows up here |
|---|---|---|
| `Idempotency-Key` → `idem:{key}` | **Idempotency / exactly-once effect** | Retries collapse to one event; misuse is a `422`, replay is observable via a header. |
| Single-threaded `StreamDO` + `blockConcurrencyWhile` | **Strong consistency & serialization** | Ordering and atomic multi-key commits without locks or consensus. |
| `StreamDO` (write) vs `D1` (read) | **CQRS / read–write split** | Authoritative writes; eventually-consistent, query-optimized reads. |
| Durable Object alarm + watermark | **Transactional outbox** | The projection converges after any D1 failure, with no event lost. |
| SHA-256 chain over RFC 8785 JSON | **Tamper evidence / hash chains** | The head hash commits to all history; `verify` names the first break. |
| `RateLimiterDO` token bucket | **Rate limiting & backpressure** | Per-key burst + sustained rate; `429` + `Retry-After`. |
| `bucket:{minute}` counters | **Time-series rollups** | O(1) increment on write; windowed read for the last 60 minutes. |
| Hashed keys + ownership `404` | **AuthN/Z & information leakage** | No plaintext secrets; existence not disclosed across tenants. |

---

## Testing

Tests run inside the **real Workers runtime** (`workerd` via Miniflare and `@cloudflare/vitest-pool-workers`) against actual Durable Objects and a local D1, not mocks.

```bash
npm test            # 88 tests, 14 files
npm run test:watch  # watch mode
npm run typecheck   # tsc --noEmit (strict)
```

What's covered:

1. **Exactly-once**: a repeated key yields one event, the identical `{seq, hash}`, and `Idempotent-Replay: true`, including **5 requests in flight at once** racing one key; a reordered-but-equal body replays; a different body is a `422` that writes nothing.
2. **Ordering**: sequential *and* 20 concurrent appends produce strictly increasing, contiguous `seq` from 1. The concurrency tests make the `crypto.subtle` await yield so requests genuinely interleave; with `blockConcurrencyWhile` removed, both fail.
3. **Hash-chain integrity**: a tampered payload, a forged `prevHash`, a deleted middle event, and a truncated tail are each reported at the first broken seq; an append landing mid-verify doesn't produce a false alarm.
4. **Read-model delivery**: with D1 failing (simulated by a trigger), appends still succeed; the outbox alarm delivers once D1 recovers, keeps retrying through a sustained outage, and drains a 150-event backlog with no gaps.
5. **Rate limiting**: exhausting a key's bucket returns `429`; tokens refill over time (token-bucket math unit-tested with injected time).
6. **Auth**: missing/invalid bearer → `401`; another key's stream → `404`; the admin guard fails closed when its secret is unset.
7. **Durability**: state survives Durable Object eviction: seq continues, idempotency records replay, drained rate buckets stay drained.
8. **Input limits**: oversized, too-deep, non-UTF-8, non-finite, and unpaired-surrogate payloads fail as typed 4xx errors, never 500s; an oversized chunked upload is abandoned near the cap instead of being read to the end.
9. **Canonical-form contract**: RFC 8785's worked examples, known-answer SHA-256 vectors, `__proto__` round-trip fidelity, and unescaped-unicode bytes.
10. **The demo page**: the chain embedded in `/` is replayed through a real `StreamDO`, so the page can never drift from the server's hash rule.

CI (`.github/workflows/ci.yml`) runs typecheck + tests on every push to `main` and on every pull request.

---

## Deployment

You deploy with your own Cloudflare account; the code and config are ready.

```bash
npx wrangler login

# 1. Create the D1 database and put the printed id in wrangler.toml
#    (the `database_id` under [[d1_databases]]).
npx wrangler d1 create ledgerline

# 2. Apply migrations to the remote database.
npm run migrate

# 3. Set the admin secret (used by POST /v1/keys).
npx wrangler secret put ADMIN_SECRET

# 4. Deploy.
npm run deploy

# 5. Mint your first key against the live database.
node scripts/seed.mjs --remote --name first-key --rate 120
```

The reference instance of this repo runs at **https://ledgerline.adelsonaguasvivas.workers.dev** (health: [/health](https://ledgerline.adelsonaguasvivas.workers.dev/health)).

**Required bindings** (all declared in `wrangler.toml`): Durable Objects `STREAM` (`StreamDO`) and `RATE_LIMITER` (`RateLimiterDO`), D1 database `DB`, and the `ADMIN_SECRET` secret.

---

## Project layout

```
src/
  index.ts              Worker entry: exports the app + Durable Objects
  types.ts              shared Env bindings (STREAM, RATE_LIMITER, DB, ADMIN_SECRET)
  worker/
    app.ts              Hono routes, auth/rate-limit wiring, inline projection
    landing.ts          the landing page and in-browser chain demo served at /
    og.png              social preview card served at /og.png
  do/
    stream.ts           StreamDO: ordering, idempotency, chain, rollups, outbox alarm
    rate-limiter.ts     RateLimiterDO: per-key token bucket
  lib/
    hash.ts             RFC 8785 canonical JSON + SHA-256 hash-chain primitives
    read-model.ts       the one D1 projection statement both writers share
    validate.ts         streaming body cap and payload/key limits
    token-bucket.ts     pure, time-injected rate-limit math
    auth.ts             key hashing + bearer-auth middleware
    rate-limit.ts       rate-limit middleware
    errors.ts           ApiError + JSON error envelope
    log.ts              structured JSON logger
migrations/0001_init.sql  D1 read-model schema
scripts/seed.mjs          mint a key into local/remote D1
scripts/og-card.html      source for the social preview card
test/                     88 tests across 14 files
```

---

## Non-goals

Scope is intentionally tight. This is the integrity core, done well, not a product:

- **No UI** beyond the landing page and demo at `/`.
- **No multi-tenant dashboard**, analytics console, or admin UI.
- **No payments/banking logic.** Ledgers and audit trails are *use cases*, not features here.
- **No auth UI or OAuth.** API keys only.
- **No multi-region logic** beyond what Cloudflare provides automatically.
- **No cross-stream transactions.** Each stream is its own consistency domain, which is what makes per-stream ordering cheap.

---

## License

MIT © Adelson Aguasvivas. Built by [Adelson Aguasvivas](https://adelsonaguasvivas.com).
