/**
 * PS-316 — governance presence guard for the "Backend Truth & No Source-of-Truth Bypass Law"
 * (the strengthened successor to the PS-314 wrapper rule). Asserts the full law + PrepShip
 * examples live in every required surface, the agent files stay synced, and the PR template
 * carries the backend-truth / no-wrapper checklist item. Docs-rot ratchet — no product test.
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

// The full-law surfaces (ARCHITECTURE.md + the 3 agent instruction files carry the 7 rules).
const LAW_DOCS = ['ARCHITECTURE.md', 'AGENTS.md', 'CLAUDE.md', '.cursorrules'];
for (const file of LAW_DOCS) {
  const text = readFileSync(file, 'utf8');
  check(`${file} carries the Backend Truth & No Source-of-Truth Bypass Law heading`,
    /Backend Truth (&|and) No Source-of-Truth Bypass Law/i.test(text));
  check(`${file} rule 1 — backend owns business truth`, /backend owns business truth/i.test(text));
  check(`${file} rule 2 — no backend logic in the frontend`, /do not put backend logic in the frontend/i.test(text));
  check(`${file} rule 3 — prefer direct source-of-truth calls (card grep)`, /Prefer direct source-of-truth calls/i.test(text));
  check(`${file} rule 5 — wrappers must not become a second source of truth`, /must not become a second source of truth/i.test(text));
  check(`${file} carries the PrepShip examples (Best Rate / Print Queue / billing / shipment sync)`,
    /Best Rate|Rate Browser/.test(text) && /Print Queue/.test(text) && /billing/i.test(text) && /shipment sync/i.test(text));
}

// Agent files stay byte-synchronized.
const agents = readFileSync('AGENTS.md', 'utf8');
check('CLAUDE.md is byte-identical to AGENTS.md (synced)', readFileSync('CLAUDE.md', 'utf8') === agents);
check('.cursorrules is byte-identical to AGENTS.md (synced)', readFileSync('.cursorrules', 'utf8') === agents);

// Contributor doc carries the backend-truth law.
const contributing = readFileSync('CONTRIBUTING.md', 'utf8');
check('CONTRIBUTING.md tells contributors backend owns truth + no bypass wrapper',
  /backend owns business truth|backend truth/i.test(contributing) &&
  /second source of truth|canonical owner/i.test(contributing));

// PR template carries the exact card checklist item (card grep phrase).
const pr = readFileSync('.github/pull_request_template.md', 'utf8');
check('PR template has the backend-truth / no-wrapper checklist item',
  /Backend truth \/ no-wrapper law checked/i.test(pr) &&
  /no wrapper\/helper\/adapter became a second source of truth/i.test(pr));

if (failures > 0) {
  console.error(`\nPS-316 backend-truth law guard FAILED with ${failures} failure(s).`);
  process.exit(1);
}
console.log('\nPS-316 backend-truth law guard passed.');
