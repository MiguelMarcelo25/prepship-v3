#!/usr/bin/env tsx
/**
 * PS-502 / CP-061 — reason-contract boundary guard.
 *
 * Pins the single source of truth for the customer-safe replacement reason labels: the version,
 * the exact four codes (identical to `REPLACEMENT_REASONS`, the vocabulary the create command
 * enforces), the exact labels, their order, and totality both ways. If the create command's
 * vocabulary and this contract ever drift, this fails loudly instead of letting the Client
 * Portal render a stale or missing label.
 *
 * It also proves the endpoint is actually WIRED and reachable without an internal permission —
 * a contract function nothing serves is indistinguishable from one that does not exist.
 *
 * Offline: no database, no network. The reason-contract route is a pure read of four static
 * strings with no side effect, so this guard enables REPLACEMENTS_ENABLED only to route past the
 * default-off gate and read it back. The default-OFF behaviour of the side-effect routes is
 * proven separately and strictly by test:ps-502-route-boundary, which refuses to run flag-on.
 * Fake env is assigned before the service tree loads so an import cannot reach a real credential.
 */
process.env.VERCEL = '1';
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgres://ps502:ps502@127.0.0.1:1/ps502_reason_contract';
process.env.SUPABASE_URL = 'https://ps502-reason-contract.supabase.invalid';
process.env.SUPABASE_ANON_KEY = 'ps502-reason-contract-anon-not-real';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'ps502-reason-contract-service-not-real';
process.env.SUPABASE_JWT_SECRET = 'ps502-reason-contract-jwt-not-real';
process.env.REPLACEMENTS_ENABLED = 'true';
process.env.REPLACEMENTS_LABEL_ENABLED = 'false';

const [
  { getReplacementReasonContract, REPLACEMENT_REASON_LABELS, REPLACEMENT_REASON_CONTRACT_VERSION },
  { REPLACEMENT_REASONS },
  { default: replacementRouter },
] = await Promise.all([
  import('../src/services/replacement-reason-contract'),
  import('../src/services/replacement-create-command'),
  import('../src/routes/replacements'),
]);

let failures = 0;
function check(name: string, condition: boolean, detail?: string): void {
  if (condition) {
    console.log(`ok   ${name}`);
    return;
  }
  failures += 1;
  console.error(`FAIL ${name}${detail ? `\n     ${detail}` : ''}`);
}

// The frozen expectation, stated independently. The guard must fail if either the code set or a
// label changes, so it does NOT read its answer from the module it is checking — a label change
// has to be a deliberate edit here too, which is the whole point of a versioned contract.
const EXPECTED_VERSION = 'replacement-request-v1';
const EXPECTED: Array<{ code: string; label: string }> = [
  { code: 'damaged', label: 'Damaged' },
  { code: 'wrong_item', label: 'Wrong item' },
  { code: 'lost_in_transit', label: 'Lost in transit' },
  { code: 'other', label: 'Other' },
];

const contract = getReplacementReasonContract();

check(
  'the contract version is the frozen replacement-request-v1',
  contract.version === EXPECTED_VERSION && REPLACEMENT_REASON_CONTRACT_VERSION === EXPECTED_VERSION,
  `${contract.version} / ${REPLACEMENT_REASON_CONTRACT_VERSION}`,
);

check(
  'the contract codes are exactly REPLACEMENT_REASONS, in the same order',
  JSON.stringify(contract.reasons.map((r) => r.code)) === JSON.stringify([...REPLACEMENT_REASONS]),
  `${contract.reasons.map((r) => r.code).join(',')} vs ${[...REPLACEMENT_REASONS].join(',')}`,
);

check(
  'the contract carries exactly the four frozen code/label pairs, in order',
  JSON.stringify(contract.reasons) === JSON.stringify(EXPECTED),
  JSON.stringify(contract.reasons),
);

check(
  'every REPLACEMENT_REASONS code has a label and there are no extra labels',
  [...REPLACEMENT_REASONS].every((code) => typeof REPLACEMENT_REASON_LABELS[code] === 'string') &&
    Object.keys(REPLACEMENT_REASON_LABELS).sort().join(',') ===
      [...REPLACEMENT_REASONS].sort().join(','),
  Object.keys(REPLACEMENT_REASON_LABELS).join(','),
);

check(
  'every label is a non-empty customer-safe string distinct from its raw code',
  contract.reasons.every((r) => r.label.trim().length > 0 && r.label !== r.code),
);

// ── Wiring: the route exists, is reachable with no internal permission, and returns the contract.
const served = await replacementRouter.request('/reason-contract');
const servedBody = served.status === 200 ? await served.json() : null;
check(
  'GET /reason-contract is served (200) with no internal permission on the request',
  served.status === 200,
  `status ${served.status}`,
);
check(
  'the served body is exactly the canonical contract',
  JSON.stringify(servedBody) === JSON.stringify(contract),
  JSON.stringify(servedBody),
);

// An unknown path 404s (past the flag gate, which is open here) — so the 200 above proves the
// route is REGISTERED, not that the router answers everything the same way.
const missing = await replacementRouter.request('/no-such-replacement-route');
check(
  'an unregistered path 404s, proving /reason-contract is a real registered route',
  missing.status === 404,
  `status ${missing.status}`,
);

console.log(
  `\n${
    failures === 0
      ? 'PS-502 replacement reason-contract guard passed.'
      : `PS-502 replacement reason-contract guard FAILED with ${failures} failure(s).`
  }`,
);
if (failures > 0) process.exit(1);
