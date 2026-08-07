# LEDGERLINE

Append-only event streams with exactly-once writes, strong ordering, and a tamper-evident hash chain, running on Cloudflare Workers. Infra project, not a game.

## Stack
Cloudflare Workers + Durable Objects (bindings: STREAM, RATE_LIMITER in wrangler.toml). Vitest. GitHub Actions CI.

## Commands
- Dev: `npm run dev` (wrangler dev)
- Test: `npm test`
- Deploy: `npm run deploy` (wrangler deploy)
- Migrations: `npm run migrate` (remote) / `npm run migrate:local`; seed with `npm run seed`

## Rules
- Correctness project: ordering, idempotency, and hash-chain invariants must have tests before merge.
- CI must be green before deploy; check the Actions workflow after pushing.
