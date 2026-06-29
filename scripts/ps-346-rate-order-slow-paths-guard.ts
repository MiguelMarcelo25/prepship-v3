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
const planPath = 'docs/superpowers/plans/2026-06-29-ps-346-rate-order-slow-paths.md';
const helperPath = 'src/services/settings-json.ts';
const workflowTypesPath = 'src/services/rate-browse-workflow-types.ts';
const workflowStorePath = 'src/services/rate-browse-workflow-store.ts';
const workflowServicePath = 'src/services/rate-browse-workflow.ts';
const browseDisplayPath = 'src/services/rate-browser-display-fields.ts';
const browseProducerPath = 'src/services/rate-browse-response-producer.ts';
const workflowHookPath = 'web/src/hooks/useRateBrowseWorkflow.ts';
const findings = fileText(findingsPath);
const plan = fileText(planPath);
const helper = fileText(helperPath);
const workflowTypes = fileText(workflowTypesPath);
const workflowStore = fileText(workflowStorePath);
const workflowService = fileText(workflowServicePath);
const browseDisplay = fileText(browseDisplayPath);
const browseProducer = fileText(browseProducerPath);
const workflowHook = fileText(workflowHookPath);
const ratesRoute = read('src/routes/rates.ts');
const apiClient = read('web/src/lib/v2-apiClient.ts');
const rateBrowserModal = read('web/src/components/RateBrowserModal.tsx');

check(
  'package wires PS-346 slow-path guard',
  packageJson.includes('"test:ps-346-rate-order-slow-paths": "tsx scripts/ps-346-rate-order-slow-paths-guard.ts"'),
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
    /run: \(\) => Promise<Record<string, unknown>>/.test(workflowService) &&
    /export async function startRateBrowseWorkflow\(/.test(workflowService) &&
    /export async function getRateBrowseWorkflow\(jobId: string\): Promise<RateBrowseWorkflowSnapshot \| null>/.test(workflowService) &&
    /persistRateBrowseWorkflowSnapshot/.test(workflowService) &&
    !/combineCarrierUniverses|rateTotal|loadCarrierMarkups|withSelectedRateKeys|selectedRateOpaqueKey/.test(workflowService),
);

check(
  'backend rate browse workflow service records queued, running, complete, and error snapshots',
  /phase: 'queued'/.test(workflowService) &&
    /phase: 'running'/.test(workflowService) &&
    /phase: 'complete'/.test(workflowService) &&
    /phase: 'error'/.test(workflowService) &&
    /void runRateBrowseWorkflowJob/.test(workflowService),
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
    /export function stampRateBrowserDisplayAliases<T>\(value: T\): T/.test(browseDisplay) &&
    /export function stampHugrabCoverageDisplayFields<T extends Record<string, unknown>>/.test(browseDisplay) &&
    /rateTotal/.test(browseDisplay) &&
    /rateCostTotal/.test(browseDisplay),
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
    /apiClient\.startRateBrowseWorkflow/.test(workflowHook) &&
    /apiClient\.fetchRateBrowseWorkflow/.test(workflowHook) &&
    /while \(true\)/.test(workflowHook) &&
    /snapshot\.status === 'complete'/.test(workflowHook) &&
    /snapshot\.result/.test(workflowHook) &&
    !/apiClient\.browseRates/.test(workflowHook),
);

check(
  'RateBrowserModal keeps modal-open cache probe display-only',
  /void browseRates\(undefined, \{ cachedOnly: true \}\)/.test(rateBrowserModal) &&
    !/Try the cache on open[\s\S]{0,900}forceLive: true/.test(rateBrowserModal),
);

check(
  'RateBrowserModal routes explicit live browse through the backend workflow hook',
  /import \{ useRateBrowseWorkflow \} from ['"]\.\.\/hooks\/useRateBrowseWorkflow['"]/.test(rateBrowserModal) &&
    /runRateBrowseWorkflow/.test(rateBrowserModal) &&
    /const browsePayload = \{/.test(rateBrowserModal) &&
    /options\.forceLive === true\s*\?\s*runRateBrowseWorkflow\(browsePayload\)\s*:\s*apiClient\.browseRates\(browsePayload\)/.test(rateBrowserModal) &&
    /onClick=\{\(\) => void browseRates\(undefined, \{ forceLive: true \}\)\}/.test(rateBrowserModal),
);

check(
  'RateBrowserModal renders backend workflow progress without owning rate math',
  /rateWorkflowSnapshot/.test(rateBrowserModal) &&
    /data-rate-browser="workflowProgress"/.test(rateBrowserModal) &&
    /rateWorkflowSnapshot\.progress/.test(rateBrowserModal) &&
    !/rateWorkflowSnapshot[\s\S]{0,1200}sort\(/.test(rateBrowserModal),
);

if (failures > 0) {
  console.error(`\nFAIL PS-346 rate/order slow-path guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS PS-346 rate/order slow-path guard');
