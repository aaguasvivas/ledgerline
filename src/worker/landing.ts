/** A tiny, dependency-free landing page served at `/`. */
export const LANDING_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Ledgerline</title>
<style>
  :root { color-scheme: dark; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center;
    font: 16px/1.6 ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
    background: #0b0f14; color: #e6edf3;
  }
  main { max-width: 46rem; padding: 3rem 1.5rem; }
  h1 { font-size: 2.5rem; margin: 0 0 .25rem; letter-spacing: -0.02em; }
  .tag { color: #7d8590; margin: 0 0 2rem; }
  ul { list-style: none; padding: 0; display: grid; gap: .75rem; }
  li { padding: 1rem 1.25rem; background: #11161d; border: 1px solid #21262d; border-radius: .6rem; }
  b { color: #58a6ff; }
  code { background: #161b22; padding: .15rem .4rem; border-radius: .3rem; color: #d2a8ff; }
  a { color: #58a6ff; }
  footer { margin-top: 2rem; color: #7d8590; font-size: .9rem; }
</style>
</head>
<body>
<main>
  <h1>Ledgerline</h1>
  <p class="tag">Append-only event streams with exactly-once writes, strong ordering, and a tamper-evident hash chain, at the edge.</p>
  <ul>
    <li><b>Exactly-once appends.</b> Client idempotency keys collapse retries to a single event.</li>
    <li><b>Strong per-stream ordering.</b> A single-threaded Durable Object serializes every append.</li>
    <li><b>Tamper-evident audit log.</b> A SHA-256 hash chain you can verify end-to-end in one call.</li>
  </ul>
  <footer>
    API base: <code>/v1</code> &middot; health: <code>GET /health</code> &middot;
    verify: <code>GET /v1/streams/:id/verify</code> &middot; docs: <code>README.md</code>
  </footer>
</main>
</body>
</html>`;
