/**
 * The page served at `/`: a one-page tour of the system around an interactive,
 * in-browser re-verification of a real recorded hash chain. Static (no auth,
 * no server state, no build step); the only per-request input is the origin,
 * used for absolute Open Graph URLs.
 */

/** The recorded stream the page replays. */
export const DEMO_STREAM_ID = '7221f193-c32f-4bed-b13e-d83a20fdf66c';

/**
 * Three events with the hashes the API assigns them under the current chain
 * version. test/landing.test.ts replays them through a real StreamDO, so the
 * page cannot drift from the server's hash rule.
 */
export const DEMO_EVENTS = [
  {
    seq: 1,
    idempotencyKey: 'invoice-001',
    payload: { type: 'invoice.paid', invoice: 'INV-001', amount: 100, currency: 'USD' },
    hash: '5a02b02016ac13025fd8b2b7c6d4f15165806def2a2e14853f152fc5ffc98526',
  },
  {
    seq: 2,
    idempotencyKey: 'invoice-002',
    payload: { type: 'invoice.paid', invoice: 'INV-002', amount: 250, currency: 'USD' },
    hash: 'a9ad4bb8a510c9593651eae43f5ad17bb4e9b5a4ce8907e3331cf9ef2ff1b905',
  },
  {
    seq: 3,
    idempotencyKey: 'refund-001',
    payload: { type: 'invoice.refunded', invoice: 'INV-001', amount: -50, currency: 'USD' },
    hash: '8f0f4f553936af0d0c0d9db27f6b0b5e85bb07ee16d81c5f510b29ead4233700',
  },
];

const REPO_URL = 'https://github.com/aaguasvivas/ledgerline';
const AUTHOR_URL = 'https://adelsonaguasvivas.com';
const TITLE = 'Ledgerline: an append-only log that can prove its own history';
const DESCRIPTION =
  'Exactly-once appends, gap-free ordering, and a SHA-256 hash chain anyone can re-verify. An event-stream API on Cloudflare Workers and Durable Objects.';

const short = (hash: string) => `${hash.slice(0, 16)}…`;

function escapeAttr(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

/** Render the page with absolute URLs for `origin` (e.g. https://host). */
export function renderLanding(origin: string): string {
  return PAGE.replaceAll('__ORIGIN__', escapeAttr(origin));
}

/** Server-rendered chain blocks, so the chain is visible before (or without) JS. */
const BLOCKS = DEMO_EVENTS.map((ev, i) => {
  const connector =
    i === 0
      ? ''
      : `<li class="link" id="link-${ev.seq}" aria-hidden="true"><span>prevHash</span></li>`;
  return `${connector}
        <li class="block" id="block-${ev.seq}">
          <div class="block-top">
            <span class="seq">#${ev.seq}</span>
            <span class="etype">${ev.payload.type} · ${ev.payload.invoice}</span>
          </div>
          <label class="amount">
            <span>amount</span>
            <input id="amt-${ev.seq}" type="number" inputmode="decimal" value="${ev.payload.amount}" aria-label="Amount for event ${ev.seq}">
            <span>${ev.payload.currency}</span>
          </label>
          <dl class="hashes">
            <div><dt>stored</dt><dd>${short(ev.hash)}</dd></div>
            <div><dt>recomputed</dt><dd id="re-${ev.seq}">computing…</dd></div>
          </dl>
          <p class="verdict" id="verdict-${ev.seq}">&nbsp;</p>
        </li>`;
}).join('');

const ICON = {
  repeat:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/></svg>',
  ordered:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 6h11M10 12h11M10 18h11"/><path d="M4 6h1v4"/><path d="M4 10h2"/><path d="M6 18H4c0-1 2-2 2-3s-1-1.5-2-1"/></svg>',
  link:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>',
  check:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>',
};

const LOGO =
  '<svg class="logo" viewBox="0 0 28 14" aria-hidden="true"><rect x="1" y="2" width="7" height="10" rx="2"/><rect x="10.5" y="2" width="7" height="10" rx="2"/><rect class="tip" x="20" y="2" width="7" height="10" rx="2"/></svg>';

const FAVICON =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%230B0E13'/%3E%3Cg fill='none' stroke='%23E3B341' stroke-width='2'%3E%3Crect x='3' y='11' width='7' height='10' rx='2'/%3E%3Crect x='12.5' y='11' width='7' height='10' rx='2'/%3E%3C/g%3E%3Crect x='22' y='11' width='7' height='10' rx='2' fill='%23E3B341'/%3E%3C/svg%3E";

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${TITLE}</title>
<meta name="description" content="${DESCRIPTION}">
<meta name="author" content="Adelson Aguasvivas">
<meta name="theme-color" content="#0B0E13">
<meta property="og:type" content="website">
<meta property="og:title" content="${TITLE}">
<meta property="og:description" content="${DESCRIPTION}">
<meta property="og:url" content="__ORIGIN__/">
<meta property="og:image" content="__ORIGIN__/og.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="Ledgerline: three hash-linked events and a passing verify">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" href="${FAVICON}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500;600&family=Source+Serif+4:ital,opsz,wght@0,8..60,600;1,8..60,600&display=swap">
<style>
  :root {
    color-scheme: dark;
    --bg: #0B0E13; --panel: #121821; --panel-2: #18202B; --line: #243041; --line-soft: #1A2230;
    --ink: #E8EDF3; --muted: #9AA5B4; --faint: #7A8594;
    --gold: #E3B341; --gold-ink: #1A1405; --gold-dim: rgba(227, 179, 65, 0.12);
    --ok: #3FBF73; --ok-dim: rgba(63, 191, 115, 0.12);
    --bad: #F2594F; --bad-dim: rgba(242, 89, 79, 0.12);
    --serif: "Source Serif 4", "Iowan Old Style", Georgia, serif;
    --sans: Inter, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    --mono: "JetBrains Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    --wide: 1120px;
  }
  * { box-sizing: border-box; }
  html { background: var(--bg); scroll-behavior: smooth; scroll-padding-top: 5rem; }
  body { margin: 0; background: var(--bg); color: var(--ink); font: 16.5px/1.65 var(--sans); -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility; }
  a { color: var(--gold); text-decoration-thickness: 1px; text-underline-offset: 3px; }
  a:hover { text-decoration-thickness: 2px; }
  :focus-visible { outline: 2px solid var(--gold); outline-offset: 3px; border-radius: 4px; }
  code { font: 0.86em var(--mono); background: var(--panel-2); border: 1px solid var(--line); border-radius: 5px; padding: 0.08em 0.38em; white-space: nowrap; }
  .wrap { max-width: var(--wide); margin: 0 auto; padding: 0 1.5rem; }
  .eyebrow { font: 500 0.72rem/1.4 var(--mono); letter-spacing: 0.14em; text-transform: uppercase; color: var(--gold); margin: 0; }
  h1, h2 { font-family: var(--serif); font-weight: 600; letter-spacing: -0.015em; text-wrap: balance; margin: 0; }
  h1 { font-size: clamp(2.5rem, 1.5rem + 3.9vw, 4.1rem); line-height: 1.04; letter-spacing: -0.025em; }
  h1 em { font-style: italic; color: var(--gold); }
  h2 { font-size: clamp(1.75rem, 1.3rem + 1.5vw, 2.4rem); line-height: 1.12; }
  h3 { font: 600 1.05rem/1.35 var(--sans); margin: 0; }
  p { margin: 0; }

  /* nav */
  .nav { position: sticky; top: 0; z-index: 10; background: rgba(11, 14, 19, 0.82); backdrop-filter: saturate(140%) blur(10px); -webkit-backdrop-filter: saturate(140%) blur(10px); border-bottom: 1px solid var(--line-soft); }
  .nav .wrap { display: flex; align-items: center; justify-content: space-between; height: 3.75rem; gap: 1rem; }
  .brand { display: inline-flex; align-items: center; gap: 0.6rem; color: var(--ink); text-decoration: none; font: 600 1.02rem/1 var(--sans); letter-spacing: -0.01em; }
  .logo { width: 28px; height: 14px; fill: none; stroke: var(--gold); stroke-width: 1.6; }
  .logo .tip { fill: var(--gold); }
  .nav ul { display: flex; gap: 1.6rem; list-style: none; margin: 0; padding: 0; font-size: 0.9rem; }
  .nav ul a { color: var(--muted); text-decoration: none; }
  .nav ul a:hover { color: var(--ink); }
  .nav .gh { color: var(--ink); }

  /* hero */
  .hero { position: relative; padding: 5.5rem 0 4.5rem; overflow: hidden; }
  .hero::before { content: ""; position: absolute; inset: -30% -10% auto 35%; height: 560px; background: radial-gradient(closest-side, rgba(227, 179, 65, 0.10), transparent); pointer-events: none; }
  .hero .wrap { position: relative; display: grid; grid-template-columns: minmax(0, 1.2fr) minmax(0, 0.8fr); gap: 4rem; align-items: center; }
  .hero-copy { display: flex; flex-direction: column; gap: 1.5rem; }
  .lede { font-size: 1.14rem; color: var(--muted); max-width: 37rem; }
  .lede strong { color: var(--ink); font-weight: 500; }
  .ctas { display: flex; flex-wrap: wrap; gap: 0.75rem; margin-top: 0.4rem; }
  .btn { display: inline-flex; align-items: center; gap: 0.5rem; font: 600 0.95rem/1 var(--sans); padding: 0.85rem 1.2rem; border-radius: 9px; text-decoration: none; border: 1px solid transparent; transition: transform 0.15s, background 0.15s, border-color 0.15s; }
  .btn:hover { transform: translateY(-1px); text-decoration: none; }
  .btn.primary { background: var(--gold); color: var(--gold-ink); }
  .btn.primary:hover { background: #EDC25A; }
  .btn.ghost { color: var(--ink); border-color: var(--line); background: var(--panel); }
  .btn.ghost:hover { border-color: var(--muted); }
  .btn svg { width: 1.05em; height: 1.05em; fill: currentColor; }
  .stack { font: 0.8rem/1.6 var(--mono); color: var(--faint); }

  .proof { background: linear-gradient(180deg, var(--panel), #0F141B); border: 1px solid var(--line); border-radius: 14px; padding: 1.4rem 1.4rem 1.2rem; box-shadow: 0 24px 60px -24px rgba(0, 0, 0, 0.7); font: 0.84rem/1.6 var(--mono); transition: border-color 0.3s; }
  .proof.broken { border-color: rgba(242, 89, 79, 0.55); }
  .proof-top { display: flex; align-items: center; gap: 0.55rem; color: var(--muted); font-size: 0.7rem; letter-spacing: 0.12em; text-transform: uppercase; }
  .pulse { width: 8px; height: 8px; border-radius: 50%; background: var(--ok); box-shadow: 0 0 0 0 rgba(63, 191, 115, 0.6); animation: pulse 2.4s infinite; }
  .proof.broken .pulse { background: var(--bad); animation: none; }
  @keyframes pulse { 0% { box-shadow: 0 0 0 0 rgba(63, 191, 115, 0.55); } 70% { box-shadow: 0 0 0 9px rgba(63, 191, 115, 0); } 100% { box-shadow: 0 0 0 0 rgba(63, 191, 115, 0); } }
  .proof-req { margin-top: 1.1rem; color: var(--ink); overflow-wrap: anywhere; }
  .proof-req .verb { color: var(--gold); font-weight: 600; margin-right: 0.4rem; }
  .proof-res { margin: 0.55rem 0 1rem; padding: 0.75rem 0.9rem; border-radius: 9px; background: var(--ok-dim); color: var(--ok); font: 600 0.95rem/1.4 var(--mono); border: 1px solid rgba(63, 191, 115, 0.3); transition: background 0.3s, color 0.3s, border-color 0.3s; }
  .proof.broken .proof-res { background: var(--bad-dim); color: var(--bad); border-color: rgba(242, 89, 79, 0.35); }
  .proof dl { margin: 0; display: grid; gap: 0.3rem; }
  .proof dl div { display: flex; justify-content: space-between; gap: 1rem; border-top: 1px dashed var(--line); padding-top: 0.3rem; }
  .proof dt { color: var(--muted); }
  .proof dd { margin: 0; color: var(--ink); text-align: right; }
  .proof dd.bad { color: var(--bad); }
  .proof-cta { display: inline-block; margin-top: 1rem; font: 600 0.8rem/1 var(--sans); }

  /* stats */
  .stats { border-top: 1px solid var(--line-soft); border-bottom: 1px solid var(--line-soft); background: rgba(18, 24, 33, 0.5); }
  .stats ul { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); }
  .stats li { padding: 1.6rem 1.5rem; border-left: 1px solid var(--line-soft); display: flex; flex-direction: column; gap: 0.3rem; }
  .stats li:first-child { border-left: none; padding-left: 0; }
  .stats b { font: 600 1.7rem/1.1 var(--serif); color: var(--ink); letter-spacing: -0.01em; }
  .stats span { font-size: 0.86rem; color: var(--muted); line-height: 1.5; }

  /* sections */
  main > section.wrap { margin-top: 6.5rem; }
  .head { display: flex; flex-direction: column; gap: 0.85rem; max-width: 46rem; margin-bottom: 2.25rem; }
  .head p:not(.eyebrow) { color: var(--muted); font-size: 1.05rem; }
  .head p strong { color: var(--ink); font-weight: 500; }

  /* tamper demo */
  .rule { font: 0.84rem/1.75 var(--mono); background: #090C10; border: 1px solid var(--line); border-radius: 12px; padding: 1rem 1.25rem; overflow-x: auto; white-space: pre; color: var(--ink); margin: 0 0 1.25rem; }
  .rule .c { color: var(--faint); }
  .rule .g { color: var(--gold); }
  .controls { display: flex; flex-wrap: wrap; align-items: center; gap: 0.75rem 1rem; margin-bottom: 1.25rem; }
  .banner { display: inline-flex; align-items: center; gap: 0.6rem; padding: 0.7rem 1rem; border-radius: 10px; font: 600 0.9rem/1.3 var(--mono); border: 1px solid rgba(63, 191, 115, 0.45); background: var(--ok-dim); color: var(--ok); transition: background 0.25s, border-color 0.25s, color 0.25s; }
  .banner.broken { border-color: rgba(242, 89, 79, 0.5); background: var(--bad-dim); color: var(--bad); }
  button.reset { font: 600 0.88rem/1 var(--sans); color: var(--ink); background: var(--panel-2); border: 1px solid var(--line); border-radius: 9px; padding: 0.7rem 1rem; cursor: pointer; }
  button.reset:hover { border-color: var(--gold); color: var(--gold); }
  .status { font: 0.8rem/1.5 var(--mono); color: var(--muted); }
  .status.ok { color: var(--ok); }
  .genesis { display: inline-flex; flex-wrap: wrap; gap: 0.25rem 0.6rem; font: 0.78rem/1.5 var(--mono); color: var(--muted); background: var(--panel); border: 1px dashed var(--line); border-radius: 9px; padding: 0.55rem 0.9rem; margin-bottom: 0.9rem; max-width: 100%; }
  .genesis .h { color: var(--gold); }
  .chain { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr) auto minmax(0, 1fr); align-items: stretch; }
  .block { background: var(--panel); border: 1px solid var(--line); border-top: 3px solid var(--ok); border-radius: 12px; padding: 1rem 1.1rem 0.9rem; display: flex; flex-direction: column; gap: 0.8rem; transition: border-color 0.25s, opacity 0.25s; min-width: 0; }
  .block.broken { border-color: var(--bad); border-top-color: var(--bad); box-shadow: 0 0 0 3px var(--bad-dim); }
  .block.downstream { border-top-color: var(--bad); opacity: 0.8; }
  .block-top { display: flex; align-items: baseline; gap: 0.6rem; }
  .seq { font: 600 1.05rem/1 var(--mono); color: var(--gold); }
  .etype { font: 0.76rem/1.4 var(--mono); color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .amount { display: flex; align-items: center; gap: 0.55rem; font: 0.8rem/1 var(--mono); color: var(--muted); }
  .amount input { font: 600 0.95rem/1.2 var(--mono); color: var(--ink); background: var(--panel-2); border: 1px solid var(--line); border-radius: 7px; width: 6.5rem; padding: 0.4rem 0.55rem; }
  .amount input:hover { border-color: var(--muted); }
  .amount input:focus { outline: 2px solid var(--gold); outline-offset: 1px; border-color: var(--gold); }
  .hashes { margin: 0; display: grid; gap: 0.2rem; font: 0.76rem/1.55 var(--mono); }
  .hashes div { display: flex; justify-content: space-between; gap: 0.75rem; }
  .hashes dt { color: var(--faint); }
  .hashes dd { margin: 0; color: var(--gold); }
  .hashes dd.mismatch { color: var(--bad); }
  .verdict { font: 600 0.74rem/1.4 var(--mono); color: var(--ok); }
  .verdict.bad { color: var(--bad); }
  .link { display: flex; align-items: center; justify-content: center; padding: 0 0.5rem; color: var(--gold); font: 0.66rem/1 var(--mono); letter-spacing: 0.04em; }
  .link span { display: flex; flex-direction: column; align-items: center; gap: 0.3rem; color: var(--faint); }
  .link span::after { content: "→"; font-size: 1.05rem; color: var(--gold); }
  .link.dead span::after { color: var(--bad); }
  .hint { margin-top: 1.25rem; font-size: 0.9rem; color: var(--muted); max-width: 52rem; }

  /* guarantees */
  .cards { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 1.1rem; }
  .card { background: var(--panel); border: 1px solid var(--line); border-radius: 14px; padding: 1.5rem 1.4rem 1.3rem; display: flex; flex-direction: column; gap: 0.8rem; }
  .card .ico { width: 2.4rem; height: 2.4rem; border-radius: 10px; display: grid; place-items: center; background: var(--gold-dim); color: var(--gold); }
  .card .ico svg, .proofline svg { width: 1.2rem; height: 1.2rem; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
  .card p { color: var(--muted); font-size: 0.94rem; }
  .card p code { font-size: 0.8rem; }
  .proofline { margin-top: auto; padding-top: 0.9rem; border-top: 1px solid var(--line-soft); display: flex; gap: 0.55rem; font: 0.76rem/1.55 var(--mono); color: var(--ink); }
  .proofline svg { flex: none; width: 1rem; height: 1rem; color: var(--ok); margin-top: 0.15rem; }

  /* architecture */
  .arch { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 0.9fr); gap: 2rem; align-items: start; }
  .diagram { background: var(--panel); border: 1px solid var(--line); border-radius: 14px; padding: 1.75rem 1.25rem; display: flex; flex-direction: column; align-items: center; }
  .node { border: 1px solid var(--line); background: var(--panel-2); border-radius: 10px; padding: 0.7rem 1.1rem; text-align: center; width: min(100%, 300px); }
  .node b { display: block; font: 600 0.92rem/1.35 var(--sans); }
  .node small { display: block; font: 0.7rem/1.5 var(--mono); color: var(--muted); }
  .node.auth { border-color: rgba(227, 179, 65, 0.6); background: var(--gold-dim); }
  .node.auth small { color: var(--gold); }
  .edge { display: flex; flex-direction: column; align-items: center; font: 0.68rem/1.3 var(--mono); color: var(--muted); padding: 0.35rem 0; text-align: center; }
  .edge::before { content: ""; width: 1px; height: 0.9rem; background: var(--line); margin-bottom: 0.3rem; }
  .edge::after { content: ""; width: 1px; height: 0.9rem; background: var(--line); margin-top: 0.3rem; }
  .pair { display: flex; gap: 0.75rem; width: 100%; justify-content: center; }
  .pair .node { width: auto; flex: 1 1 0; max-width: 220px; }
  .steps { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 1.1rem; counter-reset: step; }
  .steps li { counter-increment: step; display: grid; grid-template-columns: 2rem minmax(0, 1fr); gap: 0.8rem; color: var(--muted); font-size: 0.95rem; }
  .steps li::before { content: counter(step); font: 600 0.8rem/2rem var(--mono); color: var(--gold); background: var(--gold-dim); border-radius: 50%; width: 2rem; height: 2rem; text-align: center; }
  .steps strong { color: var(--ink); font-weight: 600; }

  /* recorded runs */
  .term { font: 0.82rem/1.75 var(--mono); background: #090C10; border: 1px solid var(--line); border-radius: 12px; padding: 1.1rem 1.3rem; overflow-x: auto; white-space: pre; margin: 0; }
  .term .c { color: var(--faint); }
  .term .q { color: var(--muted); }
  .term .s2 { color: var(--ok); font-weight: 600; }
  .term .s4 { color: var(--bad); font-weight: 600; }
  .term .h { color: var(--gold); }
  .after { margin-top: 1.25rem; color: var(--muted); max-width: 50rem; }
  .after strong { color: var(--ink); font-weight: 500; }
  .two { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 1.5rem; align-items: start; }
  .two h3 { margin-bottom: 0.4rem; }
  .two .sub { color: var(--muted); font-size: 0.92rem; margin-bottom: 1rem; }
  .tbl { border: 1px solid var(--line); border-radius: 12px; overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; background: var(--panel); font-size: 0.84rem; }
  th, td { text-align: left; padding: 0.6rem 0.9rem; border-bottom: 1px solid var(--line-soft); white-space: nowrap; }
  tr:last-child td { border-bottom: none; }
  th { font: 600 0.66rem/1 var(--mono); letter-spacing: 0.12em; text-transform: uppercase; color: var(--muted); background: var(--panel-2); }
  td { font-family: var(--mono); font-size: 0.78rem; font-variant-numeric: tabular-nums; }
  td.txt { font-family: var(--sans); font-size: 0.86rem; white-space: normal; }
  .pill { display: inline-block; font: 600 0.7rem/1 var(--mono); border-radius: 5px; padding: 0.3rem 0.45rem; }
  .pill.ok { color: var(--ok); background: var(--ok-dim); }
  .pill.bad { color: var(--bad); background: var(--bad-dim); }

  /* trade-offs + testing */
  .tradeoffs { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1.1rem; list-style: none; margin: 0; padding: 0; }
  .tradeoffs li { border-left: 2px solid var(--gold); padding: 0.2rem 0 0.2rem 1.1rem; color: var(--muted); font-size: 0.95rem; }
  .tradeoffs strong { display: block; color: var(--ink); font-weight: 600; margin-bottom: 0.25rem; }
  .testing { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 1.5rem; }
  .facts { display: grid; gap: 1rem; }
  .fact { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 1.1rem 1.25rem; }
  .fact b { display: block; font: 600 1.35rem/1.2 var(--serif); color: var(--gold); margin-bottom: 0.25rem; }
  .fact span { color: var(--muted); font-size: 0.92rem; }
  .bugs { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 1.3rem 1.4rem; }
  .bugs h3 { margin-bottom: 0.9rem; }
  .bugs ul { margin: 0; padding: 0; list-style: none; display: grid; gap: 0.7rem; }
  .bugs li { position: relative; padding-left: 1.4rem; font-size: 0.92rem; color: var(--muted); }
  .bugs li::before { content: ""; position: absolute; left: 0; top: 0.55rem; width: 0.5rem; height: 0.5rem; border-radius: 2px; background: var(--gold); }

  /* footer */
  footer { margin-top: 7rem; border-top: 1px solid var(--line-soft); padding: 2.5rem 0 3rem; }
  footer .wrap { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 1.25rem; align-items: center; }
  footer p { color: var(--muted); font-size: 0.92rem; }
  footer p strong { color: var(--ink); font-weight: 600; }
  footer ul { display: flex; flex-wrap: wrap; gap: 1.4rem; list-style: none; margin: 0; padding: 0; font-size: 0.9rem; }

  @media (max-width: 960px) {
    .hero { padding-top: 3.5rem; }
    .hero .wrap, .arch, .two, .testing { grid-template-columns: minmax(0, 1fr); }
    .hero .wrap { gap: 2.75rem; }
    .cards { grid-template-columns: minmax(0, 1fr); }
    .stats ul { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .stats li:nth-child(3) { border-left: none; padding-left: 0; }
    .stats li:nth-child(n+3) { border-top: 1px solid var(--line-soft); }
    .chain { grid-template-columns: minmax(0, 1fr); }
    .link { padding: 0.4rem 0; }
    .link span { flex-direction: row; }
    .link span::after { content: "↓"; }
    .tradeoffs { grid-template-columns: minmax(0, 1fr); }
  }
  @media (max-width: 640px) {
    body { font-size: 16px; }
    .wrap { padding: 0 1rem; }
    .nav ul li:not(:last-child) { display: none; }
    main > section.wrap { margin-top: 4.75rem; }
    .stats li { padding: 1.2rem 1rem 1.2rem 0; }
    .stats li:nth-child(even) { padding-left: 1rem; }
    .stats b { font-size: 1.4rem; }
    th, td { padding: 0.55rem 0.65rem; }
    .rule { font-size: 0.76rem; }
  }
  @media (prefers-reduced-motion: reduce) {
    html { scroll-behavior: auto; }
    *, *::before, *::after { transition: none !important; animation: none !important; }
  }
</style>
</head>
<body>
<nav class="nav" aria-label="Primary">
  <div class="wrap">
    <a class="brand" href="/">${LOGO}Ledgerline</a>
    <ul>
      <li><a href="#tamper">Demo</a></li>
      <li><a href="#how">How it works</a></li>
      <li><a href="#tradeoffs">Trade-offs</a></li>
      <li><a class="gh" href="${REPO_URL}">GitHub ↗</a></li>
    </ul>
  </div>
</nav>

<header class="hero">
  <div class="wrap">
    <div class="hero-copy">
      <p class="eyebrow">Event-stream API · Cloudflare Workers + Durable Objects</p>
      <h1>An append-only log that can <em>prove</em> its own history.</h1>
      <p class="lede">Ledgerline gives every stream three guarantees that are easy to claim and hard to get right: <strong>exactly-once writes</strong> under retries, <strong>gap-free ordering</strong> under concurrency, and a <strong>SHA-256 hash chain</strong> that exposes any edit to the past. Each stream is its own single-threaded Durable Object, so it needs no locks and no consensus protocol.</p>
      <div class="ctas">
        <a class="btn primary" href="#tamper">Try to tamper with it ↓</a>
        <a class="btn ghost" href="${REPO_URL}"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8Z"/></svg>Read the source</a>
      </div>
      <p class="stack">TypeScript (strict) · Hono · Durable Objects · D1 · Vitest in workerd</p>
    </div>

    <aside class="proof" id="proof" aria-label="Live verification of the demo chain">
      <div class="proof-top"><span class="pulse"></span>Live · recomputed in your browser</div>
      <div class="proof-req"><span class="verb">GET</span>/v1/streams/7221f193…/verify</div>
      <div class="proof-res" id="proofRes">{ "valid": true }</div>
      <dl>
        <div><dt>events</dt><dd>${DEMO_EVENTS.length}</dd></div>
        <div><dt>links that hold</dt><dd id="proofLinks">${DEMO_EVENTS.length} / ${DEMO_EVENTS.length}</dd></div>
        <div><dt>recomputed head</dt><dd id="proofHead">${short(DEMO_EVENTS[DEMO_EVENTS.length - 1].hash)}</dd></div>
      </dl>
      <a class="proof-cta" href="#tamper">Edit a payload and watch this change ↓</a>
    </aside>
  </div>
</header>

<div class="stats">
  <div class="wrap"><ul>
    <li><b>88 tests</b><span>in the real Workers runtime, against real Durable Objects and D1. No mocks.</span></li>
    <li><b>RFC 8785</b><span>canonical JSON, so any standard library can re-verify a chain.</span></li>
    <li><b>1 actor</b><span>per stream. Ordering comes from the platform, not from locks.</span></li>
    <li><b>1 call</b><span>re-walks the whole chain and names the first broken event.</span></li>
  </ul></div>
</div>

<main>
<section id="tamper" class="wrap">
  <div class="head">
    <p class="eyebrow">Interactive · real hashes, recomputed in your browser</p>
    <h2>Go ahead. Rewrite history.</h2>
    <p>These three events and their hashes come from a recorded run of the API. Your browser is recomputing the chain <strong>right now</strong> with the same public rule the server uses. Change any amount and watch <code>verify</code> find the exact event you touched, and every event after it go invalid.</p>
  </div>

  <div class="rule"><span class="g">hash_0</span> = SHA-256("ledgerline:v2:" + streamId)                  <span class="c">genesis</span>
<span class="g">hash_n</span> = SHA-256(hash_n-1 + "|" + JCS(payload_n) + "|" + n)    <span class="c">JCS = RFC 8785 canonical JSON</span></div>

  <div class="controls">
    <div class="banner" id="banner" role="status" aria-live="polite">GET /verify → { "valid": true }</div>
    <button class="reset" id="reset" type="button">Reset payloads</button>
    <span class="status" id="status">recomputing chain in your browser…</span>
  </div>

  <div class="genesis"><span>genesis = SHA-256("ledgerline:v2:${DEMO_STREAM_ID}")</span><span>= <span class="h" id="genesis">…</span></span></div>
  <ol class="chain" id="chain">${BLOCKS}
  </ol>
  <p class="hint">On the server, "editing a payload" means writing to the Durable Object's storage directly. The test suite does exactly that, and also forges a <code>prevHash</code>, deletes a middle event, and truncates the tail. Each time, <code>verify</code> must name the first broken seq.</p>
</section>

<section id="how" class="wrap">
  <div class="head">
    <p class="eyebrow">The guarantees</p>
    <h2>Three promises, each with a mechanism and a test that holds it to account.</h2>
  </div>
  <div class="cards">
    <article class="card">
      <div class="ico">${ICON.repeat}</div>
      <h3>Exactly-once appends</h3>
      <p>Every write carries an <code>Idempotency-Key</code>, recorded in the same atomic write as the event. A retry gets the original <code>{seq, hash}</code> back with <code>Idempotent-Replay: true</code>. Reusing a key with a different body is a <code>422</code>, never a silent success.</p>
      <div class="proofline">${ICON.check}<span>5 concurrent requests racing one key leave exactly 1 event.</span></div>
    </article>
    <article class="card">
      <div class="ico">${ICON.ordered}</div>
      <h3>Gap-free ordering</h3>
      <p>Each stream is one Durable Object: a single-threaded actor with its own storage. Appends run in a <code>blockConcurrencyWhile</code> critical section, so <code>seq</code> is strictly increasing, with no gaps and no duplicates.</p>
      <div class="proofline">${ICON.check}<span>20 in-flight appends, crypto await forced to yield: seq 1 to 20. Remove the guard and it fails.</span></div>
    </article>
    <article class="card">
      <div class="ico">${ICON.link}</div>
      <h3>Tamper evidence</h3>
      <p>Each hash folds in the previous hash, the payload's RFC 8785 canonical form, and the seq. <code>GET /verify</code> re-walks the chain, checks <code>seq</code>, <code>prevHash</code>, and <code>hash</code>, then checks the result against the committed head.</p>
      <div class="proofline">${ICON.check}<span>Edited payloads, forged links, deleted and truncated events: each caught at the first broken seq.</span></div>
    </article>
  </div>
</section>

<section id="architecture" class="wrap">
  <div class="head">
    <p class="eyebrow">Architecture</p>
    <h2>Where a write goes.</h2>
    <p>The Worker is a stateless front door. <strong>Durable Objects hold the guarantees</strong>: one per stream, one per API key. D1 is a query-friendly read model that may trail the authority by milliseconds, but can never silently lose an event.</p>
  </div>
  <div class="arch">
    <div class="diagram" role="img" aria-label="Client to Worker over HTTPS; Worker to RateLimiterDO and StreamDO over RPC; StreamDO to the D1 read model via an inline mirror and an outbox alarm">
      <div class="node"><b>Client</b><small>Bearer key · Idempotency-Key</small></div>
      <div class="edge">HTTPS</div>
      <div class="node"><b>Worker (Hono)</b><small>auth · rate limit · route · project</small></div>
      <div class="edge">RPC, strongly consistent</div>
      <div class="pair">
        <div class="node"><b>RateLimiterDO</b><small>1 per key · token bucket</small></div>
        <div class="node auth"><b>StreamDO</b><small>authority · 1 per stream</small></div>
      </div>
      <div class="edge">inline mirror, then outbox alarm<br>until delivered (INSERT OR IGNORE)</div>
      <div class="node"><b>D1 read model</b><small>paginated reads · eventually consistent</small></div>
    </div>
    <ol class="steps">
      <li><span><strong>Authenticate.</strong> The bearer key is SHA-256 hashed and looked up in D1. Keys are never stored in plaintext, and someone else's stream is a <code>404</code>, so existence never leaks.</span></li>
      <li><span><strong>Spend a token.</strong> The key's own <code>RateLimiterDO</code> grants one, or the request ends in <code>429</code> with <code>Retry-After</code>.</span></li>
      <li><span><strong>Commit.</strong> The stream's <code>StreamDO</code> checks the key, assigns the next seq, and links the hash. Event, key record, rollup, head, and outbox alarm land in one atomic write.</span></li>
      <li><span><strong>Project.</strong> The Worker copies the event into D1 for fast reads. If that write fails, the client still gets its <code>201</code>, and the outbox alarm keeps retrying until D1 has it.</span></li>
    </ol>
  </div>
</section>

<section id="retries" class="wrap">
  <div class="head">
    <p class="eyebrow">Recorded run · exactly-once</p>
    <h2>Retry all you want. It is still one event.</h2>
    <p>The same <code>Idempotency-Key</code>, three times: the original request, a network-style retry, and a buggy retry that changed the amount.</p>
  </div>
<pre class="term"><span class="c"># 1. the original append</span>
<span class="q">→ POST /v1/streams/7221f193…/events   Idempotency-Key: invoice-001</span>
<span class="q">  {"type":"invoice.paid","invoice":"INV-001","amount":100,"currency":"USD"}</span>
<span class="s2">← 201</span> {"seq":1,"hash":"<span class="h">5a02b02016ac1302…</span>"}

<span class="c"># 2. same key, same body: a timeout made the client retry</span>
<span class="s2">← 200</span> {"seq":1,"hash":"<span class="h">5a02b02016ac1302…</span>"}   <span class="s2">Idempotent-Replay: true</span>

<span class="c"># 3. same key, DIFFERENT body ("amount": 99999)</span>
<span class="s4">← 422</span> {"error":{"code":"idempotency_key_reused","message":"Idempotency-Key was already used for seq 1 with a different payload"}}</pre>
  <p class="after">The third answer matters most. A client that reuses a key by mistake <strong>is told so</strong>, instead of receiving a success for a write that never happened. Bodies are compared in canonical form, so an honest retry that only reorders keys still replays.</p>
</section>

<section id="limits" class="wrap">
  <div class="two">
    <div>
      <p class="eyebrow">Recorded run · rate limiting</p>
      <h3 style="margin-top:0.6rem">A token bucket that shows its math</h3>
      <p class="sub">A key minted with <code>rate_per_min: 3</code>. The fourth request is refused, with the exact wait: 60 s ÷ 3 tokens = 20 s.</p>
      <div class="tbl"><table>
        <thead><tr><th>request</th><th>status</th><th>remaining</th><th>retry-after</th></tr></thead>
        <tbody>
          <tr><td>POST /v1/streams</td><td><span class="pill ok">201</span></td><td>2</td><td>·</td></tr>
          <tr><td>POST /v1/streams</td><td><span class="pill ok">201</span></td><td>1</td><td>·</td></tr>
          <tr><td>POST /v1/streams</td><td><span class="pill ok">201</span></td><td>0</td><td>·</td></tr>
          <tr><td>POST /v1/streams</td><td><span class="pill bad">429</span></td><td>0</td><td>20 s</td></tr>
        </tbody>
      </table></div>
    </div>
    <div>
      <p class="eyebrow">The error contract</p>
      <h3 style="margin-top:0.6rem">Every failure is a typed answer</h3>
      <p class="sub">One envelope everywhere: <code>{"error":{"code","message"}}</code>. Bad input is a clean <code>4xx</code>, never a <code>500</code>.</p>
      <div class="tbl"><table>
        <thead><tr><th>scenario</th><th>status</th><th>code</th></tr></thead>
        <tbody>
          <tr><td class="txt">Missing or unknown API key</td><td><span class="pill bad">401</span></td><td>unauthorized</td></tr>
          <tr><td class="txt">Someone else's stream</td><td><span class="pill bad">404</span></td><td>stream_not_found</td></tr>
          <tr><td class="txt">No Idempotency-Key</td><td><span class="pill bad">400</span></td><td>idempotency_key_required</td></tr>
          <tr><td class="txt">Key reused, different body</td><td><span class="pill bad">422</span></td><td>idempotency_key_reused</td></tr>
          <tr><td class="txt">Body over 256 KiB</td><td><span class="pill bad">413</span></td><td>payload_too_large</td></tr>
          <tr><td class="txt">Bucket empty</td><td><span class="pill bad">429</span></td><td>rate_limited</td></tr>
        </tbody>
      </table></div>
    </div>
  </div>
</section>

<section id="tradeoffs" class="wrap">
  <div class="head">
    <p class="eyebrow">Design review</p>
    <h2>Trade-offs, stated plainly.</h2>
    <p>Every guarantee here has a price. These are the ones I would raise first in a design review.</p>
  </div>
  <ul class="tradeoffs">
    <li><strong>One stream, one actor.</strong>Ordering is cheap because a stream never spans machines. That also caps one stream's write rate at what a single Durable Object can serialize. Scale comes from many streams, not one hot one.</li>
    <li><strong>Tamper-evident, not tamper-proof.</strong>Someone able to rewrite all of storage could rebuild a self-consistent chain. Clients that keep the hashes they were handed will see the head change; anchoring heads externally (signed checkpoints, a transparency log) would close the gap.</li>
    <li><strong>Verification is O(n).</strong><code>verify</code> re-walks the whole stream every time. A long-lived stream would want signed checkpoints so each verify starts from the last one.</li>
    <li><strong>Idempotency keys never expire.</strong>A retry is safe at any distance in time, at the cost of one small record per event for the life of the stream. Stripe's keys, for comparison, expire after 24 hours.</li>
    <li><strong>Reads can trail writes.</strong><code>head</code>, <code>stats</code>, and <code>verify</code> read the authority. Paginated <code>events</code> read D1, which can lag by milliseconds and which the outbox guarantees will catch up.</li>
    <li><strong>One region per stream.</strong>A Durable Object lives in one location, so far-away clients pay a round trip on writes. That is the price of a single, strongly consistent order.</li>
  </ul>
</section>

<section id="testing" class="wrap">
  <div class="head">
    <p class="eyebrow">Verification</p>
    <h2>Not just claimed: tested.</h2>
  </div>
  <div class="testing">
    <div class="facts">
      <div class="fact"><b>88 tests, 14 files</b><span>Run inside workerd, the real Workers runtime, against real Durable Objects and a local D1. Nothing about the platform is mocked.</span></div>
      <div class="fact"><b>Mechanisms, not just outcomes</b><span>Concurrency tests force the race the code defends against, and fail if <code>blockConcurrencyWhile</code> is removed. Outage tests break D1 and require the read model to converge anyway.</span></div>
      <div class="fact"><b>Conformance vectors</b><span>The canonical form is pinned to RFC 8785's own worked examples, plus known-answer SHA-256 vectors that would catch any change to the chain rule.</span></div>
    </div>
    <div class="bugs">
      <h3>Found in review, fixed, and pinned by a regression test</h3>
      <ul>
        <li>An own <code>"__proto__"</code> key silently dropped from the hashed form.</li>
        <li>Numeric-string keys ("9", "10") serialized out of RFC 8785 order.</li>
        <li><code>verify</code> blind to a truncated tail, and to a forged <code>prevHash</code>.</li>
        <li>A retry with a different body answered as a successful replay.</li>
        <li>A failed D1 write leaving a permanent hole in the read model.</li>
        <li>An oversized upload buffered in full before its size was checked.</li>
        <li>An admin guard that failed open when its secret was unset.</li>
      </ul>
    </div>
  </div>
</section>
</main>

<footer>
  <div class="wrap">
    <p>Designed and built by <a href="${AUTHOR_URL}"><strong>Adelson Aguasvivas</strong></a></p>
    <ul>
      <li><a href="${REPO_URL}">Source</a></li>
      <li><a href="${REPO_URL}#api-reference">API reference</a></li>
      <li><a href="/health">GET /health</a></li>
      <li><a href="${REPO_URL}/blob/main/LICENSE">MIT license</a></li>
    </ul>
  </div>
</footer>

<script>
(function () {
  'use strict';

  var STREAM_ID = ${JSON.stringify(DEMO_STREAM_ID)};
  var EVENTS = ${JSON.stringify(DEMO_EVENTS)};

  // Same rule as src/lib/hash.ts: RFC 8785 canonical JSON, members emitted
  // explicitly so integer-like keys sort as strings.
  function canonicalize(v) {
    if (Array.isArray(v)) return '[' + v.map(canonicalize).join(',') + ']';
    if (v !== null && typeof v === 'object') {
      return '{' + Object.keys(v).sort().map(function (k) {
        return JSON.stringify(k) + ':' + canonicalize(v[k]);
      }).join(',') + '}';
    }
    return JSON.stringify(v);
  }
  function sha256Hex(text) {
    return crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)).then(function (buf) {
      return Array.prototype.map.call(new Uint8Array(buf), function (b) {
        return b.toString(16).padStart(2, '0');
      }).join('');
    });
  }
  function short(h) { return h.slice(0, 16) + '…'; }
  function $(id) { return document.getElementById(id); }

  if (!window.crypto || !crypto.subtle) {
    $('status').textContent = 'your browser cannot compute SHA-256 here (it needs a secure context)';
    return;
  }

  var run = 0;
  function recompute() {
    var token = ++run;
    var hashes = [];
    var chain = sha256Hex('ledgerline:v2:' + STREAM_ID).then(function (genesis) {
      $('genesis').textContent = short(genesis);
      return genesis;
    });
    EVENTS.forEach(function (ev) {
      chain = chain.then(function (prev) {
        var raw = $('amt-' + ev.seq).value;
        var amount = raw === '' ? NaN : Number(raw);
        var payload = Object.assign({}, ev.payload, { amount: isFinite(amount) ? amount : raw });
        return sha256Hex(prev + '|' + canonicalize(payload) + '|' + ev.seq).then(function (h) {
          hashes.push(h);
          return h; // verify chains the RECOMPUTED hash, as the server does
        });
      });
    });
    chain.then(function () {
      if (token !== run) return; // a newer edit superseded this run
      render(hashes);
    });
  }

  function render(hashes) {
    var brokenAt = null;
    EVENTS.forEach(function (ev, i) {
      var ok = hashes[i] === ev.hash;
      if (!ok && brokenAt === null) brokenAt = ev.seq;
      var re = $('re-' + ev.seq);
      re.textContent = short(hashes[i]);
      re.className = ok ? '' : 'mismatch';
      var link = $('link-' + ev.seq);
      if (link) link.className = 'link' + (brokenAt !== null && ev.seq > brokenAt ? ' dead' : '');
      var block = $('block-' + ev.seq);
      var verdict = $('verdict-' + ev.seq);
      if (ok) {
        block.className = 'block';
        verdict.className = 'verdict';
        verdict.textContent = '✓ link holds';
      } else if (ev.seq === brokenAt) {
        block.className = 'block broken';
        verdict.className = 'verdict bad';
        verdict.textContent = '✗ chain breaks here';
      } else {
        block.className = 'block downstream';
        verdict.className = 'verdict bad';
        verdict.textContent = '✗ invalid: built on a broken link';
      }
    });

    var holding = brokenAt === null ? EVENTS.length : brokenAt - 1;
    var result = brokenAt === null
      ? '{ "valid": true }'
      : '{ "valid": false, "brokenAt": ' + brokenAt + ' }';
    $('banner').className = 'banner' + (brokenAt === null ? '' : ' broken');
    $('banner').textContent = 'GET /verify → ' + result;
    $('proof').className = 'proof' + (brokenAt === null ? '' : ' broken');
    $('proofRes').textContent = result;
    $('proofLinks').textContent = holding + ' / ' + EVENTS.length;
    $('proofLinks').className = brokenAt === null ? '' : 'bad';
    $('proofHead').textContent = short(hashes[hashes.length - 1]);
    $('proofHead').className = brokenAt === null ? '' : 'bad';
    var status = $('status');
    if (brokenAt === null) {
      status.className = 'status ok';
      status.textContent = '✓ recomputed in your browser: matches the API byte for byte';
    } else {
      status.className = 'status';
      status.textContent = 'the stored hashes no longer vouch for this history';
    }
  }

  EVENTS.forEach(function (ev) { $('amt-' + ev.seq).addEventListener('input', recompute); });
  $('reset').addEventListener('click', function () {
    EVENTS.forEach(function (ev) { $('amt-' + ev.seq).value = ev.payload.amount; });
    recompute();
  });
  recompute();
})();
</script>
</body>
</html>`;
