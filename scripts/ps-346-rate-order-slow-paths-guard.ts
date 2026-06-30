/**
 * PS-346 - rate/order slow-path guard.
 *
 * First slice: pin the planning artifacts and the shared JSON settings helper
 * that later durable rate/queue workflow snapshots must use. Offline/static
 * only: no DB, no provider calls, no labels, no queue mutation.
 */
import { existsSync, readFileSync } from 'node:fs';

let failures = 0;

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

function check(name: string, condition: boolean): void {
  if (!condition) {
    failures += 1;
    console.error(`FAIL ${name}`);
    return;
  }
  console.log(`ok   ${name}`);
}

function fileText(path: string): string {
  return existsSync(path) ? read(path) : '';
}

const packageJson = read('package.json');
const ledger = read('docs/ps-tickets/ps-ledger.md');
const findingsPath = 'docs/ps-tickets/ps-346-rate-order-slow-path-findings.md';
const queueVolumeEvidencePath = 'docs/ps-tickets/ps-346-print-queue-volume-evidence.md';
const planPath = 'docs/superpowers/plans/2026-06-29-ps-346-rate-order-slow-paths.md';
const helperPath = 'src/services/settings-json.ts';
const workflowTypesPath = 'src/services/rate-browse-workflow-types.ts';
const workflowStorePath = 'src/services/rate-browse-workflow-store.ts';
const workflowServicePath = 'src/services/rate-browse-workflow.ts';
const workflowSnapshotsPath = 'src/services/rate-browse-workflow-snapshots.ts';
const browseDisplayPath = 'src/services/rate-browser-display-fields.ts';
const browseProducerPath = 'src/services/rate-browse-response-producer.ts';
const workflowHookPath = 'web/src/hooks/useRateBrowseWorkflow.ts';
const partialDisplayPath = 'web/src/components/rate-browser-partial-result.ts';
const openWorkflowPath = 'web/src/components/rate-browser-open-workflow.ts';
const ordersRefetchCoordinatorPath = 'web/src/hooks/orders-refetch-coordinator.ts';
const ordersRefetchBehaviorPath = 'scripts/ps-346-orders-refetch-coordinator-behavior.ts';
const partialWorkflowBehaviorPath = 'scripts/ps-346-rate-browse-partial-workflow-behavior.ts';
const openLiveWorkflowGuardPath = 'scripts/ps-346-rate-browser-open-live-workflow-guard.ts';
const queueVolumeEvidenceGuardPath = 'scripts/ps-346-print-queue-volume-evidence-guard.ts';
const findings = fileText(findingsPath);
const queueVolumeEvidence = fileText(queueVolumeEvidencePath);
const plan = fileText(planPath);
const helper = fileText(helperPath);
const workflowTypes = fileText(workflowTypesPath);
const workflowStore = fileText(workflowStorePath);
const workflowService = fileText(workflowServicePath);
const workflowSnapshots = fileText(workflowSnapshotsPath);
const browseDisplay = fileText(browseDisplayPath);
const browseProducer = fileText(browseProducerPath);
const workflowHook = fileText(workflowHookPath);
const partialDisplay = fileText(partialDisplayPath);
const openWorkflow = fileText(openWorkflowPath);
const ordersRefetchCoordinator = fileText(ordersRefetchCoordinatorPath);
const ordersRefetchBehavior = fileText(ordersRefetchBehaviorPath);
const partialWorkflowBehavior = fileText(partialWorkflowBehaviorPath);
const openLiveWorkflowGuard = fileText(openLiveWorkflowGuardPath);
const queueVolumeEvidenceGuard = fileText(queueVolumeEvidenceGuardPath);
const ratesRoute = read('src/routes/rates.ts');
const apiClient = read('web/src/lib/v2-apiClient.ts');
const rateBrowserModal = read('web/src/components/RateBrowserModal.tsx');
const useOrders = read('web/src/hooks/useOrders.ts');

check(
  'package wires PS-346 slow-path guard',
  packageJson.includes('"test:ps-346-rate-order-slow-paths": "tsx scripts/ps-346-rate-order-slow-paths-guard.ts"'),
);

check(
  'package wires PS-346 Orders refetch coordinator behavior guard',
  packageJson.includes('"test:ps-346-orders-refetch-coordinator": "tsx scripts/ps-346-orders-refetch-coordinator-behavior.ts"'),
);

check(
  'package wires PS-346 partial Rate Browser workflow behavior guard',
  packageJson.includes('"test:ps-346-rate-browse-partial-workflow": "tsx scripts/ps-346-rate-browse-partial-workflow-behavior.ts"'),
);

check(
  'package wires PS-346 Rate Browser open live workflow guard',
  packageJson.includes('"test:ps-346-rate-browser-open-live-workflow": "tsx scripts/ps-346-rate-browser-open-live-workflow-guard.ts"'),
);

check(
  'package wires PS-346 print queue volume evidence guard',
  packageJson.includes('"test:ps-346-print-queue-volume-evidence": "tsx scripts/ps-346-print-queue-volume-evidence-guard.ts"'),
);

check(
  'PS-346 findings doc exists and records root-cause findings, baseline guards, and safety',
  existsSync(findingsPath) &&
    findings.includes('## Root-Cause Findings') &&
    findings.includes('## Baseline Guards') &&
    findings.includes('## Safety') &&
    findings.includes('No labels, postage, marketplace notifications'),
);

check(
  'PS-346 implementation plan exists and carries the shipped-data lockdown gate',
  existsSync(planPath) &&
    plan.includes('# PS-346 Rate And Order Slow Paths Implementation Plan') &&
    plan.includes('## Lockdown Gate') &&
    plan.includes('unlock shipped data') &&
    plan.includes('Print Queue work in this plan is limited to docs, guards, and read-only evidence outside locked files'),
);

check(
  'PS-346 print queue volume evidence records the current safe boundary and remaining locked blocker',
  existsSync(queueVolumeEvidencePath) &&
    queueVolumeEvidence.includes('## Root-Cause Findings') &&
    queueVolumeEvidence.includes('## Current Safe Proof') &&
    queueVolumeEvidence.includes('## Remaining Blocker') &&
    queueVolumeEvidence.includes('durable fallback is capped to the latest 10 result samples') &&
    queueVolumeEvidence.includes('unlock shipped data'),
);

check(
  'shared JSON settings helper exists',
  existsSync(helperPath),
);

check(
  'shared JSON settings helper delegates persistence through the canonical settings service',
  /import \{ getSetting, setSetting \} from ['"]\.\/settings['"]/.test(helper) &&
    /export async function setJsonSetting\(\s*key: string,\s*value: unknown\s*\)/.test(helper) &&
    /await setSetting\(key, JSON\.stringify\(value\)\)/.test(helper),
);

check(
  'shared JSON settings helper supports multi-key snapshot writes without hand-rolled settings upsert',
  /export async function setJsonSettings\(\s*rows: ReadonlyArray<JsonSettingRow<unknown>>\s*\)/.test(helper) &&
    /for \(const row of rows\)/.test(helper) &&
    /await setJsonSetting\(row\.key, row\.value\)/.test(helper) &&
    !/insert\(settings\)/.test(helper) &&
    !/\.values\(\s*\[/.test(helper),
);

check(
  'shared JSON settings helper reads typed JSON safely',
  /export async function getJsonSetting<T>\(key: string\): Promise<T \| null>/.test(helper) &&
    /const value = await getSetting\(key\)/.test(helper) &&
    /JSON\.parse\(value\) as T/.test(helper) &&
    /return null/.test(helper),
);

check(
  'PS-346 ledger row reserves the Trello slow-path ticket',
  ledger.includes('| PS-346 | Rate/order slow paths and partial Rate Browser results | https://trello.com/c/CcZRrJsH | `codex/ps-346-slow-paths-plan` | In progress |'),
);

check(
  'rate browse workflow DTO defines partial/final backend-owned phases',
  existsSync(workflowTypesPath) &&
    /export type RateBrowseWorkflowPhase = 'queued' \| 'cached' \| 'running' \| 'partial' \| 'complete' \| 'error'/.test(workflowTypes) &&
    /export type RateBrowseWorkflowSnapshot = \{/.test(workflowTypes) &&
    /jobId: string/.test(workflowTypes) &&
    /requestKey: string \| null/.test(workflowTypes) &&
    /totalCarriers: number/.test(workflowTypes) &&
    /completedCarriers: number/.test(workflowTypes) &&
    /result: Record<string, unknown> \| null/.test(workflowTypes) &&
    /diagnostics: Record<string, unknown>/.test(workflowTypes),
);

check(
  'rate browse workflow store persists latest and job-specific snapshots through JSON settings helper',
  existsSync(workflowStorePath) &&
    /import \{ getJsonSetting, setJsonSettings \} from ['"]\.\/settings-json['"]/.test(workflowStore) &&
    /import type \{ RateBrowseWorkflowSnapshot \} from ['"]\.\/rate-browse-workflow-types['"]/.test(workflowStore) &&
    /export const RATE_BROWSE_WORKFLOW_LATEST_KEY = 'rate_browse_workflow\.latest'/.test(workflowStore) &&
    /export const RATE_BROWSE_WORKFLOW_JOB_PREFIX = 'rate_browse_workflow\.job\.'/.test(workflowStore) &&
    /export async function persistRateBrowseWorkflowSnapshot\(\s*snapshot: RateBrowseWorkflowSnapshot/.test(workflowStore) &&
    /setJsonSettings\(\[\s*\{\s*key: RATE_BROWSE_WORKFLOW_LATEST_KEY,\s*value: snapshot\s*\},\s*\{\s*key: rateBrowseWorkflowJobKey\(snapshot\.jobId\),\s*value: snapshot\s*\},\s*\]\)/s.test(workflowStore),
);

check(
  'rate browse workflow store reads snapshots by backend job id',
  /export function rateBrowseWorkflowJobKey\(jobId: string\): string/.test(workflowStore) &&
    /export async function getRateBrowseWorkflowSnapshot\(jobId: string\): Promise<RateBrowseWorkflowSnapshot \| null>/.test(workflowStore) &&
    /return getJsonSetting<RateBrowseWorkflowSnapshot>\(rateBrowseWorkflowJobKey\(jobId\)\)/.test(workflowStore),
);

check(
  'backend rate browse workflow service owns durable job lifecycle without rate-ranking business rules',
  existsSync(workflowServicePath) &&
    /export type StartRateBrowseWorkflowInput = \{/.test(workflowService) &&
    /getInitialResult\?: \(\) => Promise<Record<string, unknown> \| null>/.test(workflowService) &&
    /run: \(\) => Promise<Record<string, unknown>>/.test(workflowService) &&
    /export async function startRateBrowseWorkflow\(/.test(workflowService) &&
    /export async function getRateBrowseWorkflow\(jobId: string\): Promise<RateBrowseWorkflowSnapshot \| null>/.test(workflowService) &&
    /persistRateBrowseWorkflowSnapshot/.test(workflowService) &&
    !/combineCarrierUniverses|rateTotal|loadCarrierMarkups|withSelectedRateKeys|selectedRateOpaqueKey/.test(workflowService),
);

check(
  'backend rate browse workflow service records queued, running, partial, complete, and error snapshots',
  /phase: 'queued'/.test(workflowService) &&
    /phase: 'running'/.test(workflowService) &&
    /phase: 'partial'/.test(workflowService) &&
    /phase: 'complete'/.test(workflowService) &&
    /phase: 'error'/.test(workflowService) &&
    /void runRateBrowseWorkflowJob/.test(workflowService),
);

check(
  'backend rate browse workflow snapshots count partial coverage without owning rate ranking',
  existsSync(workflowSnapshotsPath) &&
    /export function countRateBrowseCarrierStatuses\(result: Record<string, unknown>\)/.test(workflowSnapshots) &&
    /export function buildRateBrowseResultSnapshot\(input: \{/.test(workflowSnapshots) &&
    /phase: Extract<RateBrowseWorkflowPhase, 'partial' \| 'complete'>/.test(workflowSnapshots) &&
    /ratesCount: arrayLength\(input\.result\.rates\)/.test(workflowSnapshots) &&
    /requestKey: resultRequestKey\(input\.result, input\.base\.requestKey\)/.test(workflowSnapshots) &&
    !/combineCarrierUniverses|rateTotal|loadCarrierMarkups|withSelectedRateKeys|selectedRateOpaqueKey/.test(workflowSnapshots),
);

check(
  'rates route exposes additive backend workflow start and status endpoints',
  /import \{\s*getRateBrowseWorkflow,\s*startRateBrowseWorkflow,\s*\} from ['"]\.\.\/services\/rate-browse-workflow['"]/.test(ratesRoute) &&
    /app\.post\('\/browse\/workflow', zValidator\('json', browseBody\), async \(c\) =>/.test(ratesRoute) &&
    /app\.get\('\/browse\/workflow\/:jobId', async \(c\) =>/.test(ratesRoute) &&
    /job_id: snapshot\.jobId/.test(ratesRoute) &&
    /status: snapshot\.phase/.test(ratesRoute),
);

check(
  'rate browser display stamping lives in a focused backend service',
  existsSync(browseDisplayPath) &&
    /import \{ stampPurchaseCustomerRateAliases \} from ['"]\.\/shipping-workflow\/purchase-customer-rate-aliases\.js['"]/.test(browseDisplay) &&
    /export function stampRateBrowserDisplayAliases<T>\(value: T\): T/.test(browseDisplay) &&
    /export function stampHugrabCoverageDisplayFields<T extends Record<string, unknown>>/.test(browseDisplay) &&
    /return stampPurchaseCustomerRateAliases\(\{/.test(browseDisplay),
);

check(
  'rate browse response producer centralizes the real backend browse payload',
  existsSync(browseProducerPath) &&
    /export async function produceRateBrowsePayload\(/.test(browseProducer) &&
    /combineCarrierUniverses/.test(browseProducer) &&
    /finalizeBestRateWithQuote/.test(browseProducer) &&
    /buildBestRateWorkflowDto/.test(browseProducer) &&
    /runRateBrowseSingleFlight/.test(browseProducer),
);

check(
  'workflow endpoint delegates to the real backend browse producer, not a placeholder payload',
  /import \{\s*produceRateBrowsePayload\s*\} from ['"]\.\.\/services\/rate-browse-response-producer['"]/.test(ratesRoute) &&
    /run: \(\) => produceRateBrowsePayload\(\{/.test(ratesRoute) &&
    !/workflow-lifecycle|final browse producer remains \/rates\/browse until the next slice/.test(ratesRoute),
);

check(
  'workflow endpoint emits a cache-first partial preview before the live browse finishes',
  /function cachedRateBrowsePreviewBody<T extends Record<string, unknown>>\(body: T\): T/.test(ratesRoute) &&
    /cachedOnly: true/.test(ratesRoute) &&
    /forceLive: false/.test(ratesRoute) &&
    /forceRefresh: false/.test(ratesRoute) &&
    /strictRecalculate: false/.test(ratesRoute) &&
    /manualEstimate: false/.test(ratesRoute) &&
    /getInitialResult: body\.forceLive === true\s*\?\s*\(\) => produceRateBrowsePayload\(\{[\s\S]*cachedRateBrowsePreviewBody\(body\)/.test(ratesRoute),
);

check(
  'normal /rates/browse route returns the same backend producer payload',
  /const payload = await produceRateBrowsePayload\(\{/.test(ratesRoute) &&
    /return c\.json\(publicRatesResult\(payload, canViewFinancials\)\)/.test(ratesRoute),
);

check(
  'existing final-response /rates/browse compatibility route remains in place',
  /app\.post\('\/browse', zValidator\('json', browseBody\), async \(c\) =>/.test(ratesRoute) &&
    /return c\.json\(publicRatesResult\(payload, canViewFinancials\)\)/.test(ratesRoute),
);

check(
  'v2 api client exposes backend rate browse workflow start and status transports',
  /startRateBrowseWorkflow\(data: Record<string, unknown>\): Promise<any>/.test(apiClient) &&
    /api\.post<any>\('\/rates\/browse\/workflow'/.test(apiClient) &&
    /fetchRateBrowseWorkflow\(jobId: string\): Promise<any>/.test(apiClient) &&
    /api\.get<any>\(`\/rates\/browse\/workflow\/\$\{encodeURIComponent\(jobId\)\}`\)/.test(apiClient),
);

check(
  'useRateBrowseWorkflow hook polls backend workflow status and returns backend result only',
  existsSync(workflowHookPath) &&
    /export function useRateBrowseWorkflow\(\)/.test(workflowHook) &&
    /export type RunRateBrowseWorkflowOptions = \{/.test(workflowHook) &&
    /onPartialResult\?: \(result: Record<string, unknown>, snapshot: RateBrowseWorkflowSnapshot\) => void/.test(workflowHook) &&
    /apiClient\.startRateBrowseWorkflow/.test(workflowHook) &&
    /apiClient\.fetchRateBrowseWorkflow/.test(workflowHook) &&
    /while \(true\)/.test(workflowHook) &&
    /snapshot\.status === 'complete'/.test(workflowHook) &&
    /snapshot\.result/.test(workflowHook) &&
    !/apiClient\.browseRates/.test(workflowHook),
);

check(
  'useRateBrowseWorkflow emits each backend partial result once while still waiting for final complete',
  /const emittedPartialKeys = new Set<string>\(\)/.test(workflowHook) &&
    /nextSnapshot\.status === 'partial'/.test(workflowHook) &&
    /options\.onPartialResult\?\.\(nextSnapshot\.result, nextSnapshot\)/.test(workflowHook) &&
    /return snapshot\.result/.test(workflowHook),
);

check(
  'RateBrowserModal routes explicit live browse through the backend workflow hook',
  /import \{ useRateBrowseWorkflow \} from ['"]\.\.\/hooks\/useRateBrowseWorkflow['"]/.test(rateBrowserModal) &&
    /import \{ buildPartialRateBrowseDisplayState \} from ['"]\.\/rate-browser-partial-result['"]/.test(rateBrowserModal) &&
    /runRateBrowseWorkflow/.test(rateBrowserModal) &&
    /const browsePayload = \{/.test(rateBrowserModal) &&
    /options\.forceLive === true\s*\?\s*runRateBrowseWorkflow\(browsePayload, \{ onPartialResult: applyPartialBrowseResult \}\)\s*:\s*apiClient\.browseRates\(browsePayload\)/.test(rateBrowserModal) &&
    /onClick=\{\(\) => void browseRates\(undefined, \{ forceLive: true \}\)\}/.test(rateBrowserModal),
);

check(
  'RateBrowserModal starts all-carrier backend live workflow on open',
  existsSync(openWorkflowPath) &&
    /export function rateBrowserOpenBrowseOptions\(\)/.test(openWorkflow) &&
    /return \{ forceLive: true \}/.test(openWorkflow) &&
    /import \{ rateBrowserOpenBrowseOptions \} from ['"]\.\/rate-browser-open-workflow['"]/.test(rateBrowserModal) &&
    /Start the live carrier workflow on open/.test(rateBrowserModal) &&
    /void browseRates\(undefined, rateBrowserOpenBrowseOptions\(\)\)/.test(rateBrowserModal) &&
    !/Start the live carrier workflow on open[\s\S]{0,900}cachedOnly:\s*true/.test(rateBrowserModal),
);

check(
  'RateBrowserModal displays partial workflow results without applying or persisting them',
  existsSync(partialDisplayPath) &&
    /export function buildPartialRateBrowseDisplayState\(input: \{/.test(partialDisplay) &&
    /sortRateRowsByBackendDisplayRank/.test(partialDisplay) &&
    /return \{\s*ratesByPid,/s.test(partialDisplay) &&
    /const applyPartialBrowseResult = \(partialResult: Record<string, unknown>\) => \{/.test(rateBrowserModal) &&
    /setRatesByPid\(\(current\) => \(\{ \.\.\.current, \.\.\.partialDisplay\.ratesByPid \}\)\)/.test(rateBrowserModal) &&
    !/buildPartialRateBrowseDisplayState[\s\S]{0,2400}emitBestRateResolved/.test(rateBrowserModal) &&
    !/buildPartialRateBrowseDisplayState[\s\S]{0,2400}onApplyRate/.test(rateBrowserModal),
);

check(
  'RateBrowserModal renders backend workflow progress without owning rate math',
  /rateWorkflowSnapshot/.test(rateBrowserModal) &&
    /data-rate-browser="workflowProgress"/.test(rateBrowserModal) &&
    /rateWorkflowSnapshot\.progress/.test(rateBrowserModal) &&
    !/rateWorkflowSnapshot[\s\S]{0,1200}sort\(/.test(rateBrowserModal),
);

check(
  'Orders refetch coordinator helper exists and serializes overlapping /orders refresh requests',
  existsSync(ordersRefetchCoordinatorPath) &&
    /export function createOrdersRefetchCoordinator/.test(ordersRefetchCoordinator) &&
    /let inFlight: Promise<void> \| null = null/.test(ordersRefetchCoordinator) &&
    /let queued = false/.test(ordersRefetchCoordinator) &&
    /if \(inFlight\) \{\s*queued = true/.test(ordersRefetchCoordinator) &&
    /await run\(nextReason \?\? undefined\)/.test(ordersRefetchCoordinator) &&
    /if \(!queued\) break/.test(ordersRefetchCoordinator),
);

check(
  'useOrders delegates manual refetches through the PS-346 coordinator',
  /import \{ createOrdersRefetchCoordinator \} from ['"]\.\/orders-refetch-coordinator['"]/.test(useOrders) &&
    /const refetchCoordinatorRef = useRef<ReturnType<typeof createOrdersRefetchCoordinator> \| null>\(null\)/.test(useOrders) &&
    /createOrdersRefetchCoordinator\(async \(\) => \{\s*await queryRefetchRef\.current\(\);\s*\}\)/s.test(useOrders) &&
    /await refetchCoordinatorRef\.current\?\.request\('orders-refetch'\)/.test(useOrders),
);

check(
  'PS-346 behavior guard proves overlapping refetches collapse into one active and one trailing request',
  existsSync(ordersRefetchBehaviorPath) &&
    /concurrent refetch requests must share the active \/orders request/.test(ordersRefetchBehavior) &&
    /requests arriving during an active refetch collapse into one trailing refresh/.test(ordersRefetchBehavior) &&
    /maxActive, 1/.test(ordersRefetchBehavior),
);

check(
  'PS-346 behavior guard proves partial workflow snapshots expose cache-first rates before final live result',
  existsSync(partialWorkflowBehaviorPath) &&
    /cached preview must be persisted as a partial workflow snapshot/.test(partialWorkflowBehavior) &&
    /partial snapshots must not mark the workflow final/.test(partialWorkflowBehavior) &&
    /final live result replaces the partial request key/.test(partialWorkflowBehavior),
);

check(
  'PS-346 guard proves Rate Browser open does not stop at cached-only partial coverage',
  existsSync(openLiveWorkflowGuardPath) &&
    /Rate Browser open should request the backend live workflow across all scoped carriers/.test(openLiveWorkflowGuard) &&
    /Rate Browser open must not stop at cached-only partial coverage/.test(openLiveWorkflowGuard),
);

check(
  'PS-346 print queue volume evidence guard pins selected-run totals and active-job per-order proof',
  existsSync(queueVolumeEvidenceGuardPath) &&
    /backend active batch-send status returns the full in-memory per-order results for the current run/.test(queueVolumeEvidenceGuard) &&
    /OrdersView polls each backend queue-send job with the selected run total, not a cumulative queue count/.test(queueVolumeEvidenceGuard) &&
    /durable fallback remains capped and must not be treated as full per-order proof for long batches/.test(queueVolumeEvidenceGuard),
);

if (failures > 0) {
  console.error(`\nFAIL PS-346 rate/order slow-path guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS PS-346 rate/order slow-path guard');
