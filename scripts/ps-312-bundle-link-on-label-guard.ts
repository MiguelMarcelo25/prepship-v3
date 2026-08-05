import { readFileSync } from 'node:fs';

// PS-312 — combined-shipment KEYSTONE (link-on-label) safety guard.
//
// When a bundle PRIMARY's ONE label is bought, createLabelV2 stamps the shared label
// facts onto the bundle so its children resolve to the primary's tracking (not
// "Shipment sync error") and the downstream bill/deduct/confirm policies can fire.
// This guard pins the SAFETY SHAPE of that wiring so a refactor can't make it unsafe:
//   • behind the default-OFF BUNDLE_LINK_ON_LABEL flag (OFF -> byte-identical),
//   • runs AFTER the committed ship txn (never inside the locked persist txn),
//   • best-effort timer.background with a .catch (a stamp miss never undoes the buy),
//   • only stamps a PRIMARY, via getBundleForOrder + the additive linkBundleShipment,
//   • linkBundleShipment writes ONLY the shipment_bundles sidecar (never shipments /
//     shipped order rows) and never regresses a later lifecycle state.
// It buys no postage. Activation is DJ's Render canary (see the env.ts comment).

let failures = 0;
function check(name: string, cond: boolean) {
  if (!cond) {
    failures += 1;
    console.error(`FAIL ${name}`);
  } else {
    console.log(`ok   ${name}`);
  }
}

const env = readFileSync('src/lib/env.ts', 'utf8');
const labels = readFileSync('src/services/labels.ts', 'utf8');
const createBundle = readFileSync('src/services/shipment-bundles/create-bundle.ts', 'utf8');

// (1) the flag exists and is default-OFF (OFF => byte-identical, no query, no write)
check(
  'BUNDLE_LINK_ON_LABEL is a default-OFF booleanFlag in src/lib/env.ts',
  /BUNDLE_LINK_ON_LABEL:\s*booleanFlag\(false\)/.test(env),
);

// (2) the keystone is gated on the flag
const gateIdx = labels.indexOf('if (env.BUNDLE_LINK_ON_LABEL)');
check('createLabelV2 gates the bundle stamp on env.BUNDLE_LINK_ON_LABEL', gateIdx !== -1);

// (3) it runs AFTER the committed ship txn (not inside the locked persist transaction)
// Repointed 2026-08-05: PS-423 moved the ship transaction under
// consumeFulfillmentOperation, so `const localShipmentId = await db.transaction` is gone.
// Anchor on the point the transaction has COMMITTED and its shipment id is available --
// which is exactly what "outside the locked txn" means for this check.
const txnIdx = labels.indexOf('const localShipmentId = Number(consumed.localResult');
check('the bundle stamp runs AFTER the committed ship txn (outside the locked txn)', txnIdx !== -1 && gateIdx > txnIdx);

// (4) best-effort: the link+deduct task runs in a timer.background with a .catch handler — a stamp or
//     deduct miss is swallowed to a console.warn and never undoes the committed buy.
check(
  'the stamp + chained deduct run in a best-effort timer.background with a .catch',
  /timer\.background\(\s*['"]bundle link-on-label['"]/.test(labels) &&
    /\.catch\(\(err\) => console\.warn\(\s*['"]\[labels\] bundle link-on-label/.test(labels),
);

// (5) it only stamps a PRIMARY, via getBundleForOrder + linkBundleShipment
check(
  'the stamp only fires for the bundle PRIMARY',
  /role\s*!==\s*['"]primary['"]/.test(labels) || /role\s*===\s*['"]primary['"]/.test(labels),
);
check(
  'the keystone uses getBundleForOrder(order.id) + linkBundleShipment(...)',
  /getBundleForOrder\(order\.id\)/.test(labels) && /linkBundleShipment\(/.test(labels),
);

// (6) lockdown-safe: linkBundleShipment writes ONLY the additive shipment_bundles sidecar (never
//     shipments / shipped order rows) and never regresses a later lifecycle state.
check(
  'linkBundleShipment updates shipmentBundles (additive sidecar), not shipments',
  /\.update\(shipmentBundles\)/.test(createBundle) && !/\.update\(shipments\)/.test(createBundle),
);
check(
  'linkBundleShipment never regresses a later lifecycle state (only draft/labeled advances)',
  /current === ['"]draft['"] \|\| current === ['"]labeled['"]/.test(createBundle),
);

// (7) the deduct-once fan-out is CHAINED after the link stamp — never in the racy
//     recordFulfillmentDeductions background task. deductBundleMembersOnce must appear AFTER the
//     linkBundleShipment call (so the bundle is already 'labeled' when it runs), gated on
//     BUNDLE_DEDUCT_ONCE; and recordFulfillmentDeductions must NOT call it (that task races the stamp).
const linkCallIdx = labels.indexOf('linkBundleShipment(');
const deductCallIdx = labels.indexOf('deductBundleMembersOnce(');
check(
  'the bundle deduct-once is CHAINED after the link stamp (no race), gated on BUNDLE_DEDUCT_ONCE',
  deductCallIdx !== -1 && linkCallIdx !== -1 && deductCallIdx > linkCallIdx && /env\.BUNDLE_DEDUCT_ONCE/.test(labels),
);
// Repointed 2026-08-05. `recordFulfillmentDeductions` no longer exists ANYWHERE in src/ --
// PS-424's lifecycle command absorbed it -- so this slice ran from -1 and produced an
// empty string. Note the guard caught its own broken anchor: without the
// `recordFn.length > 0` clause, `!''.includes(...)` would have passed VACUOUSLY and this
// would have sat green while asserting nothing. Worth keeping that pattern.
//
// The property is unchanged: the bundle member fan-out must not run anywhere it could
// race the stamp. State it positionally against the same committed-transaction anchor
// used above -- the fan-out must come AFTER the ship txn commits, and after the stamp it
// is chained to, so it can never observe a half-linked bundle.
const fanoutIdx = labels.indexOf('await deductBundleMembersOnce(');
const stampIdx = labels.indexOf('await linkBundleShipment(');
check(
  'the bundle member fan-out cannot race the stamp (it runs after the committed txn, chained after the stamp)',
  fanoutIdx !== -1 && stampIdx !== -1 && txnIdx !== -1 &&
    stampIdx > txnIdx && fanoutIdx > stampIdx,
);
check(
  'the fan-out stays behind its own default-OFF flag',
  /if \(env\.BUNDLE_DEDUCT_ONCE\) \{[\s\S]{0,200}?await deductBundleMembersOnce\(/.test(labels),
);

if (failures > 0) {
  console.error(`\nFAIL PS-312 bundle link-on-label keystone guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-312 bundle link-on-label keystone guard');
