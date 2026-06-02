import fs from 'node:fs';
import path from 'node:path';
import { createGuardReport } from './lib/detailed-guard-report.mjs';

// PS-073 — Customer Name Reference + Batch Manifest support for Print
// Queue batch PDFs. Static source guard: proves the names/manifest feature
// stays wired into the merge/header path AND that the recipient-name read
// path never pulls PII (addresses, emails, phones, tracking, label URLs).
// Behavioural proof (threshold, fallback, dedup, render) lives in the
// companion tsx guard: scripts/print-queue-batch-names-behavior.ts.

const root = process.cwd();

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

const serviceSource = read('src/services/print-queue.ts');

const report = createGuardReport({
  title: 'Print Queue Batch Names + Manifest Guard',
  bug: 'A torn-off label leaves warehouse staff unable to tell which recipients belong to a batch; names must appear as a privacy-safe reference without leaking PII or crossing client scope.',
  scope: 'Static source guard for PS-073 recipient-name reference + Batch Manifest rendering in src/services/print-queue.ts.',
});

report.check({
  name: 'Header accepts recipient names and reports manifest need',
  condition:
    serviceSource.includes('recipients: BatchRecipient[] = []') &&
    serviceSource.includes('threshold = BATCH_NAMES_HEADER_THRESHOLD') &&
    serviceSource.includes('): { manifestNeeded: boolean } {'),
  why: 'drawHeader must receive the batch group names and tell the caller whether a separate manifest page is still required.',
  evidence: 'drawHeader takes recipients + threshold and returns { manifestNeeded }.',
  failure: 'Names cannot reach the header, or the caller cannot know when to add a Batch Manifest page.',
  fix: 'Restore the recipients/threshold params and the { manifestNeeded } return on drawHeader.',
});

report.check({
  name: 'Names are joined from authoritative order data at render time',
  condition:
    serviceSource.includes('loadBatchRecipientsByGroup') &&
    serviceSource.includes('shipToName: orders.shipToName') &&
    serviceSource.includes('inArray(orders.id'),
  why: 'Already-queued rows have no stored name; names must come from orders.shipToName so no requeue/relabel is needed.',
  evidence: 'loadBatchRecipientsByGroup selects orders.shipToName by orderId at merge time.',
  failure: 'Existing queue rows would render without names, or names would require a schema migration/requeue.',
  fix: 'Restore loadBatchRecipientsByGroup joining orders.shipToName by orderId.',
});

report.check({
  name: 'Recipient names are client-scoped (no cross-client leak)',
  condition: serviceSource.includes('row.clientId === entry.clientId'),
  why: 'A name must only attach to its own client/store; an id collision must never surface another client\'s recipient.',
  evidence: 'loadBatchRecipientsByGroup only trusts shipToName when the order clientId matches the queued entry clientId.',
  failure: 'Names could leak across client/store scope.',
  fix: 'Keep the row.clientId === entry.clientId scope guard before using shipToName.',
});

// Extract the loadBatchRecipientsByGroup body and assert it reads ONLY
// privacy-safe orders.* columns. We allowlist the real safe columns and
// flag any other orders.<column> reference inside the loader — so adding a
// real PII column (customerEmail, shipToCity/State/PostalCode,
// assignedToEmail, trackingNumber, rawSourcePayload, raw, ...) to the
// SELECT would actually fail this guard, unlike the previous check which
// asserted column names that never existed in the schema.
const loaderStart = serviceSource.indexOf('async function loadBatchRecipientsByGroup');
const loaderEnd = loaderStart >= 0 ? serviceSource.indexOf('\n}', loaderStart) : -1;
const loaderBody = loaderStart >= 0 && loaderEnd >= 0 ? serviceSource.slice(loaderStart, loaderEnd) : '';
const SAFE_ORDER_COLUMNS = new Set(['id', 'shipToName', 'orderNumber', 'clientId']);
const loaderOrderColumns = [...new Set([...loaderBody.matchAll(/orders\.(\w+)/g)].map((m) => m[1]))];
const leakedColumns = loaderOrderColumns.filter((c) => !SAFE_ORDER_COLUMNS.has(c));

report.check({
  name: 'Recipient-name join reads only privacy-safe order columns',
  condition:
    loaderBody.length > 0 &&
    leakedColumns.length === 0 &&
    serviceSource.includes('export type BatchRecipient = { name: string; orderNumber: string }'),
  why: 'The names join must expose recipient names only — never addresses, emails, phones, tracking numbers, raw payloads, or any other PII column.',
  evidence: `loadBatchRecipientsByGroup references orders columns [${loaderOrderColumns.join(', ') || 'none'}], all within the safe allowlist; BatchRecipient stays { name, orderNumber }.`,
  failure: leakedColumns.length
    ? `loadBatchRecipientsByGroup reads non-allowlisted order column(s): ${leakedColumns.join(', ')}.`
    : 'loadBatchRecipientsByGroup not found, or BatchRecipient type changed.',
  fix: 'Keep the loadBatchRecipientsByGroup SELECT limited to id, shipToName, orderNumber, clientId; never add address/email/phone/tracking/payload columns.',
});

report.check({
  name: 'Missing names fall back to a safe order-number label',
  condition:
    serviceSource.includes('export function resolveRecipientDisplayName') &&
    serviceSource.includes('`Order ${orderNumber}`') &&
    serviceSource.includes("'Unnamed recipient'"),
  why: 'A missing recipient name must degrade to "Order <orderNumber>", never to an empty row or a crash.',
  evidence: 'resolveRecipientDisplayName returns an Order/Unnamed fallback when shipToName is blank.',
  failure: 'Blank names could produce empty rows or break the layout.',
  fix: 'Keep the resolveRecipientDisplayName order-number fallback.',
});

report.check({
  name: 'Large batches spill to a Batch Manifest page',
  condition:
    serviceSource.includes('BATCH_NAMES_HEADER_THRESHOLD = 30') &&
    serviceSource.includes('export function planBatchNamesDisplay') &&
    serviceSource.includes('addBatchManifestPages') &&
    serviceSource.includes('if (manifestNeeded'),
  why: 'Above the threshold (or when names do not fit), the 4x6 header must not be crammed — names go on a dedicated manifest page.',
  evidence: 'planBatchNamesDisplay + the runMergeJob manifest insertion add Batch Manifest pages when manifestNeeded.',
  failure: '40-60+ names could be crammed onto the 4x6 header, or large batches would silently drop names.',
  fix: 'Keep planBatchNamesDisplay and the addBatchManifestPages insertion in runMergeJob.',
});

report.check({
  name: 'Duplicate names are disambiguated on the manifest',
  condition:
    serviceSource.includes('export function annotateDuplicateNames') &&
    serviceSource.includes('recipient.duplicate') &&
    serviceSource.includes('(#${recipient.orderNumber})'),
  why: 'Two recipients with the same name must be distinguishable on the manifest via their order number.',
  evidence: 'annotateDuplicateNames flags repeats and the manifest appends (#orderNumber) for duplicates.',
  failure: 'Identical names would be ambiguous on the rescue manifest.',
  fix: 'Keep annotateDuplicateNames and the (#orderNumber) suffix for duplicates.',
});

report.check({
  name: 'Override audit trail is present',
  condition: serviceSource.includes('Per user override unlock shipped data on 2026-06-02'),
  why: 'Reading shipped-order data (orders.shipToName) is gated by the shipped-data lockdown; every such change must carry the dated override note.',
  evidence: 'The PS-073 code blocks carry the dated unlock shipped data override comment.',
  failure: 'The shipped-data read would lack its required override audit trail.',
  fix: 'Keep the "Per user override unlock shipped data on 2026-06-02" comments on the PS-073 changes.',
});

report.finish();
