import { resolveCutoverBoundary as rb, isAfterCutover as after } from '../src/services/customer-shipping-money-cutover-gate';
import { isFrozenTupleBillingEnabledForClient as on } from '../src/services/customer-shipping-money-cutover-gate';

/**
 * PS-508 W5 — the per-client activation gate.
 *
 * The safety property that makes the cutover shippable is that OFF is byte-identical to
 * pre-cutover Billing. Billing achieves that by BYPASSING the frozen-tuple decision when the
 * gate is off. An earlier design narrowed the accepted-version list to [] instead — that looks
 * equivalent and is not: a valid tuple under an empty accept-list is not billable AND is not
 * `legacy_absent`, so it would fall through to review and hold money for every gated-off client.
 * These checks pin the distinction.
 */
let failures = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) { console.log(`ok   ${name}`); return; }
  failures += 1;
  console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`);
}

// Default posture: empty allowlist is OFF for everyone. This is the production default.
check('empty allowlist -> OFF', on({ clientId: 4, allowlist: '' }) === false);
check('whitespace-only allowlist -> OFF', on({ clientId: 4, allowlist: '   ' }) === false);
check('empty allowlist -> OFF even for a null client', on({ clientId: null, allowlist: '' }) === false);

// Single-client canary — the card's required first rollout step.
check('listed client -> ON', on({ clientId: 4, allowlist: '4' }) === true);
check('unlisted client -> OFF', on({ clientId: 5, allowlist: '4' }) === false);
check('one canary client does not enable a second', on({ clientId: 7, allowlist: '4' }) === false);

// Multi-client expansion, tolerant of operator spacing.
check('comma list enables each member', on({ clientId: 9, allowlist: '4,9,12' }) === true);
check('comma list with spaces still matches', on({ clientId: 9, allowlist: ' 4 , 9 , 12 ' }) === true);
check('comma list excludes non-members', on({ clientId: 11, allowlist: '4,9,12' }) === false);

// Full rollout.
check('wildcard enables everyone', on({ clientId: 123, allowlist: '*' }) === true);

// A shipment with no client cannot be opted in by an id list — only by an explicit wildcard.
check('null clientId is OFF under an id list', on({ clientId: null, allowlist: '4,9' }) === false);
check('undefined clientId is OFF under an id list', on({ clientId: undefined, allowlist: '4,9' }) === false);

// Substring safety: 4 must not match because 41 or 14 is listed.
check('client 4 is NOT enabled by an allowlist of 41', on({ clientId: 4, allowlist: '41' }) === false);
check('client 4 is NOT enabled by an allowlist of 14', on({ clientId: 4, allowlist: '14' }) === false);
check('client 1 is NOT enabled by an allowlist of 12,13', on({ clientId: 1, allowlist: '12,13' }) === false);

// Malformed operator input must never fail OPEN.
check('stray commas do not enable everyone', on({ clientId: 4, allowlist: ',,,' }) === false);
check('a non-numeric entry does not enable an unlisted client', on({ clientId: 4, allowlist: 'all' }) === false);

// --- PS-508 W6: the cutover boundary -------------------------------------------------------

check('empty boundary -> none', rb('').kind === 'none');
check('whitespace boundary -> none', rb('   ').kind === 'none');
check('ISO date parses', rb('2026-08-24').kind === 'at');
check('ISO datetime parses', rb('2026-08-24T00:00:00Z').kind === 'at');
// A typo must NOT collapse to 'none' — that would silently switch the protection off.
check('garbage boundary -> invalid, NOT none', rb('not-a-date').kind === 'invalid');
check('a near-miss typo -> invalid, NOT none', rb('2026-13-45').kind === 'invalid');

const B = rb('2026-08-01T00:00:00Z');
check('no boundary configured -> nothing is after cutover',
  after(rb(''), new Date('2030-01-01')) === false);
check('shipment before the boundary is pre-cutover',
  after(B, new Date('2026-07-31T23:59:59Z')) === false);
check('shipment after the boundary is post-cutover',
  after(B, new Date('2026-08-01T00:00:01Z')) === true);
check('shipment exactly AT the boundary is post-cutover (at-or-after)',
  after(B, new Date('2026-08-01T00:00:00Z')) === true);
// Fail closed: unprovable rows are held, not billed from a recomputed number.
check('undated shipment is treated as post-cutover', after(B, null) === true);
check('undefined ship date is treated as post-cutover', after(B, undefined) === true);
check('an invalid Date is treated as post-cutover', after(B, new Date('nope')) === true);
check('an INVALID boundary fails closed for every shipment',
  after(rb('not-a-date'), new Date('2020-01-01')) === true);

console.log(failures === 0 ? '\nPASS' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
