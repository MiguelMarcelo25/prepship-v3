/**
 * PS-219 guard — operator-facing Void Label UI on the completed PS-211 workflow.
 *
 * Per user override unlock shipped data on 2026-06-13: the shipped-order detail
 * gains a Void Label action. The BACKEND owns voidability; the FE is a thin
 * consumer that never recomputes it, never mutates shipments locally, and never
 * constructs a shipment/provider id for the void call.
 *
 *   npx tsx scripts/ps-219-void-label-ui-guard.ts
 */
import { readFileSync } from 'node:fs';

const voidability = readFileSync('src/services/label-voidability.ts', 'utf8');
const orders = readFileSync('src/routes/orders.ts', 'utf8');
const apiClient = readFileSync('web/src/lib/v2-apiClient.ts', 'utf8');
const ordersView = readFileSync('web/src/components/Views/OrdersView.tsx', 'utf8');
const shippingFields = readFileSync('web/src/components/Views/OrdersPanelShippingFields.tsx', 'utf8');
const pkg = readFileSync('package.json', 'utf8');

let failures = 0;
function check(name: string, cond: boolean) {
  if (!cond) { failures += 1; console.error(`FAIL ${name}`); }
  else console.log(`ok   ${name}`);
}

// 1. Backend read-only owner reuses the PS-211 deciders and performs NO write.
check('resolveOrderLabelVoidability owner exists',
  voidability.includes('export function resolveOrderLabelVoidability('));
check('reuses PS-211 resolveLabelVoidDispatch', voidability.includes('resolveLabelVoidDispatch'));
check('reuses PS-211 carrierConnectorSupportsVoid', voidability.includes('carrierConnectorSupportsVoid'));
check('exposes the backend reasonCode enum',
  voidability.includes("'already_voided'") && voidability.includes("'not_supported'")
  && voidability.includes("'missing_provider_label_id'") && voidability.includes("'no_active_shipment'"));
check('voidability resolver performs NO db write (ps-211 single-write intact)',
  !/\.set\(|db\.update|db\.insert|db\.delete/.test(voidability));

// 2. The shipped-order detail DTO stamps labelVoidability on BOTH handlers.
const dtoCalls = orders.split('labelVoidability: resolveOrderLabelVoidability(').length - 1;
check(`both detail handlers stamp labelVoidability (found ${dtoCalls})`, dtoCalls >= 2);

// 3. apiClient.voidLabel is a pure pass-through to the void route.
check('apiClient.voidLabel exists', /voidLabel\(shipmentId: number\)/.test(apiClient));
check('apiClient.voidLabel POSTs /labels/:shipmentId/void',
  apiClient.includes('/labels/${encodeURIComponent(String(shipmentId))}/void'));

// 4. FE uses ONLY the backend-stamped local shipment id; no FE void write / no
//    optimistic local void / no FE-constructed id.
check('FE voids with the backend-stamped shipmentId',
  ordersView.includes('apiClient.voidLabel(voidConfirm.shipmentId)'));
check('FE openVoidConfirm reads labelVoidability.shipmentId',
  ordersView.includes('labelVoidability') && ordersView.includes('v.shipmentId'));
check('OrdersView never optimistically marks a label voided',
  !/voided:\s*true/.test(ordersView));

// 5. The Void button is BACKEND-GATED and single-order (no batch).
check('Void button gated on backend voidable', shippingFields.includes('labelVoidability?.voidable'));
check('disabled Void button shows the backend reasonCode copy', shippingFields.includes('voidReasonCopy('));
check('Void action hidden when there is no active shipment', shippingFields.includes('voidShipmentId != null'));
check('shipped-label-actions + shipped-void-action testids present',
  shippingFields.includes('data-testid="shipped-label-actions"') && shippingFields.includes('data-testid="shipped-void-action"'));
check('no batch-void path', !/batchVoid|voidLabel\([^)]*\.map\(/i.test(ordersView));

// 6. Void runs ONLY via the danger ConfirmModal, branching on HTTP status.
check('void goes through the danger ConfirmModal',
  ordersView.includes('<ConfirmModal') && ordersView.includes('tone="danger"') && ordersView.includes('confirmVoidLabel'));
check('FE branches on HTTP status (not message text)',
  ordersView.includes('status === 409') && ordersView.includes('status === 502') && ordersView.includes('status === 404'));

// Self-wiring.
check('package.json exposes test:ps-219-void-label-ui', /test:ps-219-void-label-ui/.test(pkg));

if (failures > 0) {
  console.error(`\nFAIL PS-219 void label UI guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-219 void label UI guard');
