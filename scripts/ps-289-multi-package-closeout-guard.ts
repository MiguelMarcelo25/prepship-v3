/**
 * PS-289 closeout checkpoint.
 *
 * Keeps the multi-package card honest after the planner + sidecar schema
 * foundation: live integrations/UI/live-safety proof are still missing.
 */
import { readFileSync } from 'node:fs';

let failures = 0;
function check(name: string, condition: boolean): void {
  if (condition) {
    console.log(`ok   ${name}`);
    return;
  }
  failures += 1;
  console.error(`FAIL ${name}`);
}

const packageJson = readFileSync('package.json', 'utf8');
const doc = readFileSync('docs/ps-tickets/ps-289-multi-package-status.md', 'utf8');
const planner = readFileSync('src/services/shipping-workflow/multi-package-shipment-plan.ts', 'utf8');
const schema = readFileSync('src/db/schema/shipment-groups.ts', 'utf8');
const mockFlow = readFileSync('src/services/shipping-workflow/multi-package-mock-label-flow.ts', 'utf8');
const orchestration = readFileSync('src/services/shipping-workflow/multi-package-mock-label-orchestration.ts', 'utf8');
const printQueuePlan = readFileSync('src/services/shipping-workflow/multi-package-print-queue-plan.ts', 'utf8');
const marketplacePlan = readFileSync(
  'src/services/shipping-workflow/multi-package-marketplace-confirmation-plan.ts',
  'utf8',
);
const mockedWorkflow = readFileSync('src/services/shipping-workflow/multi-package-mocked-workflow.ts', 'utf8');
const labelPurchaseBoundary = readFileSync(
  'src/services/shipping-workflow/multi-package-label-purchase-boundary.ts',
  'utf8',
);
const carrierAdapter = readFileSync(
  'src/services/shipping-workflow/multi-package-carrier-adapter.ts',
  'utf8',
);
const shipStationAdapter = readFileSync(
  'src/services/shipping-workflow/multi-package-shipstation-adapter.ts',
  'utf8',
);
const purchasedLabelOrchestration = readFileSync(
  'src/services/shipping-workflow/multi-package-purchased-label-orchestration.ts',
  'utf8',
);
const printQueueSidecar = readFileSync(
  'src/services/shipping-workflow/multi-package-print-queue-sidecar.ts',
  'utf8',
);
const realPrintQueueContract = readFileSync(
  'src/services/shipping-workflow/multi-package-real-print-queue-contract.ts',
  'utf8',
);
const printQueueRuntimeCompat = readFileSync(
  'src/services/shipping-workflow/multi-package-print-queue-runtime-compat.ts',
  'utf8',
);
const reviewDto = readFileSync(
  'src/services/shipping-workflow/multi-package-review-dto.ts',
  'utf8',
);
const marketplaceConfirmationSidecar = readFileSync(
  'src/services/shipping-workflow/multi-package-marketplace-confirmation-sidecar.ts',
  'utf8',
);
const sourceGuard = readFileSync('scripts/ps-289-multi-package-shipment-plan-guard.ts', 'utf8');

check('package wires PS-289 planner guard',
  packageJson.includes('"test:ps-289-multi-package-plan"'));
check('package wires PS-289 schema guard',
  packageJson.includes('"test:ps-289-multi-package-schema"'));
check('package wires PS-289 mocked label flow guard',
  packageJson.includes('"test:ps-289-multi-package-mock-label-flow"'));
check('package wires PS-289 DB orchestration guard',
  packageJson.includes('"test:ps-289-multi-package-db-orchestration"'));
check('package wires PS-289 print queue plan guard',
  packageJson.includes('"test:ps-289-multi-package-print-queue-plan"'));
check('package wires PS-289 marketplace confirmation plan guard',
  packageJson.includes('"test:ps-289-multi-package-marketplace-confirmation-plan"'));
check('package wires PS-289 mocked workflow guard',
  packageJson.includes('"test:ps-289-multi-package-mocked-workflow"'));
check('package wires PS-289 label purchase boundary guard',
  packageJson.includes('"test:ps-289-multi-package-label-purchase-boundary"'));
check('package wires PS-289 carrier adapter guard',
  packageJson.includes('"test:ps-289-multi-package-carrier-adapter"'));
check('package wires PS-289 ShipStation adapter guard',
  packageJson.includes('"test:ps-289-multi-package-shipstation-adapter"'));
check('package wires PS-289 purchased label orchestration guard',
  packageJson.includes('"test:ps-289-multi-package-purchased-label-orchestration"'));
check('package wires PS-289 print queue sidecar guard',
  packageJson.includes('"test:ps-289-multi-package-print-queue-sidecar"'));
check('package wires PS-289 marketplace confirmation sidecar guard',
  packageJson.includes('"test:ps-289-multi-package-marketplace-confirmation-sidecar"'));
check('package wires PS-289 real print queue contract guard',
  packageJson.includes('"test:ps-289-multi-package-real-print-queue-contract"'));
check('package wires PS-289 print queue runtime compatibility guard',
  packageJson.includes('"test:ps-289-multi-package-print-queue-runtime-compat"'));
check('package wires PS-289 review DTO guard',
  packageJson.includes('"test:ps-289-multi-package-review-dto"'));
check('package wires PS-289 closeout guard',
  packageJson.includes('"test:ps-289-multi-package-closeout"'));
check('status doc lists planner guard',
  doc.includes('`test:ps-289-multi-package-plan`'));
check('status doc lists schema guard',
  doc.includes('`test:ps-289-multi-package-schema`'));
check('status doc lists mocked label flow guard',
  doc.includes('`test:ps-289-multi-package-mock-label-flow`'));
check('status doc lists DB orchestration guard',
  doc.includes('`test:ps-289-multi-package-db-orchestration`'));
check('status doc lists print queue plan guard',
  doc.includes('`test:ps-289-multi-package-print-queue-plan`'));
check('status doc lists marketplace confirmation plan guard',
  doc.includes('`test:ps-289-multi-package-marketplace-confirmation-plan`'));
check('status doc lists mocked workflow guard',
  doc.includes('`test:ps-289-multi-package-mocked-workflow`'));
check('status doc lists label purchase boundary guard',
  doc.includes('`test:ps-289-multi-package-label-purchase-boundary`'));
check('status doc lists carrier adapter guard',
  doc.includes('`test:ps-289-multi-package-carrier-adapter`'));
check('status doc lists ShipStation adapter guard',
  doc.includes('`test:ps-289-multi-package-shipstation-adapter`'));
check('status doc lists purchased label orchestration guard',
  doc.includes('`test:ps-289-multi-package-purchased-label-orchestration`'));
check('status doc lists print queue sidecar guard',
  doc.includes('`test:ps-289-multi-package-print-queue-sidecar`'));
check('status doc lists marketplace confirmation sidecar guard',
  doc.includes('`test:ps-289-multi-package-marketplace-confirmation-sidecar`'));
check('status doc lists real print queue contract guard',
  doc.includes('`test:ps-289-multi-package-real-print-queue-contract`'));
check('status doc lists print queue runtime compatibility guard',
  doc.includes('`test:ps-289-multi-package-print-queue-runtime-compat`'));
check('status doc lists review DTO guard',
  doc.includes('`test:ps-289-multi-package-review-dto`'));
check('status doc lists closeout guard',
  doc.includes('`test:ps-289-multi-package-closeout`'));
check('status doc keeps PS-289 conservative at 88%',
  /PS-289 88%/.test(doc));
check('status doc explicitly blocks Final Review',
  /not Final Review-ready/.test(doc));
check('status doc says sidecar persistence foundation exists',
  /additive persistence\s+foundation, mocked/.test(doc));
check('status doc says mocked per-package label identity exists',
  /mocked per-package label identity workflow, and/.test(doc));
check('status doc says DB-backed mocked orchestration exists',
  /DB-backed mocked status orchestration\s+exist/.test(doc));
check('status doc says group-aware print queue planning exists',
  /Group-aware print queue planning also exists/.test(doc));
check('status doc says marketplace confirmation planning exists',
  /Marketplace confirmation planning now exists/.test(doc));
check('status doc says end-to-end mocked workflow proof exists',
  /end-to-end mocked workflow proof now exists/i.test(doc));
check('status doc says test-gated label purchase boundary exists',
  /test-gated per-package label purchase boundary now\s+exists/.test(doc));
check('status doc says injected carrier adapter boundary exists',
  /injected carrier adapter boundary now\s+exists/i.test(doc));
check('status doc says ShipStation-shaped adapter proof exists',
  /ShipStation-shaped adapter proof now\s+exists/i.test(doc));
check('status doc says purchased label sidecar orchestration exists',
  /purchased-label sidecar orchestration now exists/i.test(doc));
check('status doc says print queue sidecar persistence exists',
  /print queue sidecar persistence now\s+exists/i.test(doc));
check('status doc says marketplace confirmation sidecar persistence exists',
  /marketplace confirmation sidecar persistence now\s+exists/i.test(doc));
check('status doc says dry-run real print queue contract exists',
  /dry-run real print queue contract now\s+exists/i.test(doc));
check('status doc says print queue runtime compatibility proof exists',
  /Runtime compatibility proof maps package-scoped queue ids back to numeric source order ids/i.test(doc));
check('status doc says backend-owned package review DTO exists',
  /backend-owned package review DTO now exists/i.test(doc));
check('status doc lists real production label creator wiring as missing',
  /Real production label creator wiring/.test(doc));
check('status doc lists real print queue insertion as missing',
  /Real print queue insertion\/printer integration/.test(doc));
check('status doc lists real marketplace notification integration as missing',
  /Real marketplace notification connector\/integration/.test(doc));
check('status doc still blocks live/canary use',
  /No live postage, marketplace notification, or operator canary/.test(doc));

check('planner exports buildMultiPackageShipmentPlan',
  /export function buildMultiPackageShipmentPlan/.test(planner));
check('planner exports multiPackageLabelIdempotencyKey',
  /export function multiPackageLabelIdempotencyKey/.test(planner));
check('planner exports buildMultiPackagePersistenceDraft',
  /export function buildMultiPackagePersistenceDraft/.test(planner));
check('planner remains pure and side-effect-free',
  /No label purchase, postage, queue, marketplace, or shipped\/cancelled mutation/.test(planner));
check('schema has additive group and package tables',
  /shipmentGroups = pgTable/.test(schema) && /shipmentGroupPackages = pgTable/.test(schema));
check('mocked flow exports buildMockedMultiPackageLabelFlow',
  /export function buildMockedMultiPackageLabelFlow/.test(mockFlow));
check('mocked flow remains non-live and zero-postage',
  /isLivePostage: false/.test(mockFlow) && /postageCost: 0/.test(mockFlow));
check('orchestration exports orchestrateMockedMultiPackageLabels',
  /export async function orchestrateMockedMultiPackageLabels/.test(orchestration));
check('orchestration remains mocked-only and sidecar-owned',
  /Mocked-only orchestration/.test(orchestration) &&
    orchestration.includes("from '../../db/schema/shipment-groups'"));
check('print queue planner exports buildMultiPackagePrintQueuePlan',
  /export function buildMultiPackagePrintQueuePlan/.test(printQueuePlan));
check('print queue planner stays pure and planned-only',
  /No real print queue writes/.test(printQueuePlan) &&
    !/from ['"].*(db|schema|print-queue|connector|labels|marketplace)/i.test(printQueuePlan));
check('marketplace confirmation planner exports buildMultiPackageMarketplaceConfirmationPlan',
  /export function buildMultiPackageMarketplaceConfirmationPlan/.test(marketplacePlan));
check('marketplace confirmation planner stays pure and planned-only',
  /No marketplace API calls, live notifications/.test(marketplacePlan) &&
    !/from ['"].*(db|schema|print-queue|connector|labels|marketplace)/i.test(marketplacePlan));
check('mocked workflow exports buildMockedMultiPackageWorkflow',
  /export function buildMockedMultiPackageWorkflow/.test(mockedWorkflow));
check('mocked workflow stays pure and non-live',
  /No DB writes, provider calls, real labels, postage, print queue writes, marketplace API calls/.test(mockedWorkflow) &&
    !/from ['"].*(db|schema|routes|connector|shipstation|shipp|easypost|walmart|orders|shipments)/i.test(mockedWorkflow));
check('label purchase boundary exports purchaseMultiPackageLabels',
  /export async function purchaseMultiPackageLabels/.test(labelPurchaseBoundary));
check('label purchase boundary has no default live purchase path',
  /No default provider calls, live postage, print queue writes, marketplace API calls/.test(labelPurchaseBoundary) &&
    !/from ['"].*(db|schema|routes|connector|shipstation|shipp|easypost|walmart|print-queue|marketplace|orders|shipments)/i.test(labelPurchaseBoundary));
check('carrier adapter exports createMultiPackageCarrierLabelPurchaser',
  /export function createMultiPackageCarrierLabelPurchaser/.test(carrierAdapter));
check('carrier adapter remains injected-only and provider-free',
  /No provider module imports, default provider calls, live postage/.test(carrierAdapter) &&
    !/from ['"].*(db|schema|routes|connector|shipstation|shipp|easypost|walmart|print-queue|marketplace|orders|shipments)/i.test(carrierAdapter));
check('ShipStation adapter exports createShipStationMultiPackageLabelPurchaser',
  /export function createShipStationMultiPackageLabelPurchaser/.test(shipStationAdapter));
check('ShipStation adapter uses pure request builder without network creator',
  /buildSsLabelRequestBody/.test(shipStationAdapter) &&
    /No ShipStation network call, default live postage/.test(shipStationAdapter) &&
    !/ssCreateLabel|ssRequest|ssV1Request|from ['"].*(routes|connector|print-queue|marketplace|orders|shipments)/i.test(shipStationAdapter));
check('purchased label orchestration exports orchestratePurchasedMultiPackageLabels',
  /export async function orchestratePurchasedMultiPackageLabels/.test(purchasedLabelOrchestration));
check('purchased label orchestration stays sidecar-owned',
  /No provider calls by default, no print queue writes, no marketplace API calls/.test(purchasedLabelOrchestration) &&
    purchasedLabelOrchestration.includes("from '../../db/schema/shipment-groups'") &&
    !/from ['"].*(routes|connector|shipstation|shipp|easypost|walmart|print-queue|marketplace|orders|shipments)/i.test(purchasedLabelOrchestration));
check('print queue sidecar exports orchestrateMultiPackagePrintQueueSidecar',
  /export async function orchestrateMultiPackagePrintQueueSidecar/.test(printQueueSidecar));
check('print queue sidecar does not write the real print queue',
  /No real print queue table writes, printer calls/.test(printQueueSidecar) &&
    printQueueSidecar.includes("from '../../db/schema/shipment-groups'") &&
    !/from ['"].*(routes|connector|shipstation|shipp|easypost|walmart|print-queue|marketplace|orders|shipments)/i.test(printQueueSidecar));
check('real print queue dry-run contract exports package-scoped mapping',
  /export function buildMultiPackageRealPrintQueueDryRun/.test(realPrintQueueContract) &&
    /export function multiPackagePrintQueueOrderId/.test(realPrintQueueContract) &&
    /print_queue_order_client_unq/.test(realPrintQueueContract));
check('real print queue dry-run contract proves source-order collapse without inserting',
  /wouldCollapseWithSourceOrderId/.test(realPrintQueueContract) &&
    /package_scoped_order_id/.test(realPrintQueueContract) &&
    /realPrintQueueInserted: false/.test(realPrintQueueContract));
check('real print queue dry-run contract stays pure and offline',
  /without writing that table/.test(realPrintQueueContract) &&
    !/from ['"].*(db\/client|routes|connectors|marketplace|shipstation|shipp|easypost|walmart)/i.test(realPrintQueueContract) &&
    !/\.insert\(|\.update\(|\.delete\(|fetch\(/.test(realPrintQueueContract));
check('print queue runtime compat exports source-order resolver',
  /export function parseMultiPackagePrintQueueOrderId/.test(printQueueRuntimeCompat) &&
    /export function resolvePrintQueueSourceOrderId/.test(printQueueRuntimeCompat) &&
    /export function buildPrintQueueRuntimeCompatPlan/.test(printQueueRuntimeCompat));
check('print queue runtime compat stays pure and offline',
  /Pure only/.test(printQueueRuntimeCompat) &&
    !/from ['"].*(db|schema|routes|connectors|marketplace|shipstation|shipp|easypost|walmart|print-queue)/i.test(printQueueRuntimeCompat) &&
    !/\.insert\(|\.update\(|\.delete\(|fetch\(/.test(printQueueRuntimeCompat));
check('review DTO exports buildMultiPackageReviewDto',
  /export function buildMultiPackageReviewDto/.test(reviewDto));
check('review DTO keeps package review rows backend-owned',
  /Backend-owned read model/.test(reviewDto) &&
    /MultiPackageReviewPackageRow/.test(reviewDto));
check('review DTO merges planned packages with backend sidecar facts',
  /labelFlow/.test(reviewDto) &&
    /printQueueSidecarPlan/.test(reviewDto) &&
    /marketplaceConfirmationSidecarPlan/.test(reviewDto));
check('review DTO stays pure and offline',
  /No DB reads\/writes, provider calls, postage, print queue writes, marketplace/.test(reviewDto) &&
    !/from ['"].*(db|schema|routes|connector|shipstation|shipp|easypost|walmart|orders|shipments)/i.test(reviewDto) &&
    !/\.insert\(|\.update\(|\.delete\(|fetch\(/.test(reviewDto));
check('marketplace confirmation sidecar exports orchestrateMultiPackageMarketplaceConfirmationSidecar',
  /export async function orchestrateMultiPackageMarketplaceConfirmationSidecar/.test(marketplaceConfirmationSidecar));
check('marketplace confirmation sidecar writes only shipment group sidecars',
  /No marketplace API calls, live marketplace notifications/.test(marketplaceConfirmationSidecar) &&
    marketplaceConfirmationSidecar.includes("from '../../db/schema/shipment-groups'") &&
    !/from ['"].*(routes|connector|shipstation|shipp|easypost|walmart|print-queue|orders|shipments)/i.test(marketplaceConfirmationSidecar));
check('source guard rejects duplicate package keys',
  sourceGuard.includes('duplicate package keys are rejected before any label purchase planning'));

if (failures > 0) {
  console.error(`\nFAIL PS-289 multi-package closeout guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS PS-289 multi-package closeout guard');
