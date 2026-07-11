# Ledgerline

**Append-only event streams with exactly-once writes, strong ordering, and a tamper-evident hash chain, running at the edge on Cloudflare Workers.**

![CI](https://github.com/aaguasvivas/ledgerline/actions/workflows/ci.yml/badge.svg)
![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white)
![TypeScript strict](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)
![Tests](https://img.shields.io/badge/tests-68%20passing-3FB950)
![License](https://img.shields.io/badge/license-MIT-blue)

---

## What & why

Ledgerline is the integrity core behind ledgers, audit trails, and event-sourced systems, exposed as a small HTTP API. It gives you three things that are individually easy to get *wrong* and collectively the hard part of any append-only system:

1. **Exactly-once appends.** A client sends an `Idempotency-Key` with each write; a retried key returns the *original* result and never creates a second event, so a flaky network or an at-least-once producer can't double-write.
2. **Strong per-stream ordering.** Every stream is backed by a single Cloudflare Durable Object. Because a Durable Object is single-threaded, appends to a stream serialize naturally into a strictly increasing, gap-free sequence: no locks, leases, or consensus round-trips.
3. **A tamper-evident audit log.** Each event is linked into a SHA-256 hash chain over canonical JSON, so changing any past event breaks every hash after it. One `GET …/verify` call recomputes the whole chain and pinpoints the first divergence.

On top of that: per-API-key token-bucket rate limiting and real-time per-minute rollups.

---

## Architecture

The Worker is a stateless edge front door. State and the guarantees that matter live in two kinds of Durable Object; D1 is a fast, queryable **read model** that the Worker updates *after* a write is confirmed. This is a deliberate [CQRS](#system-design-notes) split: the Durable Object is the **authoritative write side**, D1 is the **eventually-consistent read side**.

```
                                  Authorization: Bearer <key>
                                  Idempotency-Key: <key>
   ┌────────┐   HTTPS   ┌────────────────────────┐
   │ Client │ ────────► │   Worker (Hono router) │
   └────────┘           │  auth · routing · CQRS │
        ▲               └───────┬──────────┬─────┘
        │                       │          │
        │            take()     │          │  append() / head() / verify() / stats()
        │            (1 token)   ▼          ▼  (RPC, strongly consistent)
        │            ┌────────────────┐  ┌──────────────────────────────┐
        │            │ RateLimiterDO  │  │   StreamDO  (1 per stream)    │
        │            │ 1 per API key  │  │   ★ AUTHORITATIVE ★           │
        │            │ token bucket   │  │   monotonic seq · idempotency │
        │            └────────────────┘  │   SHA-256 hash chain · rollups│
        │                                └───────────────┬──────────────┘
        │                                                │ mirror on confirmed append
        │        paginated reads / stats                 ▼  (INSERT OR IGNORE)
        │     ┌──────────────────────────────────────────────────────┐
        └──── │            D1 (SQLite): read model / CQRS query side   │
              │            events · streams · api_keys                 │
              └──────────────────────────────────────────────────────┘
                          eventually consistent projection
```

**Request lifecycle for an append**

1. Worker authenticates the bearer key (SHA-256 lookup in D1).
2. `RateLimiterDO.take()` spends one token, or the request is rejected with `429`.
3. `StreamDO.append()` checks the idempotency key, assigns the next `seq`, links the hash chain, and commits **atomically**; this is the authoritative write.
4. The Worker mirrors the confirmed event into D1 with `INSERT OR IGNORE` (idempotent, self-healing).
5. `head`, `verify`, and `stats` always read from the **Durable Object**, so they reflect the true state even if the D1 projection is a few milliseconds behind.

---

## Quickstart

> **Prerequisites:** Node **≥ 22** (the test runtime, `miniflare`, uses `node:sqlite`). An `.nvmrc` pins it; run `nvm use`.

```bash
npm install

# Local secret for the admin key-minting endpoint (git-ignored).
echo 'ADMIN_SECRET = "local-dev-secret"' > .dev.vars

# Create the local D1 tables, then start the edge runtime locally.
npm run migrate:local
npm run dev                      # → http://localhost:8787
```

In another terminal, walk the whole API. (`jq` optional, for pretty output.)

```bash
BASE=http://localhost:8787

# 0. Mint an API key (admin-only; raw key is shown exactly once).
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

# 3. Retry the SAME key → original result, no new event, replay header.
curl -si -X POST $BASE/v1/streams/$SID/events \
  -H "Authorization: Bearer $KEY" \
  -H 'Idempotency-Key: invoice-001' \
  -H 'Content-Type: application/json' \
  -d '{"amount":100,"currency":"USD"}' | grep -i 'idempotent-replay'
# → Idempotent-Replay: true

# 4. Read the O(1) head and verify the whole chain.
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

Status codes: `400` bad request · `401` unauthenticated · `403` admin-forbidden · `404` not found / not owned · `409` reserved · `413` payload too large · `429` rate-limited.

### `GET /health`
Liveness probe; unauthenticated. → `{ "status": "ok" }`

### `POST /v1/keys`: mint an API key (admin)
Guarded by `X-Admin-Secret: <ADMIN_SECRET>`. The raw key is returned **once** and only its SHA-256 hash is stored.

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
Requires header `Idempotency-Key`; body is an arbitrary JSON payload.

```bash
curl -X POST $BASE/v1/streams/$SID/events -H "Authorization: Bearer $KEY" \
  -H 'Idempotency-Key: k1' -H 'Content-Type: application/json' -d '{"note":"hello"}'
# → 201 {"seq":2,"hash":"68984989…"}
```
- A **repeated** `Idempotency-Key` returns the original `{seq, hash}` with `200` and response header `Idempotent-Replay: true`; no new event is appended.
- Missing `Idempotency-Key` → `400 idempotency_key_required`; over 256 chars → `400 idempotency_key_invalid`.
- **Limits** (explicit product caps, enforced as typed errors at the edge): body ≤ 256 KiB (`413 payload_too_large`), nesting ≤ 64 levels (`400 payload_too_deep`), all numbers finite (`400 invalid_payload`; JSON `1e999` would otherwise silently become `null`).
- Idempotency keys are retained for the **life of the stream**: a key permanently maps to its original event (this is what makes retries safe at any later time, unlike TTL-based schemes).

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
Recomputes the hash chain from genesis over the Durable Object's events, then checks the recomputed head against `meta` (event count + head hash), so **tail truncation** (the classic ledger rollback) is caught, not just in-place edits.
→ `{ "valid": true }` or `{ "valid": false, "brokenAt": 2 }`

---

## The hash chain (precise spec)

Tamper-evidence is fully specified and versioned, so anyone can recompute and audit the chain independently:

```
canonical JSON   = object keys sorted recursively, no whitespace
hash_0 (genesis) = SHA-256("ledgerline:v1:" + streamId)                         (hex)
hash_n           = SHA-256(hash_{n-1} + "|" + canonicalJSON(payload_n) + "|" + n)  (hex)
```

Each stored event keeps both `prevHash` and `hash`. `verify` walks from genesis, recomputing each link; the first `seq` whose recomputed hash ≠ stored hash is reported as `brokenAt`. After the walk it compares the recomputed head against the stream's `meta` (count + head hash), so a **truncated tail** (a clean-looking prefix with the newest events deleted) is also reported as broken. Because every link folds in the previous hash, altering event *k* invalidates *k* and everything after it, which is exactly the property a Merkle-style chain gives an audit log. Canonical JSON guarantees the hash is independent of key ordering, so re-serialization never produces a false positive.

**For external verifiers**, the canonical form is pinned by known-answer tests:
- Strings are serialized as ECMAScript `JSON.stringify` emits them: non-ASCII characters **unescaped** (`"héllo 🚀"`, not `\uXXXX`). Python users: `json.dumps(..., ensure_ascii=False, separators=(",", ":"), sort_keys=True)` matches.
- Numbers are IEEE-754 doubles in ECMAScript number-to-string form (`-0` serializes as `0`, `1e21` as `1e+21`); integers beyond 2^53 lose precision at `JSON.parse` like any JS service. Non-finite values are rejected at the API boundary, so every stored number round-trips.

---

## Design decisions

**Why a Durable Object gives ordering + exactly-once without locks.**
A Durable Object is a single-threaded actor with its own consistent storage. Two appends to the same stream can never run in parallel, so there is no shared-memory race to guard. The one subtlety is *interleaving across `await`s*: an append reads `meta`, awaits a SHA-256 digest, then writes, and a second concurrent request could slip in at the digest `await`. Ledgerline closes that window by running each mutation inside `ctx.blockConcurrencyWhile(...)`, which defers delivery of other events until the critical section finishes. The result is strict serialization (monotonic `seq` and exactly-once appends) achieved with platform primitives instead of distributed locks, leases, or a consensus protocol. The event, idempotency record, rollup bucket, and `meta` are written in a **single batched `put`**, so an append commits all-or-nothing.

**The consistency model (and why CQRS).**
The Durable Object is the **source of truth**; D1 is an **eventually-consistent projection** written *after* the Durable Object confirms a write. This is a deliberate CQRS split:
- Writes need strong ordering and atomicity → Durable Object.
- Reads need rich querying, pagination, and horizontal read scale → D1/SQLite.

The trade-off is that the read model can lag the write side by a few milliseconds. Ledgerline manages this honestly: `head`, `stats`, and `verify` answer from the **authoritative** Durable Object, while `events` (bulk pagination) serves from D1. The mirror is deliberately **best-effort on the request path**: once the Durable Object has committed, a D1 failure is logged (`mirror_failed`) and the client still receives its authoritative `{seq, hash}`. Failing the request for a non-authoritative projection would tell the client its durable write didn't happen. Mirroring uses `INSERT OR IGNORE` keyed on `(stream_id, seq)`, so a retry of the same `Idempotency-Key` re-mirrors the identical row and heals the gap without ever duplicating one.

**Why idempotency keys give exactly-once under retries.**
"Exactly-once delivery" is impossible over an unreliable network, but **exactly-once *effect*** is achievable: make the write idempotent and let the client retry safely. The Durable Object stores `idem:{key} → {seq, hash}` per stream. The first append records it inside the same atomic commit as the event; any later append with that key short-circuits to the stored result. The key is authoritative (a retry returns the original event even if the payload differs) and records never expire: unlike TTL-based schemes (e.g. Stripe's 24 h window), a key is reserved for the stream's lifetime, so storage grows with the event log the ledger keeps anyway.

**Tamper-evidence as a first-class feature.**
Storing events is easy; proving they weren't edited after the fact is the point. The hash chain turns the log into content-addressed, append-only data: the head hash commits to the entire history, and `verify` gives a cheap, total integrity check with a precise failure location.

**Auth that doesn't leak.**
API keys are stored only as SHA-256 hashes. Stream ownership is enforced on every request, and a caller asking about a stream it doesn't own receives `404`, not `403`, so existence is never disclosed.

---

## System-design notes

A map from each component to the interview concept it demonstrates:

| Component | Concept | How it shows up here |
|---|---|---|
| `Idempotency-Key` → `idem:{key}` map | **Idempotency / exactly-once effect** | Retries collapse to one event; replay is observable via a header. |
| Single-threaded `StreamDO` + `blockConcurrencyWhile` | **Strong consistency & serialization** | Ordering and atomic multi-key commits without locks or consensus. |
| `StreamDO` (write) vs `D1` (read) | **CQRS / read–write split** | Authoritative writes; eventually-consistent, query-optimized reads. |
| SHA-256 chain over canonical JSON | **Tamper-evidence / Merkle chains** | Head hash commits to history; `verify` locates the first break. |
| `RateLimiterDO` token bucket | **Rate limiting & backpressure** | Per-key burst + sustained rate; `429` + `Retry-After`. |
| `bucket:{minute}` counters | **Time-series rollups** | O(1) increment on write; windowed read for the last 60 minutes. |
| Hashed keys + ownership `404` | **AuthN/Z & information leakage** | No plaintext secrets; existence not disclosed across tenants. |

---

## Testing

Tests run inside the **real Workers runtime** (`workerd` via Miniflare and `@cloudflare/vitest-pool-workers`) against actual Durable Objects and a local D1, not mocks. Built test-first.

```bash
npm test            # 68 tests, 13 files
npm run test:watch  # watch mode
npm run typecheck   # tsc --noEmit (strict)
```

What's covered (the six core guarantees, plus the surface an adversarial audit said mattered):

1. **Exactly-once**: a repeated `Idempotency-Key` yields one event, identical `{seq, hash}`, and `Idempotent-Replay: true`, including **5 requests in flight simultaneously** racing one key.
2. **Ordering**: sequential *and* 20 concurrent in-flight appends produce strictly increasing, contiguous `seq` from 1.
3. **Hash-chain integrity**: tampering with a stored payload makes `verify` return `{ valid: false, brokenAt: <seq> }`; deleting the trailing event (truncation) is caught; an untouched chain returns `{ valid: true }`.
4. **Rate limiting**: exhausting a key's bucket returns `429`; tokens refill over time (token-bucket math unit-tested with injected time for determinism).
5. **Auth**: missing/invalid bearer → `401`; another key's stream → `404` (no existence leak); admin guard fails closed when the secret is unset.
6. **Read model**: events and stats appear via the API after an append; a replayed key mirrors the *original* payload; a failed mirror doesn't fail a committed append.
7. **Durability**: state survives Durable Object eviction: seq continues, idempotency records replay, drained rate buckets stay drained.
8. **Input limits**: oversized/too-deep/non-finite payloads and oversized keys fail as typed 4xx errors, never 500s.
9. **Canonical-form contract**: known-answer SHA-256 vectors, `__proto__` round-trip fidelity, and unescaped-unicode bytes are all pinned for external verifiers.

CI (`.github/workflows/ci.yml`) runs typecheck + tests on every push to `main` and on every pull request.

---

## Deployment

You deploy with your own Cloudflare account; the code and config are ready.

```bash
npx wrangler login

# 1. Create the D1 database and paste the printed id into wrangler.toml
#    (replace REPLACE_WITH_YOUR_D1_DATABASE_ID).
npx wrangler d1 create ledgerline

# 2. Apply migrations to the remote database.
npm run migrate

# 3. Set the admin secret (used by POST /v1/keys).
npx wrangler secret put ADMIN_SECRET

# 4. Deploy.
npm run deploy

# 5. Mint your first key against the live database.
node scripts/seed.mjs --remote --name first-key --rate 120
#    …then put your deployed URL here:  https://ledgerline.<subdomain>.workers.dev
```

**Required bindings** (all pre-declared in `wrangler.toml`): Durable Objects `STREAM` (`StreamDO`) and `RATE_LIMITER` (`RateLimiterDO`), D1 database `DB`, and the `ADMIN_SECRET` secret.

---

## Project layout

```
src/
  index.ts              Worker entry: exports the app + Durable Objects
  types.ts              shared Env bindings (STREAM, RATE_LIMITER, DB, ADMIN_SECRET)
  worker/
    app.ts              Hono routes, auth/rate-limit wiring, CQRS mirroring
    landing.ts          tiny static landing page
  do/
    stream.ts           StreamDO: authoritative ordering, idempotency, chain, rollups
    rate-limiter.ts     RateLimiterDO: per-key token bucket
  lib/
    hash.ts             canonical JSON + SHA-256 hash-chain primitives
    token-bucket.ts     pure, time-injected rate-limit math
    auth.ts             key hashing + bearer-auth middleware
    rate-limit.ts       rate-limit middleware
    validate.ts         payload/key limits (size, depth, finiteness)
    errors.ts           ApiError + JSON error envelope
    log.ts              structured JSON logger
migrations/0001_init.sql  D1 read-model schema
scripts/seed.mjs          mint a key into local/remote D1
test/                     68 tests across 13 files
```

---

## Non-goals

Scope is intentionally tight. This is the integrity core, done well, not a product:

- **No UI** beyond the tiny landing page at `/`.
- **No multi-tenant dashboard**, analytics console, or admin UI.
- **No payments/banking logic.** Ledgers and audit trails are *use cases*, not features here.
- **No auth UI or OAuth.** API keys only.
- **No multi-region logic** beyond what Cloudflare provides automatically.
- **No cross-stream transactions.** Each stream is its own consistency domain (which is what makes per-stream ordering cheap).

---

## License

MIT.
