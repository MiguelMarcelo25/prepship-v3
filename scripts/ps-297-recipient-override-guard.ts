/**
 * PS-297 - editable recipient/address before label purchase guard.
 *
 * Offline only. No DB calls, no labels, no queue, no marketplace/provider calls.
 * Pins the backend-owned recipient override contract:
 * - mutable address truth lives on order_overrides.recipient_override
 * - canonical order/detail DTOs prefer that override over marketplace raw shipTo
 * - label purchase paths prefer that override
 * - UI edit saves to backend and no longer shows the Phase 3 placeholder
 */
import { existsSync, readFileSync } from 'node:fs';
import {
  normalizeRecipientOverride,
  resolveRecipientForShipping,
} from '../src/services/order-recipient-override';

let failures = 0;
function check(name: string, condition: boolean): void {
  if (!condition) {
    failures += 1;
    console.error(`FAIL ${name}`);
    return;
  }
  console.log(`ok   ${name}`);
}

function readText(path: string): string {
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

const normalized = normalizeRecipientOverride({
  name: '  Jane Buyer  ',
  company: '  ',
  street1: '  590 Abbey Ct  ',
  street2: ' Unit 2B ',
  city: ' Blue Bell ',
  state: ' pa ',
  postalCode: ' 19422-1303 ',
  country: '',
  phone: ' 555-1212 ',
});

check('normalizes required recipient fields and defaults country to US',
  normalized.name === 'Jane Buyer' &&
  normalized.company === null &&
  normalized.street1 === '590 Abbey Ct' &&
  normalized.street2 === 'Unit 2B' &&
  normalized.city === 'Blue Bell' &&
  normalized.state === 'PA' &&
  normalized.postalCode === '19422-1303' &&
  normalized.country === 'US' &&
  normalized.phone === '555-1212');

check('rejects incomplete recipient overrides before persistence',
  (() => {
    try {
      normalizeRecipientOverride({ name: 'Jane', street1: '', city: 'Blue Bell', state: 'PA', postalCode: '19422' });
      return false;
    } catch {
      return true;
    }
  })());

const resolved = resolveRecipientForShipping({
  override: normalized,
  rawShipTo: {
    name: 'Marketplace Name',
    street1: 'Old Street',
    city: 'Old City',
    state: 'CA',
    postalCode: '90001',
    country: 'US',
    phone: '999',
  },
  fallback: {
    name: 'Fallback Name',
    city: 'Fallback City',
    state: 'CA',
    postalCode: '90001',
  },
});

check('recipient override wins over marketplace raw and fallback columns',
  resolved.source === 'override' &&
  resolved.address.name === 'Jane Buyer' &&
  resolved.address.street1 === '590 Abbey Ct' &&
  resolved.address.city === 'Blue Bell');

const schemaSrc = readText('src/db/schema/orders.ts');
const migrationSrc = readText('drizzle/0042_order_recipient_override.sql');
const ordersRouteSrc = readText('src/routes/orders.ts');
const labelsSrc = readText('src/services/labels.ts');
const apiClientSrc = readText('web/src/lib/v2-apiClient.ts');
const ordersViewSrc = readText('web/src/components/Views/OrdersView.tsx');
const panelSectionsSrc = readText('web/src/components/Views/OrdersPanelSections.tsx');
const packageJson = readText('package.json');

check('schema maps order_overrides.recipient_override',
  schemaSrc.includes('recipientOverride') &&
  schemaSrc.includes("jsonb('recipient_override')"));
check('migration adds recipient_override without destructive shipped/cancelled changes',
  migrationSrc.includes('ALTER TABLE public.order_overrides') &&
  migrationSrc.includes('ADD COLUMN IF NOT EXISTS recipient_override jsonb') &&
  !/drop column|delete from shipments|update\s+shipments/i.test(migrationSrc));
check('orders route accepts recipientOverride and never writes raw shipTo for PS-297',
  ordersRouteSrc.includes('recipientOverride: recipientOverrideBody.optional()') &&
  ordersRouteSrc.includes('normalizeRecipientOverride(body.recipientOverride)') &&
  ordersRouteSrc.includes('order_overrides.recipient_override') &&
  !/raw\s*=\s*jsonb_set[\s\S]{0,160}shipTo/i.test(ordersRouteSrc));
check('canonical order DTO prefers recipient override over raw marketplace shipTo',
  ordersRouteSrc.includes('resolveRecipientForShipping({') &&
  ordersRouteSrc.includes("sourceOf('local', 'order_overrides.recipient_override'"));
check('label creation paths prefer recipient override for provider payloads',
  labelsSrc.includes('loadOrderRecipientOverride') &&
  labelsSrc.includes('resolveRecipientForShipping({') &&
  labelsSrc.includes('recipientOverride'));
check('api client exposes saveOrderRecipientOverride via guarded order patch',
  apiClientSrc.includes('saveOrderRecipientOverride') &&
  apiClientSrc.includes('recipientOverride'));
check('recipient edit button opens real editor, not Phase 3 placeholder toast',
  !panelSectionsSrc.includes('Edit recipient — Phase 3') &&
  panelSectionsSrc.includes('onEditRecipient') &&
  ordersViewSrc.includes('recipientEditorOpen') &&
  ordersViewSrc.includes('saveOrderRecipientOverride'));
check('package wires PS-297 guard',
  packageJson.includes('"test:ps-297-recipient-override"'));

if (failures > 0) {
  console.error(`\nFAIL PS-297 recipient override guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS PS-297 recipient override guard');
