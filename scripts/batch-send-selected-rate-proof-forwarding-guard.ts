/**
 * Guard: the backend Print-to-Queue batch-send route forwards selectedRateProof.
 *
 * Root cause of the recurring "Rate changed or expired. Re-rate this order
 * before creating the label." error on real orders:
 *
 * The side-panel Print to Queue path (mode 'queue') routes eligible orders
 * through POST /print-queue/batch-send (apiClient.startQueueSendJob). The
 * frontend builds a self-consistent backend-issued selected-rate proof and
 * places it at order.label.selectedRateProof. But the batch-send route:
 *
 *   1. Validated order.label with a Zod schema (queueSendLabelBody) that did
 *      NOT include selectedRateProof, so Hono's zValidator STRIPPED it at parse
 *      time, and
 *   2. Re-constructed order.label field-by-field with an explicit allow-list
 *      that OMITTED selectedRateProof.
 *
 * Either drop alone is fatal: the durable job -> worker -> createLabelV2({
 * ...order.label }) then received selectedRateProof: undefined, so
 * assertSelectedRateProofForLabelPurchase(undefined) threw
 * SelectedRateProofError(missing_current_fingerprint) -- the order was skipped,
 * the frontend re-rated and retried, and the freshly-built proof was stripped
 * again, looping forever.
 *
 * This guard fails unless BOTH the schema accepts selectedRateProof AND the
 * route reconstruction forwards order.label.selectedRateProof to the service.
 */
import { readFileSync } from 'node:fs';

const route = readFileSync('src/routes/print-queue.ts', 'utf8');
const packageJson = readFileSync('package.json', 'utf8');

let failures = 0;
function check(name: string, condition: boolean) {
  if (!condition) {
    failures += 1;
    console.error(`FAIL ${name}`);
  } else {
    console.log(`ok   ${name}`);
  }
}

// Isolate the queue-send label Zod schema (queueSendLabelBody) so we assert the
// field is part of the validated shape -- not merely mentioned somewhere else.
const schemaStart = route.indexOf('const queueSendLabelBody = z.object({');
const schemaEnd = schemaStart >= 0 ? route.indexOf('});', schemaStart) : -1;
const schemaBlock = schemaStart >= 0 && schemaEnd > schemaStart
  ? route.slice(schemaStart, schemaEnd)
  : '';

check('found queueSendLabelBody schema block', schemaBlock.length > 0);
check(
  'batch-send label schema accepts a selectedRateProof field (not stripped by zValidator)',
  /selectedRateProof:\s*z\b/.test(schemaBlock),
);

// Isolate the /batch-send handler's per-order reconstruction so we assert the
// field is forwarded into the startQueueSendJob input, not just parsed.
const handlerStart = route.indexOf("app.post('/batch-send'");
const handlerEnd = handlerStart >= 0 ? route.indexOf('return c.json({ job_id', handlerStart) : -1;
const handlerBlock = handlerStart >= 0 && handlerEnd > handlerStart
  ? route.slice(handlerStart, handlerEnd)
  : '';

check('found /batch-send handler block', handlerBlock.length > 0);
check(
  'batch-send reconstruction forwards order.label.selectedRateProof to the queue job',
  /selectedRateProof:\s*order\.label\.selectedRateProof/.test(handlerBlock),
);

check(
  'package.json registers the batch-send proof-forwarding guard',
  packageJson.includes('"test:batch-send-proof-forwarding": "tsx scripts/batch-send-selected-rate-proof-forwarding-guard.ts"'),
);

if (failures > 0) {
  console.error(`\nFAIL batch-send selected-rate proof forwarding guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS batch-send selected-rate proof forwarding guard');
