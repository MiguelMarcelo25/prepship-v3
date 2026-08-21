/**
 * PS-467 unattributed-shipment audit guard.
 *
 * Offline: pure rules plus the REAL loader against an in-process PGlite, so the SQL is
 * exercised rather than described. No provider, no postage, no production database.
 *
 * What this pins, and why it exists. 4,004 shipments carry a NULL order_id. The card
 * called 796 of them "recoverable: the correct order_id is already known from the sibling
 * row". A dry-run under DJ's `unlock shipped data` override on 2026-08-01 showed that is
 * true and misleading -- the order_id is recoverable in every case and CORRECT IN NONE,
 * because those orders were never missing a shipment. The orphan is shipment sync
 * re-ingesting a label that label-purchase already wrote, seconds earlier, with the link.
 *
 * Linking them would have given 790 orders a second row for one physical label, and for
 * 6 whose sibling is voided it would have attached a row that falsely appears live to a
 * shipped order. So the deliverable is the REASON, not a repair -- and the reason is
 * derived, never stored, because storing it would need a column on a locked table, a
 * 790-row write to shipped data, and would go stale when a sibling is voided.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

process.env.DATABASE_URL ??= 'postgres://user:pass@127.0.0.1:5432/prepship_guard';
process.env.SUPABASE_URL ??= 'https://example.supabase.co';
process.env.SUPABASE_ANON_KEY ??= 'anon';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'service';
process.env.SUPABASE_JWT_SECRET ??= 'secret';

const { classifyUnattributedShipmentAudit } =
  await import('../src/services/shipment-sync-unattributed');

let failures = 0;
function check(name: string, condition: boolean, detail?: unknown): void {
  if (!condition) {
    failures += 1;
    console.error(`FAIL ${name}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`);
    return;
  }
  console.log(`ok   ${name}`);
}

// ── the rule ────────────────────────────────────────────────────────────────
const reason = (orderNumber: string | null, duplicateOfShipmentId: number | null = null) =>
  classifyUnattributedShipmentAudit({ orderNumber, duplicateOfShipmentId });

check('a sibling sharing the tracking number means DUPLICATE, not a lost link',
  reason('3188', 29642) === 'duplicate_of_shipment');
check('no order number and no sibling is a blank order number',
  reason(null) === 'blank_order_number');
check('whitespace-only counts as blank', reason('   ') === 'blank_order_number');
check('a SEAuto- number is an excluded store, not a matching failure',
  reason('SEAuto-4Srv1DCA9Uqf0SSB99OgFA') === 'excluded_store');
check('any other unmatched number is an unmatched order number',
  reason('200014723124040') === 'unmatched_order_number');

// Precedence is the part that can silently rot: sibling evidence must outrank the
// order number, or a duplicate of an excluded-store label reads as "never ingested"
// and hides the fact that the order ALREADY HAS the shipment.
check('sibling evidence outranks an excluded-store order number',
  reason('SEAuto-abc', 4242) === 'duplicate_of_shipment');
check('sibling evidence outranks a blank order number',
  reason(null, 4242) === 'duplicate_of_shipment');
check('sibling evidence outranks an unmatched order number',
  reason('200014723124040', 4242) === 'duplicate_of_shipment');

// ── the loader, against real Postgres ───────────────────────────────────────
const { PGlite } = await import('@electric-sql/pglite');
const client = new PGlite();
await client.exec(`
  CREATE TABLE shipments (
    id integer PRIMARY KEY,
    order_id integer,
    order_number text,
    tracking_number text,
    -- PS-502 merge 2026-08-21: the loader now excludes source='replacement' vessels.
    source text,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  INSERT INTO shipments (id, order_id, order_number, tracking_number, created_at) VALUES
    -- the production shape: purchase writes the linked row, sync re-ingests it orphaned
    (29642, 1727592, '3188', 'TRK-DUP',  '2026-07-24T08:02:16Z'),
    (29643, NULL,    '3188', 'TRK-DUP',  '2026-07-24T08:05:37Z'),
    -- an orphan whose tracking nothing else carries
    (30001, NULL,    '',     'TRK-SOLO', '2026-07-25T00:00:00Z'),
    (30002, NULL,    'SEAuto-xyz', 'TRK-EXC', '2026-07-25T00:00:00Z'),
    (30003, NULL,    '200999',     'TRK-UNM', '2026-07-25T00:00:00Z'),
    -- a healthy linked row that must never appear in the audit at all
    (30004, 555,     '999',  'TRK-OK',   '2026-07-25T00:00:00Z'),
    -- TWO linked rows share this tracking. The pairing must be deterministic and must
    -- name the EARLIER one -- that is the label-purchase write, which is the row the
    -- orphan actually duplicates. Without this case the LATERAL's ordering is
    -- unobservable, because oldest and newest would be the same row.
    (30010, 777,     '4001', 'TRK-TWO',  '2026-07-26T09:00:00Z'),
    (30011, 888,     '4001', 'TRK-TWO',  '2026-07-26T09:30:00Z'),
    (30012, NULL,    '4001', 'TRK-TWO',  '2026-07-26T09:45:00Z');
`);

const conn = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
  const text = strings.reduce((acc, part, i) => acc + part + (i < values.length ? `$${i + 1}` : ''), '');
  const result = await client.query(text, values as never[]);
  return result.rows;
}) as never;

const { loadUnattributedShipmentAudit, summarizeUnattributedShipments } =
  await import('../src/services/shipment-unattributed-audit-loader');

const audit = await loadUnattributedShipmentAudit(conn);
const byId = new Map(audit.map((row) => [row.shipmentId, row]));

check('a linked shipment never appears in the audit',
  !byId.has(30004) && !byId.has(30010) && !byId.has(30011), [...byId.keys()]);
check('every unattributed row is returned', audit.length === 5, audit.length);

// Determinism: with two linked siblings, the audit must name the EARLIER one -- the
// label-purchase write the orphan actually duplicates, not whichever row sorts last.
check('with two linked siblings the audit names the OLDER one',
  byId.get(30012)?.duplicateOfShipmentId === 30010, byId.get(30012));
check('and reports that older sibling\'s order, not the later one',
  byId.get(30012)?.duplicateOfOrderId === 777, byId.get(30012));

check('the duplicate is identified from its sibling',
  byId.get(29643)?.reason === 'duplicate_of_shipment', byId.get(29643));
check('the duplicate names the SIBLING shipment as evidence',
  byId.get(29643)?.duplicateOfShipmentId === 29642, byId.get(29643));
check('the duplicate names the order that already has the shipment',
  byId.get(29643)?.duplicateOfOrderId === 1727592, byId.get(29643));
check('a solo orphan gets no false sibling',
  byId.get(30001)?.duplicateOfShipmentId === null
    && byId.get(30001)?.reason === 'blank_order_number', byId.get(30001));
check('excluded-store and unmatched orphans classify from their order number',
  byId.get(30002)?.reason === 'excluded_store'
    && byId.get(30003)?.reason === 'unmatched_order_number');

const summary = await summarizeUnattributedShipments(conn);
check('the summary counts every reason',
  summary.duplicate_of_shipment === 2 && summary.blank_order_number === 1
    && summary.excluded_store === 1 && summary.unmatched_order_number === 1, summary);

await client.close();

// ── the thing this must never become ────────────────────────────────────────
const loader = readFileSync('src/services/shipment-unattributed-audit-loader.ts', 'utf8');
const owner = readFileSync('src/services/shipment-sync-unattributed.ts', 'utf8');

check('the audit NEVER writes -- it explains, it does not repair',
  !/\b(UPDATE|INSERT|DELETE)\b/i.test(loader.replace(/\/\*[\s\S]*?\*\//g, '')), 'write statement in loader');
check('the audit reads only rows that are actually unattributed',
  /WHERE s\.order_id IS NULL/.test(loader));
check('the rule owner stays pure -- no database import',
  !/from '\.\.\/db\//.test(owner) && !/\bdb\b\./.test(owner));
check('the loader delegates to the owner instead of re-deriving the reason',
  /classifyUnattributedShipmentAudit\(/.test(loader));
check('the loader takes a conn seam so the SQL is testable',
  /conn: typeof pg = pg/.test(loader));

if (failures > 0) {
  console.error(`\nFAIL PS-467 unattributed audit guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-467 unattributed audit guard');
