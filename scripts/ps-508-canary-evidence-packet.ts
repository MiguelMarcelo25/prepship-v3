/**
 * PS-508 — the canary evidence packet. Schema version 3.
 *
 * v1 was REFUTED as an acceptance mechanism by the Hermes round-3 audit: it could report
 * zeroMismatch=HOLDS on zero rows, exited 0 on NOT-YET-COMPARED, self-validated legacy rows,
 * carried a handwritten Portal mirror weaker than the real predicate, used noncanonical cents,
 * could double-count a mismatching shipment, and its read-only flag was a string where the
 * postgres client expects a boolean — so server-side read-only was never proven. v2 closes
 * each of those by construction:
 *
 *  - READ-ONLY, PROVEN: `default_transaction_read_only: true` (boolean), then the session
 *    asserts `show default_transaction_read_only` = on and aborts otherwise. The checked-in
 *    smoke additionally proves a deliberate write FAILS under this connection.
 *  - PORTAL PREDICATE EXECUTED AS SQL: the acceptance test runs in Postgres itself, embedded
 *    verbatim from client-portal-prepship@d447d89 (money-validity + ps-508 + ps-509 lanes;
 *    ps-437 deliberately absent per the P4 lane-boundary enforcement). jsonb_typeof semantics
 *    therefore match the real Portal exactly — a numeric-string tuple is rejected here just
 *    as the Portal rejects it, even though Billing's reader would coerce it.
 *  - BOTH DIRECTIONS: a frozen row the Portal rejects is a mismatch (portal-rejects-frozen);
 *    a held row the Portal displays is a mismatch (portal-displays-held); a frozen row the
 *    Portal displays must agree to the cent.
 *  - CANONICAL CENTS: roundMoney (src/lib/money.ts) — ties away from zero — not Math.round.
 *  - LEGACY ROWS ARE OBSERVED, NEVER SELF-VALIDATED: verdict OBSERVED-LEGACY; the existing
 *    line is recorded, not treated as its own expectation.
 *  - EACH SHIPMENT COUNTS AT MOST ONCE in mismatchRows, whatever the number of defects.
 *  - NO FALSE GREEN: exit is nonzero unless the packet PASSES. INCOMPLETE (zero eligible
 *    rows, NOT-YET-COMPARED rows, missing cohorts, missing operator identity in activation
 *    mode) is a FAILURE exit, not a success.
 *
 * Modes:
 *  --mode inventory   (default) read-only survey; still exits nonzero on VIOLATED/INCOMPLETE.
 *  --mode activation  the acceptance gate. Additionally requires: nonempty valid --boundary;
 *                     operator readbacks (--env-clients-readback, --env-boundary-readback,
 *                     --readback-at) matching the inputs; deployed identities (--api-sha,
 *                     --worker-sha, --portal-sha) all 40-hex; PS508_PORTAL_TOKEN for the
 *                     GitHub-API Portal verification; every
 *                     REQUIRED cohort represented or explicitly waived via
 *                     --waive "<cohort>:<reason>" (repeatable, recorded in the packet).
 */
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { decideWorkerIdentity } from './ps-508-canary-worker-identity';
import {
  PORTAL_OFFICIAL_API,
  verifyPortalViaApi,
  worktreeIdentity,
} from './ps-508-canary-portal-identity';
import postgres from 'postgres';
import {
  decideBillableShippingMoney,
  type BillableShippingMoneyDecision,
} from '../src/services/customer-shipping-money-billable-decision';
import {
  classifyCustomerShippingMoney,
} from '../src/services/customer-shipping-money-classification';
import {
  resolveCutoverBoundary,
  isAfterCutover,
} from '../src/services/customer-shipping-money-cutover-gate';
import {
  ACCEPTED_CUSTOMER_SHIPPING_MONEY_POLICY_VERSIONS,
} from '../src/services/customer-shipping-money-snapshot';
import { roundMoney } from '../src/lib/money';

const PACKET_SCHEMA_VERSION = 3;
/**
 * The EXACT Portal commit this file's embedded SQL was copied from (round-5: full SHA, never a
 * prefix — the seven-char prefix rule guaranteed a false refusal of any descendant head).
 * See verifyPortalViaApi below for how the deployed Portal SHA is checked against this mirror.
 */
const PORTAL_MIRROR_SHA = 'cd486cc982870b190692e41bd8fbe35944f1e5ec';
const PORTAL_PREDICATE_PATH = 'src/lib/client-portal/customer-shipping-rate.ts';
const PORTAL_MIRROR_SOURCE = 'client-portal-prepship@' + PORTAL_MIRROR_SHA.slice(0, 7)
  + ' ' + PORTAL_PREDICATE_PATH;
/** Activation refuses any --api that is not exactly the approved production origin. */
const PRODUCTION_API_ORIGIN = 'https://prepshipv4-api-l5xc.onrender.com';
/**
 * Round-7: Portal verification uses the GitHub REST API over HTTPS, NOT a git fetch. The
 * round-6 git-fetch approach was refuted: git rewrites command-line URLs through
 * url.<base>.insteadOf configuration in the operator-supplied clone, and GIT_NO_REPLACE_OBJECTS
 * does not disable that rewriting — a doctored clone could redirect the "hardcoded" remote to a
 * local repository and publish a forged descendant. The REST API cannot be redirected by any
 * git configuration: it is a plain fetch() to api.github.com with redirect:'error'. What is
 * machine-verified: the attested SHA EXISTS on GitHub (published), the mirror commit is an
 * ancestor of it (compare), and the predicate file is byte-identical at both SHAs (contents).
 * Deployed-ness of the attested SHA remains an OPERATOR ATTESTATION — no live Portal version
 * endpoint exists to read.
 */
/**
 * PORTAL_OFFICIAL_API (the IMMUTABLE GitHub API base), verifyPortalViaApi, and worktreeIdentity
 * are the executed-source and Portal-provenance OWNERS, extracted to ./ps-508-canary-portal-identity
 * (Hermes round-8). The activation path below passes PORTAL_OFFICIAL_API — never an env value — as
 * the apiBase, and gates on a clean worktree via worktreeIdentity. The smoke imports the SAME owner
 * module and exercises it directly, so the tested code is the code activation runs.
 */

function arg(name: string): string | undefined {
  const i = process.argv.indexOf('--' + name);
  return i === -1 ? undefined : process.argv[i + 1];
}
function args(name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < process.argv.length; i += 1) {
    const next = process.argv[i + 1];
    if (process.argv[i] === '--' + name && next) out.push(next);
  }
  return out;
}

const HEX40 = /^[0-9a-f]{40}$/;
const REQUIRED_COHORTS = [
  { name: 'ordinary_purchase', derivable: true },
  { name: 'sync_ingress', derivable: true },
  { name: 'house_captured_rate', derivable: true },
  { name: 'multi_shipment', derivable: true },
  { name: 'voided', derivable: true },
  { name: 'return_isolation', derivable: true },
  { name: 'external_fulfillment_exclusion', derivable: true },
  // Not derivable from shipment rows alone; the operator either finds a pilot row and tags it
  // or waives with a recorded reason. Silent zeros are not accepted, and derivable cohorts
  // are NOT waivable at all (round-4 audit).
  { name: 'insurance_adjusted_final_cost', derivable: false },
  { name: 'markup_changed_after_purchase', derivable: false },
  { name: 'direct_carrier_purchase', derivable: false },
] as const;

const DB_URL = process.env.PS508_PACKET_DATABASE_URL;
const MODE = (arg('mode') ?? 'inventory') as 'inventory' | 'activation';
const CLIENT = Number(arg('client'));
const BOUNDARY_RAW = arg('boundary') ?? '';
const FROM = arg('from');
const TO = arg('to');
const API = arg('api');
const OUT = arg('out');
const WAIVERS = new Map(args('waive').map((w) => {
  const idx = w.indexOf(':');
  return [w.slice(0, idx), w.slice(idx + 1)] as const;
}));

const problems: string[] = [];
if (!DB_URL) problems.push('PS508_PACKET_DATABASE_URL is not set');
if (!Number.isSafeInteger(CLIENT) || CLIENT <= 0) problems.push('--client must be a positive integer');
if (!FROM || !TO) problems.push('--from and --to are required');
if (!['inventory', 'activation'].includes(MODE)) problems.push('--mode must be inventory|activation');
const boundary = resolveCutoverBoundary(BOUNDARY_RAW);
if (boundary.kind === 'invalid') {
  problems.push('--boundary is unparseable ("' + BOUNDARY_RAW + '") — refusing to build a packet around a typo');
}
const operator = {
  envClientsReadback: arg('env-clients-readback') ?? null,
  envBoundaryReadback: arg('env-boundary-readback') ?? null,
  readbackAtUtc: arg('readback-at') ?? null,
  apiSha: arg('api-sha') ?? null,
  workerSha: arg('worker-sha') ?? null,
  portalSha: arg('portal-sha') ?? null,
  // Round-5: evidence run URLs are recorded as OPERATOR ATTESTATIONS, not machine-verified
  // facts — the packet does not call the CI API. Anything stronger must come from the audit.
  ciRunUrl: arg('ci-run-url') ?? null,
  pg17RunUrl: arg('pg17-run-url') ?? null,
  portalCiRunUrl: arg('portal-ci-run-url') ?? null,
  waiveApprovedBy: arg('waive-approved-by') ?? null,
  waiveEvidence: arg('waive-evidence') ?? null,
};
if (MODE === 'activation') {
  // Round-4 audit: identities are BOUND, not self-attested strings — full 40-hex SHAs only,
  // API and worker on ONE SHA, a fresh readback timestamp, the exact-SHA evidence URLs, and a
  // live /health that must agree with the attested API SHA (verified after fetch, below).
  if (boundary.kind !== 'at') problems.push('activation mode requires a nonempty valid --boundary');
  if (!operator.envClientsReadback) problems.push('activation requires --env-clients-readback (direct Render readback)');
  if (!operator.envBoundaryReadback) problems.push('activation requires --env-boundary-readback');
  if (operator.envClientsReadback && operator.envClientsReadback.trim() !== String(CLIENT)) {
    problems.push('env-clients-readback ("' + operator.envClientsReadback + '") does not equal the pilot client ' + CLIENT);
  }
  if (operator.envBoundaryReadback && operator.envBoundaryReadback.trim() !== BOUNDARY_RAW.trim()) {
    problems.push('env-boundary-readback does not equal --boundary');
  }
  if (!operator.readbackAtUtc || Number.isNaN(Date.parse(operator.readbackAtUtc))) {
    problems.push('activation requires --readback-at as a valid ISO timestamp');
  } else {
    const delta = Date.now() - Date.parse(operator.readbackAtUtc);
    if (delta > 24 * 3600_000) problems.push('--readback-at is older than 24h — re-read the Render values');
    if (delta < -5 * 60_000) problems.push('--readback-at is in the FUTURE — a readback cannot postdate the run');
  }
  // Round-5: pre-boundary legacy rows are OUTSIDE the acceptance denominator by construction —
  // the activation window must start at or after the boundary, so no OBSERVED-LEGACY row can
  // sit uncompared inside an accepted packet.
  if (boundary.kind === 'at' && FROM && Date.parse(FROM) < boundary.at.getTime()) {
    problems.push('activation window must start AT or AFTER the boundary ('
      + boundary.at.toISOString() + ') — pre-boundary legacy rows are not acceptance evidence');
  }
  for (const [flag, v] of [['api-sha', operator.apiSha], ['worker-sha', operator.workerSha], ['portal-sha', operator.portalSha]] as const) {
    if (!v || !HEX40.test(v)) problems.push('activation requires --' + flag + ' as a FULL 40-hex git SHA (got "' + (v ?? '') + '")');
  }
  if (operator.apiSha && operator.workerSha && operator.apiSha !== operator.workerSha) {
    problems.push('api-sha and worker-sha differ — deploy both to one SHA before the canary');
  }
  if (!process.env.PS508_PORTAL_TOKEN) {
    problems.push('activation requires PS508_PORTAL_TOKEN (a GitHub token with read access to the '
      + 'Portal repo — verification is via the REST API, not a git clone, so no git configuration '
      + 'can redirect it)');
  }
  if (!API) {
    problems.push('activation requires --api (live /health is part of the identity binding)');
  }
  // The origin match is verified in main() alongside the other identity gates (so all identity
  // failures accumulate and report together instead of fail-fast).
  if (WAIVERS.size > 0) {
    if (!operator.waiveApprovedBy || !operator.waiveApprovedBy.trim()) {
      problems.push('activation with waivers requires --waive-approved-by (the accountable operator)');
    }
    if (!operator.waiveEvidence || !operator.waiveEvidence.trim()) {
      problems.push('activation with waivers requires --waive-evidence (a reviewable reference)');
    }
  }
  // Portal identity is verified via the GitHub REST API in main() (round-7) — see
  // verifyPortalViaApi. It cannot live in this sync validation phase because it is async, and it
  // no longer touches git at all, so nothing in the operator's environment can redirect it.
  for (const [flag, v] of [['ci-run-url', operator.ciRunUrl], ['pg17-run-url', operator.pg17RunUrl], ['portal-ci-run-url', operator.portalCiRunUrl]] as const) {
    if (!v) problems.push('activation requires --' + flag + ' (the exact-SHA evidence run)');
  }
}
// Waivers are restricted to explicitly waivable (non-derivable) cohorts, with real reasons.
for (const [name, reason] of WAIVERS) {
  const cohort = REQUIRED_COHORTS.find((c) => c.name === name);
  if (!cohort) problems.push('--waive names an unknown cohort "' + name + '"');
  else if (cohort.derivable) problems.push('--waive "' + name + '" refused: derivable cohorts must be REPRESENTED, never waived');
  if (!reason || !reason.trim()) problems.push('--waive "' + name + '" requires a nonblank reason');
}
if (problems.length > 0) {
  for (const p of problems) console.error('FAIL: ' + p);
  process.exit(1);
}
// Narrowed past the validation above; TypeScript cannot see through process.exit.
const FROM_ISO = FROM as string;
const TO_ISO = TO as string;

const accept = ACCEPTED_CUSTOMER_SHIPPING_MONEY_POLICY_VERSIONS;
/** Canonical dollars -> integer cents through the same rounding Billing persists with. */
const cents = (v: unknown): number | null => {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  if (!Number.isFinite(n)) return null;
  const r = roundMoney(n);
  return Math.round(r * 100);
};

/**
 * The Portal outbound predicate, embedded VERBATIM (table alias s) from PORTAL_MIRROR_SOURCE.
 * Executed inside Postgres so the type semantics are the database's own, not a JS paraphrase.
 * ps-437 is absent from this union on purpose — the P4 lane-boundary enforcement.
 */
const PORTAL_VALID_MONEY_SQL = `
  coalesce(s.selected_rate_json, '{}'::jsonb) ?& array[
    'selectedRateCost','cShippingRateAmount','shippingMarginAmount','shippingMarginPct',
    'customerRateSource','rateCostSource','customerShippingMoneyPolicyVersion'
  ]::text[]
  and jsonb_typeof(s.selected_rate_json->'selectedRateCost') = 'number'
  and jsonb_typeof(s.selected_rate_json->'cShippingRateAmount') = 'number'
  and jsonb_typeof(s.selected_rate_json->'shippingMarginAmount') = 'number'
  and jsonb_typeof(s.selected_rate_json->'shippingMarginPct') in ('number', 'null')
  and (s.selected_rate_json->>'selectedRateCost')::numeric > 0
  and (s.selected_rate_json->>'cShippingRateAmount')::numeric > 0
  and round(
    (s.selected_rate_json->>'cShippingRateAmount')::numeric
      - (s.selected_rate_json->>'selectedRateCost')::numeric, 2
  ) = round((s.selected_rate_json->>'shippingMarginAmount')::numeric, 2)`;
const PORTAL_OUTBOUND_ACCEPTS_SQL = `
  ((${PORTAL_VALID_MONEY_SQL})
    and s.selected_rate_json->>'customerRateSource' in (
      'realized_customer_shipping_rate','hugrab_shipping_rate_override','house_next_best_customer_rate')
    and s.selected_rate_json->>'rateCostSource' = 'label_final_cost'
    and s.selected_rate_json->>'customerShippingMoneyPolicyVersion' = 'ps-508-v1'
    and jsonb_typeof(s.selected_rate_json->'billingDescriptionSuffix') = 'string'
    and not (coalesce(s.selected_rate_json, '{}'::jsonb) ? 'customerShippingMoneyCaptureSource'))
  or ((${PORTAL_VALID_MONEY_SQL})
    and s.selected_rate_json->>'customerRateSource' in (
      'carrier_markup_customer_shipping_rate','hugrab_shipping_rate_override')
    and s.selected_rate_json->>'rateCostSource' = 'shipstation_sync_receipt_cost'
    and s.selected_rate_json->>'customerShippingMoneyPolicyVersion' = 'ps-509-v1'
    and jsonb_typeof(s.selected_rate_json->'billingDescriptionSuffix') = 'string'
    and coalesce(s.selected_rate_json, '{}'::jsonb) ? 'customerShippingMoneyCaptureSource'
    and s.selected_rate_json->>'customerShippingMoneyCaptureSource' = 'shipstation_sync_ingestion')`;


async function main(): Promise<void> {
  const sql = postgres(DB_URL as string, {
    max: 1,
    prepare: false,
    onnotice: () => {},
    // BOOLEAN, not the string 'on' — the round-3 audit caught v1 passing a string, which the
    // client's types reject and which left server-side read-only unproven.
    connection: { default_transaction_read_only: true },
  });

  // Prove the session is what we claim before touching anything else.
  const [ro] = await sql.unsafe('show default_transaction_read_only');
  if ((ro as Record<string, string>).default_transaction_read_only !== 'on') {
    console.error('FAIL: session is NOT read-only (default_transaction_read_only='
      + (ro as Record<string, string>).default_transaction_read_only + '); refusing to run.');
    process.exit(1);
  }

  let apiHealth: Record<string, unknown> | null = null;
  if (API) {
    try {
      const res = await fetch(API.replace(/\/$/, '') + '/health', {
        redirect: 'error',
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) apiHealth = { error: 'HTTP ' + res.status };
      else apiHealth = (await res.json()) as Record<string, unknown>;
    } catch (error) {
      apiHealth = { error: String(error).slice(0, 120) };
    }
  }
  let toolGitSha: string | null = null;
  try {
    // Reads THIS repo's HEAD (not operator-supplied); argv-array and replacement objects
    // disabled for consistency, though rev-parse HEAD is not influenced by either.
    toolGitSha = execFileSync('git', ['rev-parse', 'HEAD'],
      { encoding: 'utf8', env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1' } }).trim();
  } catch { /* packaged run */ }
  // Inventory mode: when both --api and --api-sha are supplied, a health/SHA disagreement is a
  // recorded failure (the run cannot silently carry a wrong identity even outside activation).
  const healthSha = (apiHealth as { runtime?: { commitSha?: string } } | null)?.runtime?.commitSha ?? null;
  const inventoryHealthFailures: string[] = [];
  if (MODE === 'inventory' && API && operator.apiSha && healthSha !== operator.apiSha) {
    inventoryHealthFailures.push('/health commitSha (' + String(healthSha)
      + ') does not equal --api-sha ' + operator.apiSha);
  }
  if (MODE === 'activation') {
    // Round-7: the identity checks ACCUMULATE (they were fail-fast, which hid later gate
    // failures — e.g. a wrong --api origin aborted before the async Portal check could run).
    // Every failed gate is reported, then the run exits nonzero.
    const idFailures: string[] = [];
    // The --api URL must be exactly the approved production origin (moved here from the sync
    // phase so it accumulates with the other identity gates rather than fail-fast).
    let origin = '';
    try { origin = API ? new URL(API).origin : ''; } catch { /* below */ }
    if (origin !== PRODUCTION_API_ORIGIN) {
      idFailures.push('activation requires --api at the approved production origin '
        + PRODUCTION_API_ORIGIN + ' (got "' + (origin || API) + '") — a local or arbitrary '
        + 'endpoint cannot impersonate the deployed API');
    }
    // The tool must BE the reviewed code: its own git SHA must exist and equal the attested
    // API deployment SHA, AND the worktree must be clean — rev-parse HEAD alone reports the
    // committed SHA even with uncommitted edits (round-8), so a dirty tree could run modified
    // code while attesting the reviewed commit.
    if (!toolGitSha || !HEX40.test(toolGitSha)) {
      idFailures.push('activation requires the tool to run from a git checkout (toolGitSha unavailable)');
    } else if (toolGitSha !== operator.apiSha) {
      idFailures.push('toolGitSha ' + toolGitSha + ' != attested --api-sha ' + operator.apiSha
        + ' — run the packet from the exact deployed SHA');
    }
    let porcelain = 'GIT-STATUS-UNAVAILABLE';
    try {
      porcelain = execFileSync('git', ['status', '--porcelain'],
        { encoding: 'utf8', env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1' } });
    } catch { /* handled below */ }
    const wt = porcelain === 'GIT-STATUS-UNAVAILABLE' ? { clean: false, dirtyPaths: ['<git status unavailable>'] } : worktreeIdentity(porcelain);
    if (!wt.clean) {
      idFailures.push('activation requires a CLEAN worktree — the executed code must be the '
        + 'reviewed commit, not a modified tree. Uncommitted: ' + wt.dirtyPaths.slice(0, 5).join(', '));
    }
    // Live health must corroborate the attested identity.
    if (!healthSha || healthSha !== operator.apiSha) {
      idFailures.push('/health commitSha (' + String(healthSha) + ') does not equal --api-sha '
        + operator.apiSha + ' — the deployed API is not the attested SHA');
    }
    // The worker decision is a pure, separately-tested owner: one canonical scheduler snapshot
    // only, service === 'worker', full-SHA equality, RECENT heartbeat, ambiguity refused.
    const workerRows = (await sql.unsafe(
      "select key, value from settings where key like 'worker.status.snapshot%'",
    )) as unknown as Array<{ key: string; value: unknown }>;
    const workerDecision = decideWorkerIdentity(workerRows, operator.apiSha as string, Date.now());
    if (!workerDecision.ok) idFailures.push('worker identity: ' + workerDecision.reason);
    // Portal identity via the GitHub REST API — unspoofable by git configuration.
    const portalCheck = await verifyPortalViaApi({
      portalSha: operator.portalSha as string,
      token: process.env.PS508_PORTAL_TOKEN as string,
      apiBase: PORTAL_OFFICIAL_API,
      mirrorSha: PORTAL_MIRROR_SHA,
      predicatePath: PORTAL_PREDICATE_PATH,
    });
    if (!portalCheck.ok) idFailures.push('portal identity: ' + portalCheck.reason);

    if (idFailures.length > 0) {
      for (const f of idFailures) console.error('FAIL: ' + f);
      process.exit(1);
    }
  }

  const rows = (await sql.unsafe(`
    select s.id as shipment_id, s.order_id, s.client_id, s.ship_date, s.voided, s.is_return,
           s.source, s.selected_rate_json,
           (coalesce(s.is_return, false) = false and (${PORTAL_OUTBOUND_ACCEPTS_SQL})) as portal_accepts,
           case when coalesce(s.is_return, false) = false and (${PORTAL_OUTBOUND_ACCEPTS_SQL})
                then (s.selected_rate_json->>'cShippingRateAmount')::numeric end as portal_amount,
           (select count(*) from shipments s2
             where s2.order_id = s.order_id and coalesce(s2.voided, false) = false
               and coalesce(s2.is_return, false) = false) as order_shipment_count,
           o.order_number, o.externally_shipped,
           coalesce(o.raw->>'externallyFulfilled', 'false') = 'true' as externally_fulfilled
    from shipments s
    join orders o on o.id = s.order_id
    where s.client_id = $1 and s.ship_date >= $2 and s.ship_date < $3
    order by s.id
  `, [CLIENT, FROM_ISO, TO_ISO])) as unknown as Array<Record<string, unknown>>;

  const billed = (await sql.unsafe(`
    select shipment_id, line_type, description, unit_cost, total_cost, invoiced
    from billing_line_items
    where client_id = $1 and line_type in ('shipping', 'shipping_missing') and shipment_id is not null
  `, [CLIENT])) as unknown as Array<Record<string, unknown>>;
  const billedByShipment = new Map<number, Array<Record<string, unknown>>>();
  for (const b of billed) {
    const k = Number(b.shipment_id);
    if (!billedByShipment.has(k)) billedByShipment.set(k, []);
    billedByShipment.get(k)!.push(b);
  }

  const population: Array<Record<string, unknown>> = [];
  const shadow: Array<Record<string, unknown>> = [];
  const counts = {
    totalCandidateShipments: rows.length,
    eligibleShipments: 0,
    excludedReturns: 0,
    excludedVoids: 0,
    excludedExternalFulfillment: 0,
    preBoundaryLegacyRows: 0,
    postBoundaryValidFrozenRows: 0,
    postBoundaryMissingRows: 0,
    malformedRows: 0,
    unknownVersionRows: 0,
    undatedRows: 0,
    observedLegacyRows: 0,
    notYetComparedRows: 0,
    mismatchShipments: 0, // each shipment counted AT MOST once
  };
  const cohorts: Record<string, number> = {};
  const tag = (name: string) => { cohorts[name] = (cohorts[name] ?? 0) + 1; };
  /** orderId -> count of cleanly-compared frozen shipments (the K9 evidence grain). */
  const cleanFrozenByOrder = new Map<number, number>();

  for (const r of rows) {
    const shipDate = r.ship_date as Date | null;
    const excluded = Boolean(r.voided) ? 'voided'
      : Boolean(r.is_return) ? 'return'
      : Boolean(r.externally_shipped) || Boolean(r.externally_fulfilled) ? 'external_fulfillment'
      : null;
    if (excluded === 'return') counts.excludedReturns += 1;
    if (excluded === 'voided') counts.excludedVoids += 1;
    if (excluded === 'external_fulfillment') counts.excludedExternalFulfillment += 1;
    if (excluded) {
      // Round-5: an exclusion row proves its cohort only by BEHAVING excluded — no billed
      // outbound shipping money, no duplicate shipping lines. A flagged row that still carries
      // billed shipping is a mismatch, not cohort representation.
      const exLines = billedByShipment.get(Number(r.shipment_id)) ?? [];
      const exDefects: string[] = [];
      // Round-6: an excluded row proves exclusion only with ZERO shipping-domain lines of any
      // type or sign (a zero, negative, or shipping_missing line is still shipping-domain
      // activity on a row that must have none), and no Portal-projected outbound money.
      for (const l of exLines) {
        exDefects.push('excluded-row-carries-shipping-domain-line (' + String(l.line_type) + ' ' + String(l.total_cost) + ')');
      }
      if (excluded !== 'return' && cents(r.portal_amount) != null) {
        exDefects.push('excluded-row-portal-money (' + String(r.portal_amount) + ')');
      }
      if (exDefects.length > 0) {
        counts.mismatchShipments += 1;
        shadow.push({ shipmentId: r.shipment_id, verdict: 'MISMATCH', expected: 'excluded:' + excluded, detail: exDefects });
      } else {
        if (excluded === 'return') tag('return_isolation');
        if (excluded === 'voided') tag('voided');
        if (excluded === 'external_fulfillment') tag('external_fulfillment_exclusion');
      }
    }

    const j = (r.selected_rate_json ?? null) as Record<string, unknown> | null;
    const classification = classifyCustomerShippingMoney(j);
    const after = isAfterCutover(boundary, shipDate);
    if (shipDate == null) counts.undatedRows += 1;

    let decision: BillableShippingMoneyDecision | null = null;
    if (!excluded) {
      counts.eligibleShipments += 1;
      decision = decideBillableShippingMoney({
        selectedRateJson: j, accept, afterCutover: after,
        // Legacy expectations are NEVER computed here (mutable-config math belongs to the
        // regeneration); legacy rows are OBSERVED, not validated. Sentinel never surfaces.
        recompute: () => ({ amount: Number.NaN, descriptionSuffix: ' legacy' }),
      });
      if (decision.source === 'frozen' && after) counts.postBoundaryValidFrozenRows += 1;
      if (decision.source === 'review') {
        if (classification.kind === 'legacy_absent') counts.postBoundaryMissingRows += 1;
        else if (classification.kind === 'unknown_version') counts.unknownVersionRows += 1;
        else counts.malformedRows += 1;
      }
      if (decision.source === 'legacy_recompute') counts.preBoundaryLegacyRows += 1;
      // Cohort tags for ordinary/sync/house/multi are assigned ONLY after a row proves itself:
      // valid frozen decision AND a MATCH comparison (round-4: a malformed tuple must never
      // count as cohort representation). See the comparison block below.
    }

    const portalAmountCents = cents(r.portal_amount);
    population.push({
      shipmentId: r.shipment_id, orderId: r.order_id, orderNumber: r.order_number,
      shipDate, source: r.source ?? null, excluded,
      policyVersion: j?.customerShippingMoneyPolicyVersion ?? null,
      tupleClassification: classification.kind, afterCutover: after,
      frozenAmountCents: decision?.source === 'frozen' ? cents(decision.value.amount) : null,
      portalAcceptsSql: Boolean(r.portal_accepts), portalAmountCents,
      expectedDisposition: excluded ?? (decision?.source ?? 'n/a'),
      reviewReason: decision?.source === 'review' ? decision.reason : null,
    });

    if (excluded || !decision) continue;
    const defects: string[] = [];
    const lines = billedByShipment.get(Number(r.shipment_id)) ?? [];

    if (decision.source === 'legacy_recompute') {
      // OBSERVED, never self-validated (round-3 correction 5).
      counts.observedLegacyRows += 1;
      if (portalAmountCents != null) defects.push('portal-displays-money-on-a-legacy-row');
      shadow.push({
        shipmentId: r.shipment_id, verdict: defects.length ? 'MISMATCH' : 'OBSERVED-LEGACY',
        expected: 'legacy_recompute',
        observedLines: lines.map((l) => ({ type: l.line_type, totalCents: cents(l.total_cost) })),
        detail: defects.length ? defects : undefined,
      });
      if (defects.length) counts.mismatchShipments += 1;
      continue;
    }

    if (lines.length === 0) {
      counts.notYetComparedRows += 1;
      shadow.push({ shipmentId: r.shipment_id, verdict: 'NOT-YET-COMPARED', expected: decision.source,
        note: 'no billing line yet — run the normal regeneration, then re-run this packet' });
      continue;
    }
    if (lines.length !== 1) defects.push('expected exactly one line, got ' + lines.length);
    const line = lines[0];
    if (!line) continue; // unreachable after the length-0 branch above; satisfies noUncheckedIndexedAccess honestly
    if (decision.source === 'frozen') {
      const expectCents = cents(decision.value.amount);
      if (line.line_type !== 'shipping') defects.push('expected shipping, got ' + line.line_type);
      if (cents(line.total_cost) !== expectCents) defects.push('billed ' + line.total_cost + ' vs frozen ' + decision.value.amount);
      if (!String(line.description).includes(decision.value.descriptionSuffix)) defects.push('description missing the frozen suffix');
      // BOTH directions (round-3): the Portal must display this row and agree to the cent.
      if (portalAmountCents == null) defects.push('portal-rejects-frozen: the real Portal predicate rejects a tuple Billing bills');
      else if (portalAmountCents !== expectCents) defects.push('portal shows ' + portalAmountCents + 'c vs frozen ' + expectCents + 'c');
    } else { // review
      if (line.line_type !== 'shipping_missing' || cents(line.total_cost) !== 0) defects.push('expected a $0 shipping_missing hold');
      if (portalAmountCents != null) defects.push('portal-displays-held: the Portal shows a tuple Billing holds');
    }
    if (defects.length) counts.mismatchShipments += 1;
    if (defects.length === 0 && decision.source === 'frozen') {
      if (j?.customerRateSource === 'house_next_best_customer_rate') tag('house_captured_rate');
      if (j?.customerShippingMoneyPolicyVersion === 'ps-509-v1') tag('sync_ingress');
      if (j?.customerShippingMoneyPolicyVersion === 'ps-508-v1') tag('ordinary_purchase');
      // Round-6 (K9): multi_shipment is tagged in a second pass over CLEANLY-COMPARED frozen
      // rows only — an out-of-window, legacy, or unbilled sibling is not activation evidence.
      cleanFrozenByOrder.set(Number(r.order_id), (cleanFrozenByOrder.get(Number(r.order_id)) ?? 0) + 1);
    }
    shadow.push({
      shipmentId: r.shipment_id, verdict: defects.length ? 'MISMATCH' : 'MATCH',
      expected: decision.source, billedLineType: line.line_type, billedTotalCents: cents(line.total_cost),
      billedInvoiced: Boolean(line.invoiced), portalAmountCents,
      detail: defects.length ? defects : undefined,
    });
  }

  // K9 second pass: only orders with >= 2 cleanly-compared frozen shipments represent the
  // multi_shipment cohort.
  for (const [, cleanCount] of cleanFrozenByOrder) {
    if (cleanCount >= 2) tag('multi_shipment');
  }

  const cohortCoverage: Record<string, number | string> = {};
  const missingCohorts: string[] = [];
  for (const c of REQUIRED_COHORTS) {
    const n = cohorts[c.name];
    if (n) cohortCoverage[c.name] = n;
    else if (WAIVERS.has(c.name)) cohortCoverage[c.name] = 'WAIVED: ' + (WAIVERS.get(c.name) ?? '');
    else { cohortCoverage[c.name] = 'NOT REPRESENTED'; missingCohorts.push(c.name); }
  }

  // ---- acceptance (round-3: no false green) --------------------------------------------------
  const failures: string[] = [...inventoryHealthFailures];
  if (counts.mismatchShipments > 0) failures.push(counts.mismatchShipments + ' mismatching shipment(s)');
  if (counts.eligibleShipments === 0) failures.push('zero eligible shipments — an empty window proves nothing');
  if (counts.notYetComparedRows > 0) failures.push(counts.notYetComparedRows + ' row(s) not yet compared');
  // Round-4 decisive defect closed: the PS-508 acceptance contract requires 100% eligible
  // tuple coverage. An eligible post-boundary row whose tuple is missing, malformed, or
  // unknown is a coverage FAILURE even when Billing correctly holds it as a $0
  // shipping_missing line — a correctly-reported hole is still a hole.
  const uncovered = counts.postBoundaryMissingRows + counts.malformedRows + counts.unknownVersionRows;
  if (uncovered > 0) {
    failures.push(uncovered + ' eligible row(s) lack a billable frozen tuple '
      + '(missing=' + counts.postBoundaryMissingRows + ', malformed=' + counts.malformedRows
      + ', unknownVersion=' + counts.unknownVersionRows + ') — 100% coverage is required, '
      + 'a correctly-held hole is still a hole');
  }
  if (missingCohorts.length > 0) failures.push('required cohorts not represented and not waived: ' + missingCohorts.join(', '));
  const verdict = counts.mismatchShipments > 0 ? 'VIOLATED' : failures.length > 0 ? 'INCOMPLETE' : 'PASS';

  const packet = {
    packetSchemaVersion: PACKET_SCHEMA_VERSION,
    generatedAtUtc: new Date().toISOString(),
    mode: MODE,
    readOnly: { requested: true, sessionDefaultTransactionReadOnly: 'on' },
    toolGitSha,
    portalMirror: {
      sha: PORTAL_MIRROR_SHA, source: PORTAL_MIRROR_SOURCE, executedAsSql: true,
      verification: MODE === 'activation'
        ? 'machine-verified via the official GitHub REST API (' + PORTAL_OFFICIAL_API + ', redirect:error, '
          + 'un-redirectable by git configuration): the attested SHA is published on GitHub, the '
          + 'mirror commit is an ancestor of it, and the predicate file is byte-identical at both '
          + 'SHAs. DEPLOYED-ness of the attested SHA remains an OPERATOR ATTESTATION — no live '
          + 'Portal version endpoint exists to read.'
        : 'not verified in inventory mode',
    },
    evidenceRunUrls: {
      note: 'OPERATOR ATTESTATIONS — recorded verbatim, not machine-verified by this tool',
      ciRunUrl: operator.ciRunUrl, pg17RunUrl: operator.pg17RunUrl, portalCiRunUrl: operator.portalCiRunUrl,
    },
    waiverApproval: WAIVERS.size > 0
      ? { approvedBy: operator.waiveApprovedBy, evidence: operator.waiveEvidence }
      : null,
    inputs: { clientId: CLIENT, boundary: BOUNDARY_RAW || '(none)', from: FROM_ISO, to: TO_ISO },
    identity: { apiHealth, operator },
    counts, cohortCoverage,
    waivers: Object.fromEntries(WAIVERS),
    verdict, failures,
    population, shadow,
  };

  const json = JSON.stringify(packet, null, 2);
  if (OUT) { fs.writeFileSync(OUT, json); console.log('packet written to ' + OUT); }
  else console.log(json);
  console.error('\nverdict=' + verdict + ' · shipments ' + rows.length + ' · eligible ' + counts.eligibleShipments
    + ' · mismatching ' + counts.mismatchShipments + ' · not-yet-compared ' + counts.notYetComparedRows
    + (failures.length ? '\nfailures:\n  - ' + failures.join('\n  - ') : ''));
  await sql.end({ timeout: 5 });
  process.exit(verdict === 'PASS' ? 0 : 1);
}

void main();
