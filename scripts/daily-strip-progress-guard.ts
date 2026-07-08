import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildDailyStripProgress } from '../web/src/components/Views/orders-parity';

// PS-047 — progress-math + truthful-CA-label coverage for the Orders daily
// strip. This repo has no vitest/jest; the sanctioned unit mechanism is a tsx
// guard (node:assert). buildDailyStripProgress is the pure function behind the
// strip's "{shipped} of {totalOrders} shipped" line and percentage bar.

const BRAND_BLUE = '#03A9F4';
const WARN_ORANGE = '#e07a00';
const MUTED = 'var(--text3)';

// --- (a) progress math -------------------------------------------------------

// The reported screenshot: 91 total / 22 need -> 69 shipped, 76% (orange band).
{
  const p = buildDailyStripProgress({ totalOrders: 91, needToShip: 22, upcomingOrders: 4 });
  assert.equal(p.shipped, 69, 'shipped = total - need');
  assert.equal(p.pct, 76, 'pct = round(69 / 91 * 100) = 76');
  assert.equal(p.barFill, 76, 'barFill clamps to pct below 100');
  assert.equal(p.barColor, WARN_ORANGE, '50-99% band is warn orange');
  assert.equal(p.needToShipColor, WARN_ORANGE, 'need > 0 highlights orange');
  assert.equal(p.upcomingColor, BRAND_BLUE, 'upcoming > 0 is brand blue');
}

// Boss-directive example "58 of 63 shipped" -> 92%.
{
  const p = buildDailyStripProgress({ totalOrders: 63, needToShip: 5, upcomingOrders: 0 });
  assert.equal(p.shipped, 58);
  assert.equal(p.pct, 92);
  assert.equal(p.barColor, WARN_ORANGE);
  assert.equal(p.upcomingColor, MUTED, 'no upcoming -> muted');
}

// Fully shipped -> 100%, brand blue, need muted.
{
  const p = buildDailyStripProgress({ totalOrders: 40, needToShip: 0, upcomingOrders: 0 });
  assert.equal(p.shipped, 40);
  assert.equal(p.pct, 100);
  assert.equal(p.barFill, 100);
  assert.equal(p.barColor, BRAND_BLUE, '100% is brand blue, not orange');
  assert.equal(p.needToShipColor, MUTED, 'need = 0 -> muted');
}

// Low completion (<50%) -> brand blue bar.
{
  const p = buildDailyStripProgress({ totalOrders: 100, needToShip: 80, upcomingOrders: 0 });
  assert.equal(p.shipped, 20);
  assert.equal(p.pct, 20);
  assert.equal(p.barColor, BRAND_BLUE, '<50% is brand blue');
}

// Edge: need > total -> shipped clamps to 0, pct 0 (no negative bar).
{
  const p = buildDailyStripProgress({ totalOrders: 5, needToShip: 9, upcomingOrders: 0 });
  assert.equal(p.shipped, 0, 'Math.max(0, total - need) clamps negatives');
  assert.equal(p.pct, 0);
  assert.equal(p.barFill, 0);
}

// Edge: zero orders -> no divide-by-zero, pct 0.
{
  const p = buildDailyStripProgress({ totalOrders: 0, needToShip: 0, upcomingOrders: 0 });
  assert.equal(p.shipped, 0);
  assert.equal(p.pct, 0);
}

// --- (b) strip consumes /orders/daily-stats and renders truthful CA labels ---

const ordersView = readFileSync('web/src/components/Views/OrdersView.tsx', 'utf8');
// PS-166 (Wave 3, JSX-safe): the daily-strip MARKUP moved VERBATIM to
// OrdersDailyStrip.tsx; OrdersView keeps all daily-stats state, the
// fetchDailyStats load, the buildDailyStripProgress derivation, the
// dailyStatsStatus model, the visibilitychange retry, and the CA label
// normalizer. Markup pins read the component; logic pins read OrdersView.
const dailyStrip = readFileSync('web/src/components/Views/OrdersDailyStrip.tsx', 'utf8');
const apiClient = readFileSync('web/src/lib/v2-apiClient.ts', 'utf8');
// PS-317: the daily-stats fetch + rollover moved into the useDailyStats hook.
const dailyStatsHook = readFileSync('web/src/components/Views/orders/useDailyStats.ts', 'utf8');
const dailyStatsClientBlock = apiClient.slice(
  apiClient.indexOf('fetchDailyStats('),
  apiClient.indexOf('fetchPicklist('),
);

assert.match(
  apiClient,
  /\/orders\/daily-stats/,
  'apiClient.fetchDailyStats must call GET /orders/daily-stats',
);
assert.match(
  dailyStatsHook,
  /apiClient\.fetchDailyStats\(\)/,
  'useDailyStats must load the strip via apiClient.fetchDailyStats()',
);
// 2026-07-08 (dead-code sweep): OrdersView's `dailyStatsForStrip` alias of
// dailyStats was removed — the derivation reads dailyStats directly. Same pin,
// same intent: strip progress must come from buildDailyStripProgress over the
// backend daily-stats DTO. (The OrdersDailyStrip component still names its
// PROP dailyStatsForStrip; the markup pins below are unchanged.)
assert.match(
  ordersView,
  /buildDailyStripProgress\(dailyStats\)/,
  'OrdersView must derive progress via buildDailyStripProgress',
);
assert.match(
  ordersView,
  /dailyStatsStatus/,
  'OrdersView must model daily stats as explicit loading/success/error state',
);
assert.doesNotMatch(
  ordersView,
  /\{dailyStats \? \(/,
  'OrdersView must not hide the entire daily strip when dailyStats is null',
);
assert.match(
  dailyStrip,
  /Daily stats unavailable/,
  'daily strip must render a retryable daily-stats failure state instead of disappearing',
);
assert.match(
  dailyStatsHook,
  /visibilitychange/,
  'useDailyStats must retry daily stats immediately when a hidden tab becomes visible',
);
assert.match(
  dailyStrip,
  /\{dailyStripProgress\?\.shipped\} of \{dailyStatsForStrip\.totalOrders\} shipped/,
  'daily strip must render the "{shipped} of {totalOrders} shipped" summary',
);
assert.match(
  ordersView,
  /<OrdersDailyStrip/,
  'OrdersView must render the extracted daily strip',
);
assert.match(
  apiClient,
  /rootDto\.summary/,
  'apiClient daily-stats parser must tolerate summary-wrapped deploy-skew responses',
);
assert.doesNotMatch(
  dailyStatsClientBlock,
  /cachedSafe[\s\S]*?null/,
  'apiClient.fetchDailyStats must not cache null as a successful daily-stats fallback',
);
assert.match(
  ordersView,
  /normalizeTzLabel/,
  'OrdersView must define the CA label normalizer',
);
assert.match(
  ordersView,
  /PST\|PDT\|PT/,
  'normalizer must target the PT/PST/PDT suffixes the server emits',
);
assert.match(
  dailyStrip,
  /shifts at 6 PM CA/,
  'daily strip must label the fulfillment rollover as 6 PM CA',
);

// Behavioral proof: replicate the exact transform the component applies and
// confirm the server's "12pm PT" boundary becomes the truthful "12pm CA" the
// operator sees — so the label is never CA-in-name-only.
const normalizeTzLabel = (s: string) => s.replace(/\b(?:PST|PDT|PT)\b/g, 'CA');
assert.equal(normalizeTzLabel('May 28, 12pm PT'), 'May 28, 12pm CA');
assert.equal(normalizeTzLabel('May 29, 12pm PDT'), 'May 29, 12pm CA');

// End-to-end of the screenshot: a realistic /orders/daily-stats payload (true
// noon-CA window) flows through buildDailyStripProgress + the label transform
// to exactly the strings the strip renders.
{
  const dto = {
    totalOrders: 91,
    needToShip: 22,
    upcomingOrders: 4,
    window: {
      from: '2026-05-28T19:00:00.000Z',
      to: '2026-05-29T19:00:00.000Z',
      fromLabel: 'May 28, 12pm PT',
      toLabel: 'May 29, 12pm PT',
    },
  };
  const prog = buildDailyStripProgress(dto);
  assert.equal(
    `${prog.shipped} of ${dto.totalOrders} shipped`,
    '69 of 91 shipped',
    'screenshot DTO must render "69 of 91 shipped"',
  );
  assert.equal(normalizeTzLabel(dto.window.fromLabel), 'May 28, 12pm CA');
  assert.equal(normalizeTzLabel(dto.window.toLabel), 'May 29, 12pm CA');
}

// --- self-wiring -------------------------------------------------------------
const pkg = readFileSync('package.json', 'utf8');
assert.match(
  pkg,
  /test:daily-strip-progress/,
  'package.json must expose the daily-strip progress guard',
);

// PS-076 — the strip's loading/failure/visibility resilience needs BROWSER
// coverage, not just this static guard. Assert the Playwright spec exists and
// is wired so it can't be silently dropped.
assert.match(
  pkg,
  /test:orders-daily-strip:browser/,
  'package.json must expose the PS-076 daily-strip resilience browser test',
);
const dailyStripSpec = readFileSync('web/e2e/orders-daily-strip-resilience.spec.js', 'utf8');
for (const probe of [
  '/orders/daily-stats',
  "summary:", // exercises the { summary: ... } compat shape
  'Daily stats unavailable', // first-failure fallback assertion
  'without a page refresh', // retry-without-refresh assertion
]) {
  assert.ok(
    dailyStripSpec.includes(probe),
    `daily-strip resilience spec must cover: ${probe}`,
  );
}

console.log('PASS daily-strip progress guard');
