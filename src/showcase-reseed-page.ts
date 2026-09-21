/**
 * The page that refills the showcase.
 *
 * A page of its own rather than a button in the application, because the demo
 * exists to be photographed and a Refill button would appear in the article.
 *
 * It is also the only way the demo moves onto a newer release. Nothing in the
 * release switch restarts the showcase, and `WorkingDirectory` is resolved once
 * at start, so a demo left alone serves whatever release it booted with — for
 * four months, the first time this went unnoticed. A reseed stops and starts
 * the service, so asking for one is also asking for the current code.
 *
 * The work happens in a root oneshot, not here; see `src/showcase-control.ts`
 * for why. That means the service is stopped for the middle of it, and the
 * browser cannot reach this server while it is. So the page polls with `fetch`
 * from a document that has already loaded, and treats a failed request as
 * "still down" rather than as an error — which is exactly what it is.
 */
import { SHOWCASE_LIMITS } from './showcase.js';
import type { ShowcaseReseedStatus } from './showcase-control.js';

const escape = (value: string): string =>
  value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[character]!,
  );

const field = (
  name: keyof typeof SHOWCASE_LIMITS,
  label: string,
  note: string,
  step: string,
): string => {
  const limit = SHOWCASE_LIMITS[name];
  return (
    `<label><span class="name">${escape(label)}</span>` +
    `<input type="number" name="${name}" value="${limit.default}" ` +
    `min="${limit.min}" max="${limit.max}" step="${step}" required>` +
    `<span class="note">${escape(note)} · ${limit.min}–${limit.max}</span>` +
    `</label>`
  );
};

/** A timestamp somebody can read, in UTC because the server states dates in it. */
const readable = (iso: string): string => {
  const at = new Date(iso);
  return Number.isNaN(at.getTime())
    ? iso
    : `${at.toISOString().slice(0, 10)} at ${at.toISOString().slice(11, 16)} UTC`;
};

/** What the last reseed did, in a sentence, or nothing when there was none. */
function summary(status: ShowcaseReseedStatus | null): string {
  if (!status) return '';
  const when = readable(status.finishedAt ?? status.requestedAt);
  if (status.state === 'failed')
    return (
      `<p class="bad"><strong>The last refill failed.</strong> ` +
      `${escape(status.error ?? 'No reason was recorded.')} ` +
      `The workspace may hold part of two households; refill it again before ` +
      `photographing anything.</p>`
    );
  if (status.state === 'done') {
    const counts = status.counts ?? {};
    const parts = [
      counts.transactions && `${counts.transactions} payments`,
      counts.holdings && `${counts.holdings} holdings`,
      counts.refunds && `${counts.refunds} linked refunds`,
      counts.receipts && `${counts.receipts} receipts`,
      counts.rates && `${counts.rates} daily rates`,
    ].filter(Boolean);
    return (
      `<p class="good">Last refilled ${escape(when)} — ${parts.join(', ')}` +
      (status.release
        ? `, on release ${escape(status.release.slice(0, 7))}`
        : '') +
      `.</p>`
    );
  }
  return `<p class="busy">A refill asked for ${escape(when)} is still running.</p>`;
}

export function showcaseReseedPage(
  csrf: string,
  status: ShowcaseReseedStatus | null,
): string {
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>Refill the showcase</title>` +
    `<link rel="stylesheet" href="/style.css">` +
    `<style>
      body{max-width:34rem;margin:0 auto;padding:1.5rem}
      form{display:grid;gap:1.1rem;margin:1.5rem 0}
      label{display:grid;gap:.25rem}
      .name{font-weight:600}
      .note{font-size:.85rem;opacity:.7}
      input{padding:.45rem .6rem;font:inherit;width:100%;box-sizing:border-box}
      button{padding:.6rem 1.1rem;font:inherit;cursor:pointer}
      .good{opacity:.8}
      .bad{font-weight:600}
      .busy{opacity:.8}
      #progress{display:none;margin:1.5rem 0;padding:1rem;border:1px solid currentColor}
      #progress h2{margin:0 0 .4rem;font-size:1rem}
      #progress p{margin:.3rem 0}
    </style></head><body>` +
    `<h1>Refill the showcase</h1>` +
    `<p>Replaces the invented household with a freshly generated one, and ` +
    `restarts the demo onto the release the server currently has. The people ` +
    `and their spending come out the same every time; what changes is that ` +
    `the dates end today, so &ldquo;this month&rdquo; is current again and ` +
    `every day has an exchange rate.</p>` +
    `<p><strong>The demo is down while this runs</strong> — a few minutes, ` +
    `longer if you ask for more than the default. This page keeps watching ` +
    `and says when it is back.</p>` +
    summary(status) +
    `<form id="form" method="post" action="/showcase/reseed">` +
    `<input type="hidden" name="csrf" value="${escape(csrf)}">` +
    field(
      'density',
      'Payment density',
      'Multiple of about eighty a month',
      '0.25',
    ) +
    field(
      'months',
      'Months of history',
      'How far back the ledger reaches',
      '1',
    ) +
    field(
      'refunds',
      'Refunds',
      'Pairs across the window, in four shapes',
      '1',
    ) +
    field('receipts', 'Receipts', 'Of the five slips that exist', '1') +
    `<button type="submit">Refill</button></form>` +
    `<div id="progress"><h2 id="state">Asking…</h2><p id="detail"></p></div>` +
    `<p><a href="/">Back to the application</a></p>` +
    // Its own route rather than inline: the policy this server sends is
    // `script-src 'self'`, which blocks an inline script, and the policy is
    // worth more than the convenience. The first version of this page had the
    // script inline, and the form submitted normally — navigating to the JSON
    // the POST returns, on a server about to stop answering.
    `<script src="/showcase/reseed.js"></script>` +
    `</body></html>`
  );
}

/**
 * Watch the refill from a page that has already loaded.
 *
 * The form is posted with `fetch` rather than submitted, because a normal
 * submit navigates — and the navigation would land on a server that is about
 * to stop answering. Having stayed on this document, a failed poll means the
 * service is down, which during a refill is the expected state and not an
 * error worth showing as one.
 */
export function showcaseReseedScript(): string {
  return `
(function () {
  var form = document.getElementById('form');
  var box = document.getElementById('progress');
  var state = document.getElementById('state');
  var detail = document.getElementById('detail');
  var words = {
    queued: 'Queued',
    seeding: 'Building the household',
    starting: 'Starting the demo',
    done: 'Done',
    failed: 'Failed',
  };
  function show(status, reachable) {
    box.style.display = 'block';
    if (!reachable) {
      state.textContent = 'Working';
      detail.textContent =
        'The demo is stopped while it is refilled, so this page cannot reach ' +
        'it. That is expected. It will say so when it is back.';
      return;
    }
    state.textContent = words[status.state] || status.state;
    if (status.state === 'failed') {
      detail.textContent =
        (status.error || 'No reason was recorded.') +
        ' The workspace may hold part of two households; refill it again.';
      return;
    }
    if (status.state === 'done') {
      var c = status.counts || {};
      var parts = [];
      if (c.transactions) parts.push(c.transactions + ' payments');
      if (c.holdings) parts.push(c.holdings + ' holdings');
      if (c.refunds) parts.push(c.refunds + ' linked refunds');
      if (c.receipts) parts.push(c.receipts + ' receipts');
      if (c.rates) parts.push(c.rates + ' daily rates');
      detail.textContent =
        parts.join(', ') +
        (status.release ? ', on release ' + status.release.slice(0, 7) : '') +
        '. Reload the application to see it.';
      return;
    }
    detail.textContent =
      'Asked for at ' + status.requestedAt.slice(11, 16) + ' UTC.';
  }
  function poll() {
    fetch('/showcase/reseed/status', { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (status) {
        if (!status) { show(null, false); setTimeout(poll, 4000); return; }
        show(status, true);
        if (status.state !== 'done' && status.state !== 'failed')
          setTimeout(poll, 4000);
      })
      .catch(function () { show(null, false); setTimeout(poll, 4000); });
  }
  form.addEventListener('submit', function (event) {
    event.preventDefault();
    form.style.display = 'none';
    box.style.display = 'block';
    fetch('/showcase/reseed', {
      method: 'POST',
      body: new URLSearchParams(new FormData(form)),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    })
      .then(function () { poll(); })
      .catch(function () { poll(); });
  });
})();
`;
}
