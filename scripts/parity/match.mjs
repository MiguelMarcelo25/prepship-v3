#!/usr/bin/env node
// Joins v2 + v4 atom JSONL files and emits one markdown checklist per module.
//
// Input:  parity/v2-atoms.jsonl, parity/v4-atoms.jsonl
// Output: parity/<module>.md × 12

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MODULES, CATEGORIES, BEHAVIOR_MATCH_ATOMS } from './rules.mjs';

const REPO = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const V2_PATH = join(REPO, 'parity', 'v2-atoms.jsonl');
const V4_PATH = join(REPO, 'parity', 'v4-atoms.jsonl');
const OUT_DIR = join(REPO, 'parity');

if (!existsSync(V2_PATH) || !existsSync(V4_PATH)) {
  console.error('Missing v2-atoms.jsonl or v4-atoms.jsonl — run extract.mjs first.');
  process.exit(1);
}

function readJsonl(path) {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

const v2 = readJsonl(V2_PATH);
const v4 = readJsonl(V4_PATH);

// Index v4 atoms by id AND by (category + normalized id) for alternative joins
const v4ById = new Map();
for (const a of v4) {
  const key = `${a.module}::${a.category}::${a.id}`;
  v4ById.set(key, a);
  // Also index cross-module (some atoms classified differently per side)
  v4ById.set(`*::${a.category}::${a.id}`, a);
}

// For category tolerance: if v2 says 'orders' and v4 says '_config' for the
// same route id, still match. The module bucket a match lands in is v2's.

const CAT_LABEL = {
  route: '### Backend Routes',
  service: '### Services',
  schema: '### DB Schema',
  dto: '### DTOs',
  'view-column': '### View: Columns',
  'view-filter': '### View: Filters',
  'view-modal': '### View: Modals / Drawers',
  'view-action': '### View: Actions / Keyboard',
  hook: '### Frontend Hooks',
  context: '### Contexts',
  'api-client': '### apiClient Methods',
  constant: '### Constants (business rules)',
  'css-class': '### CSS Classes',
  'ss-call': '### ShipStation Calls',
  'worker-job': '### Worker Jobs',
};

// Bucket v2 atoms by module
const byModule = new Map();
for (const mod of MODULES) byModule.set(mod, []);
for (const a of v2) {
  const bucket = byModule.get(a.module);
  if (bucket) bucket.push(a);
  else {
    if (!byModule.has(a.module)) byModule.set(a.module, []);
    byModule.get(a.module).push(a);
  }
}

// Build v4-only index: which v4 atoms are NOT matched by any v2 atom?
const matchedV4Ids = new Set();

function matchStatus(atom) {
  const variants = [
    `${atom.module}::${atom.category}::${atom.id}`,
    `*::${atom.category}::${atom.id}`,
  ];
  for (const k of variants) {
    const hit = v4ById.get(k);
    if (hit) {
      matchedV4Ids.add(`${hit.module}::${hit.category}::${hit.id}`);
      return { status: 'MATCH', v4: hit };
    }
  }
  return { status: 'MISSING', v4: null };
}

function classify(atom, status) {
  if (status === 'MATCH' && BEHAVIOR_MATCH_ATOMS.has(atom.id)) {
    return 'MATCH_NEEDS_BEHAVIOR_REVIEW';
  }
  return status;
}

function renderChecklistLine(atom, matchInfo) {
  const tag = classify(atom, matchInfo.status);
  const checkbox = tag === 'MATCH' ? '[x]' : '[ ]';
  const v2loc = `${atom.location.file}:L${atom.location.line}`;
  const sig = atom.signature ?? atom.id;

  let line = `- ${checkbox} \`${atom.id}\` — ${escape(sig)} — **[${tag}]**\n`;
  line += `      v2: ${v2loc}\n`;

  if (matchInfo.v4) {
    const v4loc = `${matchInfo.v4.location.file}:L${matchInfo.v4.location.line}`;
    line += `      v4: ${v4loc}\n`;
  } else {
    line += `      v4: —\n`;
    line += `      Fix needed: <TODO: port ${atom.category} \`${atom.id}\` from v2>\n`;
  }

  if (tag === 'MATCH_NEEDS_BEHAVIOR_REVIEW') {
    line += `      Behavior review: verify v4 produces the same outputs on the same inputs as v2\n`;
  }
  return line;
}

function escape(s) {
  return String(s).replace(/[|`]/g, (c) => '\\' + c);
}

// ── Emit one .md per module ────────────────────────────────────────────────
if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

let grandTotal = 0, grandMatch = 0, grandMissing = 0, grandBehavior = 0;

for (const mod of MODULES) {
  const atoms = byModule.get(mod) ?? [];
  atoms.sort((a, b) => a.category.localeCompare(b.category) || a.id.localeCompare(b.id));

  let matchCount = 0, missingCount = 0, behaviorCount = 0;
  const lines = [];
  lines.push(`# Parity: ${mod}`);
  lines.push('');
  lines.push(`Source: \`v2orginal/\``);
  lines.push(`Target: \`prepship-v4-stable/\``);
  lines.push('');

  // Group by category
  const byCat = new Map();
  for (const a of atoms) {
    if (!byCat.has(a.category)) byCat.set(a.category, []);
    byCat.get(a.category).push(a);
  }

  const body = [];
  for (const cat of CATEGORIES) {
    const list = byCat.get(cat);
    if (!list || !list.length) continue;
    body.push('');
    body.push(CAT_LABEL[cat] ?? `### ${cat}`);
    body.push('');
    for (const a of list) {
      const m = matchStatus(a);
      const tag = classify(a, m.status);
      if (tag === 'MATCH') matchCount++;
      else if (tag === 'MATCH_NEEDS_BEHAVIOR_REVIEW') { matchCount++; behaviorCount++; }
      else missingCount++;
      body.push(renderChecklistLine(a, m));
    }
  }

  const total = matchCount + missingCount;
  grandTotal += total;
  grandMatch += matchCount;
  grandMissing += missingCount;
  grandBehavior += behaviorCount;

  lines.push(`**Atoms:** ${total}  |  **MATCH:** ${matchCount}  |  **MISSING:** ${missingCount}  |  **Behavior review needed:** ${behaviorCount}`);
  lines.push('');
  lines.push(`Generated: ${new Date().toISOString().slice(0, 10)}`);
  lines.push('');
  lines.push('---');
  lines.push(...body);
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('**Verified-by:** _________  **Date:** _________');
  lines.push('');

  writeFileSync(join(OUT_DIR, `${mod}.md`), lines.join('\n'));
  console.error(`wrote parity/${mod}.md — ${total} atoms (${matchCount} match, ${missingCount} missing)`);
}

// ── V4_ONLY report — atoms in v4 with no v2 counterpart ─────────────────────
const v4OnlyLines = ['# Parity: v4-only atoms', ''];
v4OnlyLines.push('These atoms exist in v4 but have no v2 counterpart. Either:');
v4OnlyLines.push('- **Improvement** (v4 deliberately added something v2 lacks) → mark `[INTENTIONALLY_CHANGED]` below');
v4OnlyLines.push('- **Dead-code candidate** (not in v2 because not needed) → mark for review');
v4OnlyLines.push('');
const v4OnlyByModule = new Map();
for (const a of v4) {
  const key = `${a.module}::${a.category}::${a.id}`;
  if (matchedV4Ids.has(key)) continue;
  if (!v4OnlyByModule.has(a.module)) v4OnlyByModule.set(a.module, []);
  v4OnlyByModule.get(a.module).push(a);
}
let v4OnlyCount = 0;
for (const [mod, list] of v4OnlyByModule) {
  v4OnlyLines.push(`## ${mod}`);
  list.sort((a, b) => a.category.localeCompare(b.category) || a.id.localeCompare(b.id));
  for (const a of list) {
    v4OnlyLines.push(`- [ ] \`${a.id}\` — ${escape(a.signature)} — **[V4_ONLY]**`);
    v4OnlyLines.push(`      v4: ${a.location.file}:L${a.location.line}`);
    v4OnlyLines.push(`      Classification: _________ (INTENTIONALLY_CHANGED | V2_DEAD | FIX_NEEDED)`);
    v4OnlyCount++;
  }
  v4OnlyLines.push('');
}
writeFileSync(join(OUT_DIR, '_v4-only.md'), v4OnlyLines.join('\n'));

// ── README with run instructions + status dashboard ─────────────────────────
const readme = [
  '# Parity pipeline',
  '',
  'Line-by-line v2original → v4-stable parity verification.',
  '',
  '## Run the pipeline',
  '',
  '```bash',
  '# Extract atoms from both repos (parallel)',
  'node scripts/parity/extract.mjs ../v2orginal v2 > parity/v2-atoms.jsonl &',
  'node scripts/parity/extract.mjs . v4 > parity/v4-atoms.jsonl &',
  'wait',
  '',
  '# Join + emit checklists',
  'node scripts/parity/match.mjs',
  '```',
  '',
  '## Current status',
  '',
  `| Metric | Count |`,
  `|---|---|`,
  `| Total v2 atoms | ${grandTotal} |`,
  `| Matched in v4 | ${grandMatch} |`,
  `| Missing in v4 | ${grandMissing} |`,
  `| Needs behavior review | ${grandBehavior} |`,
  `| v4-only atoms | ${v4OnlyCount} |`,
  '',
  '## Per-module files',
  '',
  ...MODULES.map((m) => `- [\`${m}.md\`](./${m}.md)`),
  `- [\`_v4-only.md\`](./_v4-only.md)`,
  '',
  '## Success criterion',
  '',
  'Pipeline is complete when:',
  '',
  '```bash',
  "grep -R '\\[MISSING\\]\\|\\[PARTIAL\\]' parity/*.md",
  '```',
  '',
  'returns zero matches, and every per-module file has a filled `Verified-by:` line.',
  '',
].join('\n');

writeFileSync(join(OUT_DIR, 'README.md'), readme);

console.error(`\nGrand total: ${grandTotal} v2 atoms, ${grandMatch} matched, ${grandMissing} missing, ${grandBehavior} need behavior review`);
console.error(`V4-only atoms: ${v4OnlyCount}`);
