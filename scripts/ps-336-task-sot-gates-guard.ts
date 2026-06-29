/**
 * PS-336 - task/template source-of-truth placement gates.
 *
 * Offline/static only: reads repo docs, package scripts, CI guard-pack wiring,
 * and task templates. No product runtime, DB, providers, labels, postage,
 * marketplace notifications, or shipped/cancelled data mutations.
 */
import { existsSync, readFileSync } from 'node:fs';

let failures = 0;

function check(name: string, condition: boolean, detail?: unknown): void {
  if (!condition) {
    failures += 1;
    console.error(`FAIL ${name}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`);
    return;
  }
  console.log(`ok   ${name}`);
}

function read(path: string): string {
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

function checkIncludesAll(name: string, text: string, values: readonly string[]): void {
  const missing = values.filter((value) => !text.includes(value));
  check(name, missing.length === 0, missing);
}

const packageJsonText = read('package.json');
const packageJson = packageJsonText ? JSON.parse(packageJsonText) as { scripts?: Record<string, string> } : {};
const scripts = packageJson.scripts ?? {};

const REQUIRED_COMMAND = 'test:ps-336-task-sot-gates';
const REQUIRED_BLOCK_FIELDS = [
  'Architecture placement / source-of-truth gate',
  'Business rule/workflow being changed',
  'Canonical backend/domain/read-model/policy owner',
  'Current duplicated/unsafe owners',
  'Where bad/stale/incomplete data can enter',
  'Callers that must delegate to the owner',
  'Wrapper/resolver/helper logic to delete or explicitly forbid',
  'Frontend role: display/action only; no authoritative business logic',
  'Backend boundary tests required',
  'Workflow/UI proof required',
] as const;

const taskTemplate = read('docs/engineering/task-template.md');
const architecture = read('ARCHITECTURE.md');
const agents = read('AGENTS.md');
const claude = read('CLAUDE.md');
const cursorRules = read('.cursorrules');
const contributing = read('CONTRIBUTING.md');
const prTemplate = read('.github/pull_request_template.md');
const archChecklist = read('docs/engineering/architecture-first-checklist.md');
const llmAgentInstall = read('docs/engineering/llm-agent-installation.md');
const sotPack = read('scripts/sot-guard-pack.mjs');
const ps335Guard = read('scripts/ps-335-sot-guard-pack-guard.ts');
const ps336DocPath = 'docs/ps-tickets/ps-336-task-sot-gates.md';
const ps336Doc = read(ps336DocPath);

check('package wires PS-336 task SOT gate guard',
  scripts[REQUIRED_COMMAND] === 'tsx scripts/ps-336-task-sot-gates-guard.ts');
check('SOT guard pack includes PS-336 task gate guard', sotPack.includes(REQUIRED_COMMAND));
check('PS-335 guard-of-guard requires PS-336 task gate guard', ps335Guard.includes(REQUIRED_COMMAND));

checkIncludesAll('task template has required architecture placement/source-of-truth block',
  taskTemplate,
  REQUIRED_BLOCK_FIELDS);

for (const [name, text] of [
  ['AGENTS.md', agents],
  ['CLAUDE.md', claude],
  ['.cursorrules', cursorRules],
] as const) {
  checkIncludesAll(`${name} tells agents to stop when task lacks canonical owner and forbids frontend/wrapper truth`,
    text,
    [
      'If a task does not name the canonical owner',
      'return a placement mismatch note before coding',
      'Frontend role: display/action only',
      'Wrapper/resolver/helper logic to delete or explicitly forbid',
    ]);
}

check('CLAUDE.md is byte-identical to AGENTS.md after PS-336 sync', claude === agents);
check('.cursorrules is byte-identical to AGENTS.md after PS-336 sync', cursorRules === agents);

checkIncludesAll('ARCHITECTURE.md carries the PS-336 task placement gate fields',
  architecture,
  REQUIRED_BLOCK_FIELDS);
checkIncludesAll('CONTRIBUTING.md requires rejecting tasks/PRs missing source-of-truth placement',
  contributing,
  [
    'If a task or PR does not name the canonical owner',
    'return a placement mismatch note before coding',
    'Current duplicated/unsafe owners',
    'Wrapper/resolver/helper logic to delete or explicitly forbid',
  ]);
checkIncludesAll('PR template asks for the PS-336 task placement fields',
  prTemplate,
  [
    'Current duplicated/unsafe owners',
    'Wrapper/resolver/helper logic to delete or explicitly forbid',
    'Frontend role: display/action only',
    'Backend boundary tests required',
  ]);
checkIncludesAll('architecture-first checklist mirrors the PS-336 pre-coding stop rule',
  archChecklist,
  [
    'If the task does not name the canonical owner',
    'return a placement mismatch note before coding',
    'Wrapper/resolver/helper logic to delete or explicitly forbid',
  ]);
checkIncludesAll('LLM agent installation doc points task authors at the required placement gate',
  llmAgentInstall,
  [
    'Architecture placement / source-of-truth gate',
    'If a task does not name the canonical owner',
    'task-template.md',
  ]);

check('PS-336 collision/source-of-truth note exists', existsSync(ps336DocPath));
checkIncludesAll('PS-336 doc records number collision, source-of-truth note, and proof commands',
  ps336Doc,
  [
    'PS-336 - Task SOT Gates',
    'PS-336 Number Collision',
    'Repo instruction docs and task templates are the source of truth',
    REQUIRED_COMMAND,
    'test:sot-guard-pack',
    'No product behavior changed',
  ]);

if (failures > 0) {
  console.error(`\nFAIL PS-336 task SOT gates guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS PS-336 task SOT gates guard');
