/**
 * Guard: the Manifest Export endpoint accepts the frontend's params.
 *
 * The Manifest Export modal does GET /manifests/generate?startDate=YYYY-MM-DD&
 * endDate=YYYY-MM-DD. The old GET schema required dateFrom/dateTo as strict
 * z.string().datetime(), so it 400'd with "invalid_type … path: dateFrom".
 * resolveManifestDateRange normalizes both naming conventions + date-only input
 * into an inclusive California-day ISO range. This locks that contract.
 *
 *   npx tsx scripts/manifest-date-range-guard.ts
 *
 * Read-only: no DB queries, mutates nothing.
 */
import { resolveManifestDateRange } from '../src/routes/manifests';

let failures = 0;
function check(name: string, cond: boolean) {
  if (!cond) {
    failures += 1;
    console.error(`FAIL ${name}`);
  } else {
    console.log(`ok   ${name}`);
  }
}

// v2-style date-only startDate/endDate (what ManifestsView sends) must resolve.
const r1 = resolveManifestDateRange({ startDate: '2026-05-04', endDate: '2026-06-03' });
check('v2 startDate/endDate (date-only) resolves', r1 != null);
check('dateFrom is a full ISO datetime', !!r1 && /^\d{4}-\d{2}-\d{2}T.+Z$/.test(r1.dateFrom));
check('dateTo is a full ISO datetime', !!r1 && /^\d{4}-\d{2}-\d{2}T.+Z$/.test(r1.dateTo));
check('dateFrom precedes dateTo', !!r1 && new Date(r1.dateFrom) < new Date(r1.dateTo));

// A single day must span start-of-day -> end-of-day (inclusive), not collapse
// to a zero-width range that would drop that day's shipments.
const sameDay = resolveManifestDateRange({ startDate: '2026-06-03', endDate: '2026-06-03' });
check(
  'single day spans ~24h (inclusive end-of-day)',
  !!sameDay && new Date(sameDay.dateTo).getTime() - new Date(sameDay.dateFrom).getTime() > 23 * 3600 * 1000,
);

// v4-style full ISO dateFrom/dateTo passes through unchanged.
const iso = resolveManifestDateRange({
  dateFrom: '2026-05-04T07:00:00.000Z',
  dateTo: '2026-06-03T06:59:59.999Z',
});
check('v4 dateFrom passthrough', iso?.dateFrom === '2026-05-04T07:00:00.000Z');
check('v4 dateTo passthrough', iso?.dateTo === '2026-06-03T06:59:59.999Z');

// dateFrom/dateTo take precedence over startDate/endDate when both supplied.
const both = resolveManifestDateRange({
  dateFrom: '2026-01-01T00:00:00.000Z',
  startDate: '2099-01-01',
  dateTo: '2026-01-02T00:00:00.000Z',
  endDate: '2099-01-02',
});
check('dateFrom wins over startDate', both?.dateFrom === '2026-01-01T00:00:00.000Z');

// Missing / partial input returns null -> handler responds 400, not a crash.
check('missing dates => null', resolveManifestDateRange({}) === null);
check('only start => null', resolveManifestDateRange({ startDate: '2026-05-04' }) === null);
check('only end => null', resolveManifestDateRange({ endDate: '2026-06-03' }) === null);

if (failures > 0) {
  console.error(`\nFAIL manifest date-range guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS manifest date-range guard');
