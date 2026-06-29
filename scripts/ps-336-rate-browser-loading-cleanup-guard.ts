/**
 * PS-336 guard - Rate Browser loading cleanup after browse-resolved table sync.
 *
 * Bug: Browse Rates can resolve a backend canonical best, update the Awaiting
 * table through onBestRateResolved, and then stay on "Fetching..." when a stale
 * request or a synchronous parent persist-prep error bypasses modal cleanup.
 *
 * Boundary: the backend still owns best-rate selection. This guard only pins
 * frontend request lifecycle hygiene and safe tracking of the backend apply
 * command promise.
 */
import { readFileSync } from 'node:fs';

let failures = 0;
function check(name: string, condition: boolean): void {
  if (!condition) {
    failures += 1;
    console.error(`FAIL ${name}`);
  } else {
    console.log(`ok   ${name}`);
  }
}

const modal = readFileSync('web/src/components/RateBrowserModal.tsx', 'utf8');
const ordersView = readFileSync('web/src/components/Views/OrdersView.tsx', 'utf8');
const pkg = readFileSync('package.json', 'utf8');
const finishHelper = /function finishBrowseRequest\(requestSeq: number\)(?:: void)?[\s\S]*?\r?\n  }\r?\n/.exec(modal)?.[0] ?? '';
const modalOutsideFinishHelper = finishHelper ? modal.replace(finishHelper, '') : modal;

check(
  'RateBrowserModal owns request cleanup through a sequence-gated finish helper',
  /function finishBrowseRequest\(requestSeq: number\)[\s\S]{0,300}browseSequenceRef\.current !== requestSeq[\s\S]{0,300}setPendingPids\(new Set\(\)\)[\s\S]{0,300}setBrowsing\(false\)/.test(modal),
);

check(
  'RateBrowserModal emits resolved best rates through a guarded callback helper',
  /function emitBestRateResolved\(applied: RbAppliedRate\): void[\s\S]{0,500}try \{[\s\S]{0,250}onBestRateResolved\?\.\(applied\)[\s\S]{0,250}\} catch/.test(modal) &&
    !/onBestRateResolved\(applied\)/.test(modal),
);

check(
  'RateBrowserModal clears browsing via finishBrowseRequest instead of a bare final setBrowsing(false)',
  (modal.match(/setBrowsing\(false\)/g) ?? []).length >= 1 &&
    /finishBrowseRequest\(requestSeq\)/.test(modal) &&
    !/^\s*setBrowsing\(false\);$/m.test(modalOutsideFinishHelper),
);

check(
  'OrdersView tracks browse-resolved persist through Promise.resolve().then so sync throws become settled promises',
  /trackAppliedRatePersist\([\s\S]{0,250}Promise\.resolve\(\)\s*\.then\(\(\) => persistAppliedRateForOrder\(panelOrderId/.test(ordersView),
);

check(
  'OrdersView tracks manual applied-rate persist through Promise.resolve().then so sync throws become settled promises',
  /trackAppliedRatePersist\([\s\S]{0,250}Promise\.resolve\(\)\s*\.then\(\(\) => persistAppliedRateForOrder\(panelOrderId \?\? 0/.test(ordersView),
);

check(
  'package.json exposes test:ps-336-rate-browser-loading-cleanup',
  /test:ps-336-rate-browser-loading-cleanup/.test(pkg),
);

if (failures > 0) {
  console.error(`\nFAIL PS-336 rate-browser loading cleanup guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS PS-336 rate-browser loading cleanup guard');
