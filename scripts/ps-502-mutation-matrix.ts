#!/usr/bin/env tsx
/**
 * PS-502 — mutation matrix for the replacement contract guard.
 *
 * The guard is large and mostly green-by-construction, which is exactly the condition under
 * which a check quietly stops defending anything. Each mutation reintroduces a defect the
 * card names and requires the guard to go red AT THE CHECK THAT OWNS IT.
 *
 * Scope matches the guard's: the unlocked slice only. Nothing here touches shipped data, a
 * label, inventory or billing rows — the mutations edit pure modules and one migration-free
 * lifecycle table.
 *
 * Run on a clean tree. Files are restored in a finally block.
 */
import { runMutationMatrix, type Mutation } from './lib/mutation-matrix';

const FINGERPRINT = 'src/services/replacement-source-line-fingerprint.ts';
const REFERENCE = 'src/services/replacement-reference.ts';
const STATE_MACHINE = 'src/services/replacement-state-machine.ts';
const ALLOWANCE = 'src/services/replacement-allowance.ts';
const BILLABILITY = 'src/services/replacement-billability.ts';

const MUTATIONS: Mutation[] = [
  {
    id: 'M1',
    defect: 'quantity drops out of the fingerprint — the card\'s duplicate-SKU worst case reopens',
    file: FINGERPRINT,
    find: '    normalizeQuantity(facts.originalOrderedQuantity),',
    replace: '    null,',
    expect: 'DUPLICATE-SKU REORDER is caught (the card\'s worst case)',
  },
  {
    id: 'M2',
    defect: 'the format version leaves the tuple, so a layout change becomes indistinguishable from drift',
    file: FINGERPRINT,
    find: '    REPLACEMENT_FINGERPRINT_VERSION,',
    replace: '',
    expect: 'the format is versioned, so a layout change is deliberate not silent',
  },
  {
    id: 'M3',
    defect: 'delimiter-joined encoding replaces JSON, letting two lines forge one fingerprint',
    file: FINGERPRINT,
    find: /return JSON\.stringify\(\[([\s\S]*?)\]\);/,
    replace: "return [$1].join('|');",
    expect: 'a separator inside a field cannot forge another line\'s fingerprint',
  },
  {
    id: 'M4',
    defect: 'SKU comparison becomes case-sensitive, so a case change reads as product drift',
    file: FINGERPRINT,
    find: "  return typeof value === 'string' ? value.trim().toLowerCase() : '';",
    replace: "  return typeof value === 'string' ? value.trim() : '';",
    expect: 'SKU case and surrounding space are not drift',
  },
  {
    id: 'M5',
    defect: 'numeric quantity is no longer canonicalised, so "2.000" and 2 diverge',
    file: FINGERPRINT,
    find: "  const parsed = typeof value === 'number' ? value : Number(String(value).trim());",
    replace: '  const parsed = value as number;',
    expect: 'numeric quantity representations are one value ("2" = 2 = "2.000")',
  },
  {
    id: 'M6',
    defect: 'review is shown only the first other home of the frozen SKU',
    file: FINGERPRINT,
    find: '    .sort((a, b) => a - b);',
    replace: '    .slice(0, 1).sort((a, b) => a - b);',
    expect: 'review can tell "this line moved" from "this product is gone"',
  },
  {
    id: 'M7',
    defect: 'the first replacement is emitted as -1, creating a second spelling of one identity',
    file: REFERENCE,
    find: '  return sequence === 1',
    replace: '  return false',
    expect: 'the first replacement is the BARE form, never -1',
  },
  {
    id: 'M8',
    defect: 'allocation counts references instead of taking max, so a cancelled gap is reused',
    file: REFERENCE,
    find: '    if (parsed.sequence > highest) highest = parsed.sequence;',
    replace: '    highest += 1;',
    expect: 'a GAP is never reused (a cancelled replacement keeps its reference)',
  },
  {
    id: 'M9',
    defect: 'the parser accepts the non-canonical -1 spelling',
    file: REFERENCE,
    find: '  if (sequence < 2) return null;',
    replace: '  if (sequence < 0) return null;',
    expect: '"1321-REPLACE-1" is rejected as a reference',
  },
  {
    id: 'M10',
    defect: 'another order\'s references advance this order\'s sequence',
    file: REFERENCE,
    find: '    if (!parsed || parsed.orderNumber !== trimmed) continue;',
    replace: '    if (!parsed) continue;',
    expect: 'another order\'s references do not advance this order',
  },
  {
    id: 'M11',
    defect: 'label_failed -> shipped becomes legal — goods ship with no label',
    file: STATE_MACHINE,
    find: "  label_failed: ['review', 'approved', 'label_created', 'cancelled'],",
    replace: "  label_failed: ['review', 'approved', 'label_created', 'cancelled', 'shipped'],",
    expect: 'label_failed -> shipped is ILLEGAL',
  },
  {
    id: 'M12',
    defect: 'a never-shipped status consumes allowance, so a cancelled request reduces the cap',
    file: ALLOWANCE,
    find: "const ALLOWANCE_CONSUMING_STATUSES: readonly ReplacementStatus[] = ['shipped', 'completed'];",
    replace: "const ALLOWANCE_CONSUMING_STATUSES: readonly ReplacementStatus[] = ['shipped', 'completed', 'approved'];",
    expect: 'approved does NOT consume allowance',
  },
  {
    id: 'M13',
    defect: 'a post-ship review stops consuming, so the same units can go out twice',
    file: ALLOWANCE,
    find: "  return row.status === 'review' && row.shippedAt != null;",
    replace: '  return false;',
    expect: 'a POST-ship review DOES consume (it shipped, then drifted)',
  },
  {
    id: 'M14',
    defect: 'the cap stops aggregating on the frozen coordinate, so a reorder resets it',
    file: ALLOWANCE,
    find: '    if (row.sourceLineFingerprint !== input.sourceLineFingerprint) continue;',
    replace: '    if (false) continue;',
    expect: 'the cap aggregates on the FROZEN coordinate, not on whatever sits there now',
  },
  {
    id: 'M15',
    defect: 'an over-ship override no longer needs a reason — an unattributable claim',
    file: ALLOWANCE,
    find: "  if (override?.hasOverridePermission && reason !== '') {",
    replace: '  if (override?.hasOverridePermission) {',
    expect: 'an override requires a reason, not just the permission',
  },
  {
    id: 'M16',
    defect: 'operator liability stops forcing non-billable — the client is charged for our mistake',
    file: BILLABILITY,
    find: "  return owner === 'operator' ? false : null;",
    replace: '  return null;',
    expect: 'operator liability FORCES non-billable, even for finance',
  },
  {
    id: 'M17',
    defect: 'billability stays editable past label_created, after postage is committed',
    file: BILLABILITY,
    find: '  if (!BILLABILITY_EDITABLE_STATUSES.includes(change.status)) {',
    replace: '  if (false) {',
    expect: 'billability is FROZEN from label_created onward',
  },
  {
    id: 'M18',
    defect: 'one permission suffices, so replacements:billing alone can move money',
    file: BILLABILITY,
    find: '    || !hasPermission(change.actor, FINANCIALS_WRITE_PERMISSION)',
    replace: '',
    expect: 'replacements:billing alone is not enough — financials:write is also required',
  },
];

process.exit(runMutationMatrix({
  title: 'PS-502 mutation matrix',
  guard: 'scripts/ps-502-replacement-contract-guard.ts',
  mutations: MUTATIONS,
}));
