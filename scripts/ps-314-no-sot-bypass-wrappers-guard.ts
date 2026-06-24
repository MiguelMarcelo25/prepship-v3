/**
 * PS-314 — governance presence guard: the "No Source-of-Truth Bypass Wrappers" law must
 * appear in every required repo surface, the three agent-instruction files must stay
 * byte-synchronized, and the canonical statement must spell out the MUST-NOT list. This is
 * a docs-rot ratchet, not a product test — it fails if a future edit deletes or desyncs the rule.
 */
import { readFileSync } from 'node:fs';

let failures = 0;
function check(name: string, condition: boolean): void {
  if (!condition) {
    failures += 1;
    console.error(`FAIL ${name}`);
    return;
  }
  console.log(`ok   ${name}`);
}

// PS-316 strengthened the PS-314 heading to "Backend Truth & No Source-of-Truth Bypass Law" —
// match the shared "No Source-of-Truth Bypass" stem so both wordings satisfy this ratchet.
const RULE = /No Source-of-Truth Bypass/i;

// 1) The rule is present in every required governance surface.
const surfaces = [
  'ARCHITECTURE.md',
  'AGENTS.md',
  'CLAUDE.md',
  '.cursorrules',
  'CONTRIBUTING.md',
  '.github/pull_request_template.md',
];
for (const f of surfaces) {
  check(`${f} carries the no-source-of-truth-bypass-wrapper rule`, RULE.test(readFileSync(f, 'utf8')));
}

// 2) The three agent-instruction files stay byte-identical (the mirror/sync invariant).
const agents = readFileSync('AGENTS.md', 'utf8');
check('CLAUDE.md is byte-identical to AGENTS.md (synced mirror)', readFileSync('CLAUDE.md', 'utf8') === agents);
check('.cursorrules is byte-identical to AGENTS.md (synced mirror)', readFileSync('.cursorrules', 'utf8') === agents);

// 3) The canonical statement actually spells out the MUST-NOT boundary (not just a title).
check('AGENTS.md states the MUST-NOT list (no owning business rules / authoritative values / "best" selection)',
  /must not/i.test(agents) &&
  /own business rules/i.test(agents) &&
  /choose authoritative values/i.test(agents) &&
  /rank or select/i.test(agents) &&
  /silently fall back/i.test(agents));

if (failures > 0) {
  console.error(`\nPS-314 no-SOT-bypass-wrappers guard FAILED with ${failures} failure(s).`);
  process.exit(1);
}
console.log('\nPS-314 no-source-of-truth-bypass-wrappers guard passed.');
