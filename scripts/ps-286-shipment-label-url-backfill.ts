import 'dotenv/config';
import { and, eq, gt, isNotNull, isNull, sql } from 'drizzle-orm';
import { db } from '../src/db/client';
import { shipments } from '../src/db/schema/shipments';
import { loadClientCredentials } from '../src/lib/shipstation/credentials';
import { ssListRecentLabels } from '../src/lib/shipstation/labels';
import {
  planShipmentLabelUrlBackfill,
  type LabelUrlRecord,
  type ShipmentNeedingLabelUrl,
} from '../src/services/shipping-workflow/shipment-label-url-backfill';

/**
 * PS-286 — backfill shipments.label_url from the authoritative ShipStation label record.
 *
 * Why: the ShipStation shipment-list sync (src/services/shipment-sync.ts) never captured
 * the v2 label-download URL, so ~72% of recent shipped shipments landed with label_url
 * NULL. With no stored label URL the Shipped view greys out "Send to Queue". Every null
 * row still carries label_shipment_id, so the URL is recoverable from /v2/labels.
 *
 * SAFETY (per CLAUDE.md shipped/cancelled lockdown + override `unlock shipped data` 2026-06-17):
 *   - DRY-RUN by default. Prints counts; writes NOTHING.
 *   - `--apply` is DOUBLE-GATED: it ALSO requires `--confirm-production`.
 *   - The ONLY write is `UPDATE shipments SET label_url = $url WHERE id = $id AND label_url IS NULL`.
 *     It never overwrites an existing URL and never touches tracking, carrier, service,
 *     cost, dims, weight, package, order status, items, or any other column.
 *   - Idempotent: the `label_url IS NULL` guard makes re-runs no-ops for filled rows.
 *   - Read-only ShipStation calls only. No labels created/voided, no postage bought, no
 *     marketplace notifications.
 *   - No PII printed: shipment id, ss shipment id, and a truncated URL host only.
 *   - main() runs only when invoked directly, so importing this module never connects.
 *
 *   npm run shipstation:label-urls:dry-run
 *   npm run shipstation:label-urls:apply -- --confirm-production
 */

function argValue(name: string): string | null {
  const prefix = `--${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0) return process.argv[index + 1] ?? null;
  return null;
}
function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

type AffectedRow = ShipmentNeedingLabelUrl & { clientId: number | null };

/** Non-voided shipments missing a usable label_url but carrying a ShipStation shipment id. */
async function loadRowsNeedingLabelUrl(windowDays: number, limit: number): Promise<AffectedRow[]> {
  const rows = await db
    .select({
      shipmentId: shipments.id,
      trackingNumber: shipments.trackingNumber,
      labelUrl: shipments.labelUrl,
      clientId: shipments.clientId,
    })
    .from(shipments)
    .where(
      and(
        eq(shipments.voided, false),
        isNull(shipments.labelUrl),
        isNotNull(shipments.trackingNumber),
        gt(shipments.createdAt, sql`now() - (${windowDays} || ' days')::interval`),
      ),
    )
    .limit(limit);
  return rows.map((r) => ({
    shipmentId: r.shipmentId,
    trackingNumber: r.trackingNumber,
    labelUrl: r.labelUrl,
    clientId: r.clientId,
  }));
}

/** Page through /v2/labels for every distinct client credential among the rows, merging
 *  into one shipmentId→labelUrl record set. Distinct V2 keys are listed once. */
async function fetchLabelRecords(
  rows: AffectedRow[],
  maxPages: number,
  pageSize: number,
): Promise<LabelUrlRecord[]> {
  const clientIds = [...new Set(rows.map((r) => r.clientId).filter((id): id is number => id != null))];
  const keysSeen = new Set<string>();
  const credSets: Array<string | undefined> = [];
  for (const clientId of clientIds) {
    const creds = await loadClientCredentials(clientId);
    const key = creds.apiKeyV2 ?? '__env_default__';
    if (keysSeen.has(key)) continue;
    keysSeen.add(key);
    credSets.push(creds.apiKeyV2 ?? undefined);
  }
  if (!credSets.length) credSets.push(undefined); // env-default only

  const records: LabelUrlRecord[] = [];
  for (const apiKeyV2 of credSets) {
    for (let page = 1; page <= maxPages; page += 1) {
      const batch = await ssListRecentLabels(apiKeyV2, { page, pageSize });
      if (!batch.length) break;
      for (const rec of batch) records.push({ trackingNumber: rec.trackingNumber, labelUrl: rec.labelUrl });
      if (batch.length < pageSize) break; // last page
    }
  }
  return records;
}

function urlHost(url: string): string {
  try { return new URL(url).host; } catch { return '(unpar=able)'; }
}

async function main(): Promise<void> {
  const apply = hasFlag('apply');
  const confirmProduction = hasFlag('confirm-production');
  const asJson = hasFlag('json');
  const windowDays = Number(argValue('window-days') ?? '14') || 14;
  const limit = Number(argValue('limit') ?? '5000') || 5000;
  const pageSize = Number(argValue('page-size') ?? '200') || 200;
  // Default coverage: pageSize * maxPages labels (200 * 50 = 10k) — ample for the window.
  const maxPages = Number(argValue('max-pages') ?? '50') || 50;

  const rows = await loadRowsNeedingLabelUrl(windowDays, limit);
  const labelRecords = await fetchLabelRecords(rows, maxPages, pageSize);
  const updates = planShipmentLabelUrlBackfill(rows, labelRecords);

  const willApply = apply && confirmProduction;
  const modeLabel = willApply ? 'APPLY (writes shipments.label_url where NULL)' : 'DRY RUN (no writes)';

  if (asJson) {
    console.log(JSON.stringify({
      mode: willApply ? 'apply' : 'dry-run',
      windowDays,
      scanned: rows.length,
      labelRecords: labelRecords.length,
      resolvable: updates.length,
      unresolved: rows.length - updates.length,
    }, null, 2));
  } else {
    console.log(`PS-286 shipment label_url backfill — ${modeLabel}\n`);
    console.log(
      `Scanned ${rows.length} shipment(s) with NULL label_url + a ShipStation id (last ${windowDays}d).`,
    );
    console.log(`Fetched ${labelRecords.length} ShipStation label record(s).`);
    console.log(`Resolvable: ${updates.length}; unresolved: ${rows.length - updates.length}.\n`);
    for (const u of updates.slice(0, 25)) {
      console.log(`  shipment ${u.shipmentId} ${willApply ? '->' : 'would set ->'} ${urlHost(u.labelUrl)}/…`);
    }
    if (updates.length > 25) console.log(`  …and ${updates.length - 25} more.`);
    if (!updates.length) console.log('  Nothing resolvable in this window.');
  }

  // ── Apply gating ────────────────────────────────────────────────────────────
  if (!apply) {
    process.exit(0);
  }
  if (!confirmProduction) {
    console.error(
      [
        '',
        'PS-286 apply is DOUBLE-GATED and did NOT write anything.',
        'It updates shipments.label_url on SHIPPED rows, so it also requires --confirm-production.',
        'Review the dry-run above, then re-run:',
        '  npm run shipstation:label-urls:apply -- --confirm-production',
        'Authorized only under: Per user override `unlock shipped data` on 2026-06-17.',
      ].join('\n'),
    );
    process.exit(2);
  }

  // Confirmed apply — Per user override `unlock shipped data` on 2026-06-17.
  // The label_url IS NULL guard guarantees we only FILL, never overwrite.
  let updated = 0;
  for (const u of updates) {
    try {
      const res = await db
        .update(shipments)
        .set({ labelUrl: u.labelUrl })
        .where(and(eq(shipments.id, u.shipmentId), isNull(shipments.labelUrl)));
      void res;
      updated += 1;
    } catch (err) {
      console.error(`[ps-286] apply failed for shipment ${u.shipmentId}: ${err instanceof Error ? err.message : err}`);
    }
  }
  console.log(`\nAPPLY complete: filled label_url on ${updated}/${updates.length} shipment(s) (label_url-only, NULL-guarded).`);
  process.exit(updated === updates.length ? 0 : 1);
}

// Only run when invoked directly so importing this module in a test never connects.
const invokedDirectly =
  process.argv[1] != null && /ps-286-shipment-label-url-backfill\.ts$/.test(process.argv[1]);
if (invokedDirectly) {
  main().catch((err) => {
    console.error('[ps-286] backfill failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}

export { loadRowsNeedingLabelUrl, fetchLabelRecords };
