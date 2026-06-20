/**
 * PS-167 — v2-apiClient shared-leaf extraction guard (safe-partial).
 *
 * The ~1.4k-line helper/type/singleton leaf of web/src/lib/v2-apiClient.ts was extracted VERBATIM
 * into web/src/lib/v2-apiClient/shared.ts. All 113 methods + the public `apiClient` object stay in
 * the barrel; the barrel re-exports the shared leaf so every existing import from this path is
 * unchanged. The full per-resource METHOD split was deliberately NOT done (12 content-asserting
 * guards + the parity engine special-case this filename — see psticketchecklist.md).
 *
 * This guard pins the invariants that keep the split behavior-preserving and guard-stable:
 *   1. shared.ts exists and is a real leaf (no import of / reference back into the barrel → no cycle).
 *   2. The barrel re-exports shared (`export * from './v2-apiClient/shared'`) and imports helpers from it.
 *   3. The barrel keeps its public surface: `export const apiClient`, `export default apiClient`,
 *      `export type V2ApiClient = typeof apiClient`.
 *   4. The external leaf symbols (HIDDEN_CLIENT_IDS, TEST_CLIENT_IDS, isDirectCarrierId,
 *      DirectCarrierRateError) are owned by shared.ts so the re-export resolves them.
 *   5. The TWO text-blob-anchored helpers (stableRateBrowseKey, parseDailyStatsSummary) remain
 *      DEFINED IN THE BARREL — moving them silently breaks recalculate-best-rate-strict
 *      ('insuranceProvider'/'insuredValue') and daily-strip-progress (/rootDto.summary/), which grep
 *      this exact file. Keep them here unless those guards are simultaneously re-anchored.
 *
 * Offline / pure: readFileSync only.
 */
import { readFileSync, existsSync } from 'node:fs';

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (!cond) { failures += 1; console.error(`FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
  else console.log(`ok   ${name}`);
}

const BARREL_PATH = 'web/src/lib/v2-apiClient.ts';
const SHARED_PATH = 'web/src/lib/v2-apiClient/shared.ts';

check('shared.ts exists', existsSync(SHARED_PATH));
const barrel = existsSync(BARREL_PATH) ? readFileSync(BARREL_PATH, 'utf8') : '';
const shared = existsSync(SHARED_PATH) ? readFileSync(SHARED_PATH, 'utf8') : '';

// ── (1) shared is a real LEAF — no edge back into the assembled barrel (would be a cycle) ──
check('shared.ts is substantial (>= 800 lines extracted)', shared.split('\n').length >= 800,
  `${shared.split('\n').length} lines`);
check('shared.ts does NOT import from the barrel (no cycle)',
  !/from ['"][^'"]*\/v2-apiClient['"]/.test(shared));
// Strip line + block comments so a doc-comment that merely mentions `apiClient.x` doesn't trip the
// leaf check. (typecheck independently guarantees no real undefined `apiClient` reference here.)
const sharedCode = shared.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
check('shared.ts does NOT reference the assembled apiClient object in code (leaf only)',
  !/\bapiClient\./.test(sharedCode));

// ── (2) barrel wires to shared (import for in-method bare-name usage + re-export for externals) ──
check("barrel re-exports shared (export * from './v2-apiClient/shared')",
  /export \* from ['"]\.\/v2-apiClient\/shared['"]/.test(barrel));
check("barrel imports helpers from './v2-apiClient/shared'",
  /from ['"]\.\/v2-apiClient\/shared['"]/.test(barrel));

// ── (3) public surface preserved (call sites + `export { apiClient } from ...` re-exporters) ──
check('barrel still declares `export const apiClient = {`', /export const apiClient = \{/.test(barrel));
check('barrel still `export default apiClient`', /export default apiClient/.test(barrel));
check('barrel still `export type V2ApiClient = typeof apiClient`',
  /export type V2ApiClient = typeof apiClient/.test(barrel));

// ── (4) external leaf symbols owned by shared so the re-export resolves them ──
for (const sym of ['HIDDEN_CLIENT_IDS', 'TEST_CLIENT_IDS']) {
  check(`shared.ts owns export const ${sym}`, new RegExp(`export const ${sym}\\b`).test(shared));
}
// PS-286: isDirectCarrierId moved to the PURE web/src/lib/direct-carrier-id leaf
// (importable without the network barrel). shared.ts re-exports it so the single
// source of truth + barrel-free reachability invariant still holds.
const DIRECT_CARRIER_ID_PATH = 'web/src/lib/direct-carrier-id.ts';
const directCarrierId = existsSync(DIRECT_CARRIER_ID_PATH) ? readFileSync(DIRECT_CARRIER_ID_PATH, 'utf8') : '';
check('direct-carrier-id.ts owns export function isDirectCarrierId',
  /export function isDirectCarrierId\b/.test(directCarrierId));
check('shared.ts re-exports isDirectCarrierId from the pure leaf',
  /isDirectCarrierId/.test(shared) && /from ['"]\.\.\/direct-carrier-id['"]/.test(shared));
check('shared.ts owns export type DirectCarrierRateError', /export type DirectCarrierRateError\b/.test(shared));

// ── (5) text-blob-anchored helpers must remain DEFINED IN THE BARREL ──
for (const fn of ['stableRateBrowseKey', 'parseDailyStatsSummary']) {
  check(`barrel still DEFINES ${fn} (text-blob guard anchor — do not move to shared)`,
    new RegExp(`^function ${fn}\\b`, 'm').test(barrel),
    'moving it silently breaks recalculate-best-rate-strict / daily-strip-progress');
  check(`shared.ts does NOT define ${fn}`, !new RegExp(`function ${fn}\\b`).test(shared));
}

console.log(failures === 0 ? '\nPASS PS-167 apiClient shared-extraction guard' : `\nFAIL PS-167 apiClient shared-extraction guard (${failures} failing)`);
process.exit(failures === 0 ? 0 : 1);
