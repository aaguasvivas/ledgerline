/**
 * Interactive demo served at `/demo`: no auth, no server state.
 *
 * The page replays a recorded run of this API (real hashes) and recomputes the
 * hash chain IN THE BROWSER with the same rule as `src/lib/hash.ts`, so
 * visitors can tamper with a payload and watch `verify` catch it. The embedded
 * digests were produced by the live API; the in-browser recomputation matching
 * them is itself a demonstration of the public chain spec.
 */
export const DEMO_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Ledgerline: live demo walkthrough</title>
<style>
  :root {
    --bg: #0E1116; --panel: #151B23; --panel-2: #1B232E; --line: #2A3441;
    --ink: #E9EEF4; --muted: #97A3B4;
    --gold: #E3B341; --gold-dim: rgba(227, 179, 65, 0.14);
    --ok: #46C266; --ok-dim: rgba(70, 194, 102, 0.13);
    --bad: #F0564F; --bad-dim: rgba(240, 86, 79, 0.13);
    --serif: "New York", "Iowan Old Style", Georgia, "Times New Roman", serif;
    --sans: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    --mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  }
  * { box-sizing: border-box; }
  html { background: var(--bg); }
  body { margin: 0; background: var(--bg); color: var(--ink); font: 16px/1.65 var(--sans); -webkit-font-smoothing: antialiased; }
  .wrap { max-width: 880px; margin: 0 auto; padding: 3.5rem 1.5rem 5rem; }
  h1, h2 { font-family: var(--serif); font-weight: 600; letter-spacing: -0.01em; text-wrap: balance; }
  h1 { font-size: 2.6rem; line-height: 1.15; margin: 0.5rem 0 0.75rem; }
  h2 { font-size: 1.55rem; line-height: 1.25; margin: 0 0 0.35rem; }
  p { max-width: 62ch; }
  .lede { font-size: 1.12rem; color: var(--muted); max-width: 58ch; margin: 0; }
  .eyebrow { font: 600 0.72rem/1 var(--mono); letter-spacing: 0.14em; text-transform: uppercase; color: var(--gold); }
  .section { margin-top: 4.5rem; display: flex; flex-direction: column; gap: 0.9rem; }
  .section > p { color: var(--muted); margin: 0; }
  .section > p strong { color: var(--ink); font-weight: 600; }
  code { font: 0.86em var(--mono); background: var(--panel-2); border: 1px solid var(--line); border-radius: 4px; padding: 0.1em 0.35em; }
  a { color: var(--gold); }
  .chips { display: flex; flex-wrap: wrap; gap: 0.6rem; margin-top: 1.4rem; }
  .chip { font: 500 0.82rem/1 var(--sans); color: var(--ink); background: var(--panel); border: 1px solid var(--line); border-radius: 999px; padding: 0.55rem 0.9rem; display: inline-flex; align-items: center; gap: 0.45rem; }
  .chip .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--gold); }
  .arch { display: grid; grid-template-columns: minmax(0, 1fr) 240px; gap: 1rem; align-items: start; }
  .arch-canvas { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 1.5rem 1.25rem; display: flex; flex-direction: column; align-items: center; gap: 0; overflow-x: auto; }
  .node { border: 1px solid var(--line); background: var(--panel-2); border-radius: 8px; padding: 0.6rem 1.1rem; text-align: center; min-width: 240px; }
  .node .n-title { font: 600 0.92rem/1.3 var(--sans); }
  .node .n-sub { font: 0.72rem/1.4 var(--mono); color: var(--muted); }
  .node.authority { border-color: var(--gold); background: var(--gold-dim); }
  .node.authority .n-sub { color: var(--gold); }
  .edge { display: flex; align-items: center; gap: 0.5rem; font: 0.7rem/1.3 var(--mono); color: var(--muted); padding: 0.45rem 0; }
  .edge::before { content: "│"; color: var(--line); font-size: 1.1rem; }
  .duo { display: flex; gap: 1rem; flex-wrap: wrap; justify-content: center; }
  .duo .node { min-width: 200px; }
  .steps { display: flex; flex-direction: column; gap: 0.7rem; margin: 0; padding: 0; list-style: none; counter-reset: step; }
  .steps li { counter-increment: step; display: grid; grid-template-columns: 1.6rem 1fr; gap: 0.6rem; font-size: 0.88rem; color: var(--muted); }
  .steps li::before { content: counter(step); font: 600 0.75rem/1.6rem var(--mono); color: var(--gold); background: var(--gold-dim); border-radius: 50%; width: 1.6rem; height: 1.6rem; text-align: center; }
  .steps li strong { color: var(--ink); font-weight: 600; }
  .term { background: #0A0D11; border: 1px solid var(--line); border-radius: 10px; padding: 1rem 1.2rem; overflow-x: auto; font: 0.82rem/1.7 var(--mono); white-space: pre; }
  .term .c { color: #5B6675; }
  .term .p { color: var(--muted); }
  .term .r { color: var(--ink); }
  .term .hl { color: var(--gold); font-weight: 600; }
  .term .g { color: var(--ok); }
  .verify-banner { display: flex; align-items: center; gap: 0.75rem; border-radius: 10px; padding: 0.85rem 1.1rem; font: 600 0.95rem/1.4 var(--mono); border: 1px solid var(--ok); background: var(--ok-dim); color: var(--ok); transition: background 0.25s, border-color 0.25s, color 0.25s; }
  .verify-banner.broken { border-color: var(--bad); background: var(--bad-dim); color: var(--bad); }
  .verify-banner .vb-icon { font-size: 1.1rem; }
  .browser-check { font: 0.8rem/1.5 var(--mono); color: var(--ok); }
  .browser-check.pending { color: var(--muted); }
  .chain { display: flex; flex-direction: column; gap: 0; }
  .genesis { align-self: flex-start; font: 0.78rem/1.5 var(--mono); color: var(--muted); background: var(--panel); border: 1px dashed var(--line); border-radius: 8px; padding: 0.5rem 0.9rem; }
  .genesis .hash { color: var(--gold); }
  .link-arrow { font: 0.72rem/1.4 var(--mono); color: var(--muted); padding: 0.35rem 0 0.35rem 1.4rem; display: flex; align-items: center; gap: 0.5rem; }
  .link-arrow::before { content: "↓"; color: var(--gold); }
  .link-arrow.dead::before, .link-arrow.dead { color: var(--bad); }
  .event-card { background: var(--panel); border: 1px solid var(--line); border-left: 3px solid var(--ok); border-radius: 10px; padding: 1rem 1.2rem; display: grid; grid-template-columns: 3.2rem minmax(0, 1fr); gap: 0.4rem 1rem; transition: border-color 0.25s; }
  .event-card.broken { border-left-color: var(--bad); border-color: var(--bad); }
  .event-card.downstream { border-left-color: var(--bad); opacity: 0.85; }
  .seq-badge { grid-row: span 3; font: 600 1.1rem/1 var(--mono); color: var(--gold); display: flex; flex-direction: column; align-items: center; gap: 0.3rem; padding-top: 0.2rem; }
  .seq-badge span { font: 500 0.62rem/1 var(--mono); color: var(--muted); letter-spacing: 0.1em; }
  .payload-row { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.5rem; font: 0.82rem/1.6 var(--mono); }
  .payload-row .k { color: var(--muted); }
  .payload-row input { font: 600 0.85rem/1.2 var(--mono); color: var(--ink); background: var(--panel-2); border: 1px solid var(--line); border-radius: 5px; width: 6.5rem; padding: 0.25rem 0.5rem; }
  .payload-row input:focus { outline: 2px solid var(--gold); outline-offset: 1px; border-color: var(--gold); }
  .hash-rows { display: flex; flex-direction: column; gap: 0.15rem; font: 0.78rem/1.6 var(--mono); }
  .hash-rows .lbl { color: var(--muted); display: inline-block; width: 8.5rem; }
  .hash-val { color: var(--gold); word-break: break-all; }
  .hash-val.mismatch { color: var(--bad); }
  .verdict { font: 600 0.75rem/1.6 var(--mono); }
  .verdict.ok { color: var(--ok); }
  .verdict.bad { color: var(--bad); }
  .demo-controls { display: flex; flex-wrap: wrap; gap: 0.75rem; align-items: center; }
  button.reset { font: 600 0.85rem/1 var(--sans); color: var(--ink); background: var(--panel-2); border: 1px solid var(--line); border-radius: 7px; padding: 0.6rem 1rem; cursor: pointer; }
  button.reset:hover { border-color: var(--gold); color: var(--gold); }
  button.reset:focus-visible { outline: 2px solid var(--gold); outline-offset: 2px; }
  .hint { font: 0.82rem/1.5 var(--sans); color: var(--muted); }
  .hint strong { color: var(--gold); font-weight: 600; }
  .tbl-wrap { overflow-x: auto; border: 1px solid var(--line); border-radius: 10px; }
  table { width: 100%; border-collapse: collapse; font-size: 0.86rem; background: var(--panel); }
  th, td { text-align: left; padding: 0.65rem 1rem; border-bottom: 1px solid var(--line); }
  tr:last-child td { border-bottom: none; }
  th { font: 600 0.68rem/1 var(--mono); letter-spacing: 0.12em; text-transform: uppercase; color: var(--muted); background: var(--panel-2); }
  td { font-family: var(--mono); font-size: 0.8rem; color: var(--ink); font-variant-numeric: tabular-nums; }
  td .note { color: var(--muted); font-family: var(--sans); font-size: 0.82rem; }
  .status { display: inline-block; font: 600 0.72rem/1 var(--mono); border-radius: 5px; padding: 0.3rem 0.5rem; }
  .status.s2 { color: var(--ok); background: var(--ok-dim); }
  .status.s4 { color: var(--bad); background: var(--bad-dim); }
  .facts { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 1rem; }
  .fact { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 1rem 1.2rem; display: flex; flex-direction: column; gap: 0.25rem; }
  .fact .f-num { font: 600 1.5rem/1.2 var(--serif); color: var(--gold); }
  .fact .f-lbl { font: 0.8rem/1.5 var(--sans); color: var(--muted); }
  footer.page { margin-top: 4rem; color: var(--muted); font-size: 0.9rem; }
  @media (max-width: 720px) {
    h1 { font-size: 2rem; }
    .arch { grid-template-columns: 1fr; }
    .event-card { grid-template-columns: 1fr; }
    .seq-badge { grid-row: auto; flex-direction: row; }
  }
  @media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <div class="eyebrow">Live demo · every value on this page came from the real API</div>
    <h1>Ledgerline, shown working</h1>
    <p class="lede">An append-only event-stream API on Cloudflare Workers. This page replays an actual recorded run (real requests, real responses, real SHA-256 digests) and explains what happens inside at each step.</p>
    <div class="chips">
      <span class="chip"><span class="dot"></span>Exactly-once appends</span>
      <span class="chip"><span class="dot"></span>Strong per-stream ordering</span>
      <span class="chip"><span class="dot"></span>Tamper-evident hash chain</span>
    </div>
  </header>

  <section class="section">
    <div class="eyebrow">The system in one picture</div>
    <h2>Where a write goes</h2>
    <p>The Worker at the edge is stateless; it authenticates and routes. The guarantees live in <strong>Durable Objects</strong>: tiny single-threaded actors, one per stream and one per API key. D1 (SQLite) is a read-only mirror for fast queries.</p>
    <div class="arch">
      <div class="arch-canvas">
        <div class="node"><div class="n-title">Client</div><div class="n-sub">Bearer key + Idempotency-Key</div></div>
        <div class="edge">HTTPS</div>
        <div class="node"><div class="n-title">Worker, Hono router</div><div class="n-sub">auth · rate-limit · route · mirror</div></div>
        <div class="edge">RPC, strongly consistent</div>
        <div class="duo">
          <div class="node"><div class="n-title">RateLimiterDO</div><div class="n-sub">1 per API key · token bucket</div></div>
          <div class="node authority"><div class="n-title">StreamDO ★ authority</div><div class="n-sub">seq · idempotency · hash chain</div></div>
        </div>
        <div class="edge">mirror after confirm (INSERT OR IGNORE)</div>
        <div class="node"><div class="n-title">D1 read model</div><div class="n-sub">paginated reads · eventually consistent</div></div>
      </div>
      <ol class="steps">
        <li><strong>Authenticate.</strong> The bearer key is SHA-256-hashed and looked up in D1. No plaintext keys anywhere.</li>
        <li><strong>Spend a token.</strong> The key's own RateLimiterDO must grant one token or the request ends 429.</li>
        <li><strong>Append.</strong> The stream's StreamDO assigns the next seq, links the hash chain, commits atomically.</li>
        <li><strong>Mirror.</strong> Only after the authority confirms does the Worker copy the event into D1 for reads.</li>
      </ol>
    </div>
  </section>

  <section class="section">
    <div class="eyebrow">Interactive · real data, real SHA-256</div>
    <h2>The chain, live. Try to tamper with it.</h2>
    <p>These are the three events from the recorded run, hashes byte-for-byte as the API returned them. Your browser is <strong>recomputing the chain right now</strong> with the same public rule the server uses. Edit any amount and watch <code>verify</code> catch it, then hit reset.</p>
    <div class="term">hash_0 = SHA-256("ledgerline:v1:" + streamId)                    <span class="c">genesis</span>
hash_n = SHA-256(hash_n-1 + "|" + canonicalJSON(payload) + "|" + seq)</div>

    <div class="demo-controls">
      <div class="verify-banner" id="verifyBanner"><span class="vb-icon">✓</span><span id="verifyText">GET /verify → { "valid": true }</span></div>
      <button class="reset" id="resetBtn" type="button">Reset payloads</button>
    </div>
    <div class="browser-check pending" id="browserCheck">recomputing chain in your browser…</div>

    <div class="chain" id="chain">
      <div class="genesis">genesis: SHA-256("ledgerline:v1:7221f193-c32f-4bed-b13e-d83a20fdf66c") = <span class="hash" id="genesisHash">…</span></div>
    </div>
    <p class="hint">In production, "editing a payload" means tampering with the Durable Object's storage directly; the test suite does exactly that and asserts <strong>verify reports the first broken seq</strong>. Every hash folds in the previous one, so one edit invalidates the entire suffix of the log. Deleting the newest events (truncation) is caught too: verify compares the recomputed head against the stream's meta.</p>
  </section>

  <section class="section">
    <div class="eyebrow">Recorded run · exactly-once</div>
    <h2>Retry it all you want. One event.</h2>
    <p>The client sent the same <code>Idempotency-Key</code> three times: once normally, once as a network-style retry, once as a <strong>retry with a different body</strong> (a buggy or malicious client). The ledger recorded exactly one event, and every retry got the original answer back.</p>
    <div class="term"><span class="c"># first append</span>
<span class="p">$ curl -X POST …/streams/7221f193/events -H 'Idempotency-Key: invoice-001' \\
    -d '{"type":"invoice.paid","invoice":"INV-001","amount":100,"currency":"USD"}'</span>
<span class="r">201 → {"seq":1,"hash":"<span class="hl">1a902c0da42aec20…</span>"}</span>

<span class="c"># same key, retried</span>
<span class="r">200 → {"seq":1,"hash":"<span class="hl">1a902c0da42aec20…</span>"}   <span class="g">Idempotent-Replay: true</span></span>

<span class="c"># same key, DIFFERENT body (amount: 99999)</span>
<span class="r">200 → {"seq":1,"hash":"<span class="hl">1a902c0da42aec20…</span>"}   <span class="g">Idempotent-Replay: true</span></span>

<span class="c"># the read model still holds the ORIGINAL payload, and it hashes to the stored hash</span>
<span class="r">GET …/events → payload: {"amount":<span class="g">100</span>,"currency":"USD","invoice":"INV-001",…}</span></div>
    <p>The key is authoritative: it's bound to the first event forever. That last line matters: an adversarial review of this codebase found (and we fixed) a subtle bug where a changed retry body could poison the read-model mirror. Now the Durable Object hands the mirror its canonical payload, so the stored payload <strong>always</strong> hashes to the stored hash.</p>
  </section>

  <section class="section">
    <div class="eyebrow">Recorded run · rate limiting</div>
    <h2>A token bucket that shows its math</h2>
    <p>This key was minted with <code>rate_per_min: 3</code>. Three requests spend the bucket; the fourth is refused, and the limiter tells the client exactly when to come back: 60 s ÷ 3 tokens = <strong>20 s to the next token</strong>.</p>
    <div class="tbl-wrap">
      <table>
        <thead><tr><th>request</th><th>status</th><th>RateLimit-Remaining</th><th>Retry-After</th></tr></thead>
        <tbody>
          <tr><td>POST /v1/streams #1</td><td><span class="status s2">201 Created</span></td><td>2</td><td>·</td></tr>
          <tr><td>POST /v1/streams #2</td><td><span class="status s2">201 Created</span></td><td>1</td><td>·</td></tr>
          <tr><td>POST /v1/streams #3</td><td><span class="status s2">201 Created</span></td><td>0</td><td>·</td></tr>
          <tr><td>POST /v1/streams #4</td><td><span class="status s4">429 Too Many</span></td><td>0</td><td>20 s</td></tr>
        </tbody>
      </table>
    </div>
    <p>Each API key gets its own single-threaded <code>RateLimiterDO</code>, so two simultaneous requests can never double-spend the same token: the same actor trick that gives streams their ordering.</p>
  </section>

  <section class="section">
    <div class="eyebrow">Recorded run · the error contract</div>
    <h2>Every failure is a clean, typed answer</h2>
    <p>One envelope everywhere: <code>{"error":{"code","message"}}</code>. And note the fourth row: asking about someone else's stream returns <strong>404, not 403</strong>, so the API never confirms that a stream exists.</p>
    <div class="tbl-wrap">
      <table>
        <thead><tr><th>scenario</th><th>status</th><th>code</th></tr></thead>
        <tbody>
          <tr><td>No Authorization header</td><td><span class="status s4">401</span></td><td>unauthorized</td></tr>
          <tr><td>Invalid API key</td><td><span class="status s4">401</span></td><td>unauthorized</td></tr>
          <tr><td>Append without Idempotency-Key</td><td><span class="status s4">400</span></td><td>idempotency_key_required</td></tr>
          <tr><td>Another key's stream <span class="note">(no existence leak)</span></td><td><span class="status s4">404</span></td><td>stream_not_found</td></tr>
          <tr><td>Body over 256 KiB</td><td><span class="status s4">413</span></td><td>payload_too_large</td></tr>
          <tr><td>Bucket empty</td><td><span class="status s4">429</span></td><td>rate_limited</td></tr>
          <tr><td>Wrong admin secret on POST /v1/keys</td><td><span class="status s4">403</span></td><td>forbidden</td></tr>
        </tbody>
      </table>
    </div>
  </section>

  <section class="section">
    <div class="eyebrow">How this was verified</div>
    <h2>Not just claimed: tested</h2>
    <div class="facts">
      <div class="fact"><span class="f-num">69</span><span class="f-lbl">tests across 14 files, run inside the real Workers runtime (workerd via Miniflare): actual Durable Objects, actual D1, no mocks. Built test-first, including truly concurrent appends and DO-eviction durability.</span></div>
      <div class="fact"><span class="f-num">41</span><span class="f-lbl">adversarial review agents across two audits; every confirmed bug fixed with a regression test, including a subtle hash-collision via own <code>__proto__</code> JSON keys, tail-truncation blindness in verify, and a fail-open admin guard.</span></div>
      <div class="fact"><span class="f-num">0</span><span class="f-lbl">type errors under TypeScript strict; clean conventional-commit history; typed 4xx limits on every input (no 500s from oversized or pathological payloads).</span></div>
    </div>
  </section>

  <footer class="page">
    Source, README, and API reference:
    <a href="https://github.com/aaguasvivas/ledgerline">github.com/aaguasvivas/ledgerline</a>
    · API base <code>/v1</code> · health <code>GET /health</code>
  </footer>
</div>

<script>
(function () {
  'use strict';

  var STREAM_ID = '7221f193-c32f-4bed-b13e-d83a20fdf66c';

  // Real events captured from a recorded run; hashes exactly as the API returned them.
  var EVENTS = [
    {
      seq: 1,
      payload: { amount: 100, currency: 'USD', invoice: 'INV-001', type: 'invoice.paid' },
      storedHash: '1a902c0da42aec20ad1249445ab94bc993d183e45021b3b23460e176400be1c5'
    },
    {
      seq: 2,
      payload: { amount: 250, currency: 'USD', invoice: 'INV-002', type: 'invoice.paid' },
      storedHash: '78b26ad78ca1f628ccd41085d737f7d7b286da9141e7936025758ece98178647'
    },
    {
      seq: 3,
      payload: { amount: -50, currency: 'USD', invoice: 'INV-001', type: 'invoice.refunded' },
      storedHash: '55c73ba9789c2d288f7c45a26fd24ded2a4f33e49648ec05138005764e0bb03b'
    }
  ];
  var ORIGINAL_AMOUNTS = EVENTS.map(function (e) { return e.payload.amount; });

  // Identical algorithm to src/lib/hash.ts (null-prototype accumulator included).
  function sortDeep(v) {
    if (Array.isArray(v)) return v.map(sortDeep);
    if (v !== null && typeof v === 'object') {
      var out = Object.create(null);
      Object.keys(v).sort().forEach(function (k) { out[k] = sortDeep(v[k]); });
      return out;
    }
    return v;
  }
  function canonicalize(v) { return JSON.stringify(sortDeep(v)); }
  function sha256Hex(s) {
    return crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)).then(function (buf) {
      return Array.prototype.map.call(new Uint8Array(buf), function (b) {
        return b.toString(16).padStart(2, '0');
      }).join('');
    });
  }

  var chainEl = document.getElementById('chain');
  var banner = document.getElementById('verifyBanner');
  var verifyText = document.getElementById('verifyText');
  var browserCheck = document.getElementById('browserCheck');
  var genesisEl = document.getElementById('genesisHash');

  function short(h) { return h ? h.slice(0, 16) + '…' : '…'; }

  EVENTS.forEach(function (ev, i) {
    var arrow = document.createElement('div');
    arrow.className = 'link-arrow';
    arrow.id = 'arrow-' + i;
    arrow.textContent = 'prevHash = hash of ' + (i === 0 ? 'genesis' : 'seq ' + (i));
    chainEl.appendChild(arrow);

    var card = document.createElement('div');
    card.className = 'event-card';
    card.id = 'card-' + i;
    card.innerHTML =
      '<div class="seq-badge">' + ev.seq + '<span>SEQ</span></div>' +
      '<div class="payload-row">' +
        '<span class="k">' + ev.payload.type + ' · ' + ev.payload.invoice + ' · amount:</span>' +
        '<input type="number" id="amt-' + i + '" value="' + ev.payload.amount + '" aria-label="amount for event ' + ev.seq + '">' +
        '<span class="k">' + ev.payload.currency + '</span>' +
      '</div>' +
      '<div class="hash-rows">' +
        '<div><span class="lbl">stored hash</span><span class="hash-val" id="stored-' + i + '">' + short(ev.storedHash) + '</span></div>' +
        '<div><span class="lbl">recomputed</span><span class="hash-val" id="recomp-' + i + '">…</span></div>' +
      '</div>' +
      '<div class="verdict ok" id="verdict-' + i + '"></div>';
    chainEl.appendChild(card);

    document.getElementById('amt-' + i).addEventListener('input', recompute);
  });

  document.getElementById('resetBtn').addEventListener('click', function () {
    EVENTS.forEach(function (_, i) {
      document.getElementById('amt-' + i).value = ORIGINAL_AMOUNTS[i];
    });
    recompute();
  });

  var runToken = 0;
  function recompute() {
    var token = ++runToken;
    sha256Hex('ledgerline:v1:' + STREAM_ID).then(function (genesis) {
      genesisEl.textContent = short(genesis);
      var prev = genesis;
      var chainPromise = Promise.resolve();
      var results = [];
      EVENTS.forEach(function (ev, i) {
        chainPromise = chainPromise.then(function () {
          var amt = Number(document.getElementById('amt-' + i).value);
          var payload = sortDeep(Object.assign({}, ev.payload, { amount: isNaN(amt) ? ev.payload.amount : amt }));
          return sha256Hex(prev + '|' + canonicalize(payload) + '|' + ev.seq).then(function (h) {
            results.push(h);
            prev = h; // verify() chains the RECOMPUTED value, like the server does
          });
        });
      });
      return chainPromise.then(function () { return results; });
    }).then(function (results) {
      if (token !== runToken) return; // a newer edit superseded this run
      var brokenAt = null;
      results.forEach(function (h, i) {
        var match = h === EVENTS[i].storedHash;
        if (!match && brokenAt === null) brokenAt = EVENTS[i].seq;
        var card = document.getElementById('card-' + i);
        var recompEl = document.getElementById('recomp-' + i);
        var verdictEl = document.getElementById('verdict-' + i);
        var arrowEl = document.getElementById('arrow-' + i);
        recompEl.textContent = short(h);
        recompEl.className = 'hash-val' + (match ? '' : ' mismatch');
        arrowEl.className = 'link-arrow' + (brokenAt !== null && EVENTS[i].seq > brokenAt ? ' dead' : '');
        if (match) {
          card.className = 'event-card';
          verdictEl.className = 'verdict ok';
          verdictEl.textContent = '✓ recomputed hash matches stored hash';
        } else if (EVENTS[i].seq === brokenAt) {
          card.className = 'event-card broken';
          verdictEl.className = 'verdict bad';
          verdictEl.textContent = '✗ divergence, the chain breaks HERE';
        } else {
          card.className = 'event-card downstream';
          verdictEl.className = 'verdict bad';
          verdictEl.textContent = '✗ invalid, inherits the break upstream';
        }
      });
      if (brokenAt === null) {
        banner.className = 'verify-banner';
        banner.firstElementChild.textContent = '✓';
        verifyText.textContent = 'GET /verify → { "valid": true }';
        browserCheck.className = 'browser-check';
        browserCheck.textContent = '✓ chain recomputed in your browser and matches the live API byte-for-byte';
      } else {
        banner.className = 'verify-banner broken';
        banner.firstElementChild.textContent = '✗';
        verifyText.textContent = 'GET /verify → { "valid": false, "brokenAt": ' + brokenAt + ' }';
        browserCheck.className = 'browser-check pending';
        browserCheck.textContent = 'payload edited: stored hashes no longer prove this history';
      }
    });
  }

  recompute();
})();
</script>
</body>
</html>`;
