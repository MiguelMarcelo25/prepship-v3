/**
 * PS-254 (Card 9, item 4) — secret scan over the FE bundle source.
 *
 * The frontend bundle is publicly served, so it must never embed a provider secret (the Supabase
 * ANON key is fine — it's public by design; a SERVICE-ROLE key, carrier/cloud key, or private key
 * is a leak). This scans web/src (the bundled source) + web/dist (if built) for HIGH-CONFIDENCE
 * secret patterns — provider-prefixed keys + private-key blocks, chosen to avoid false positives.
 *
 *   npx tsx scripts/ps-254-secret-scan-guard.ts
 */
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOTS = ['web/src', 'web/dist'].filter(existsSync);
const EXTS = ['.ts', '.tsx', '.js', '.jsx', '.json', '.html', '.css', '.mjs', '.cjs'];

// High-confidence secret signatures — a match is almost certainly a real leaked credential.
const PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: 'AWS access key id', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'Stripe secret key', re: /\bsk_(live|test)_[0-9a-zA-Z]{16,}\b/ },
  { name: 'GitHub token', re: /\bgh[pousr]_[0-9A-Za-z]{36,}\b/ },
  { name: 'Slack token', re: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/ },
  { name: 'Google API key', re: /\bAIza[0-9A-Za-z_\-]{35}\b/ },
  { name: 'private key block', re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/ },
  { name: 'Supabase service_role key literal', re: /service_role[^\n]{0,40}eyJ[A-Za-z0-9_\-]{20,}/ },
];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (EXTS.some((e) => p.endsWith(e))) out.push(p);
  }
  return out;
}

const findings: string[] = [];
let scanned = 0;
for (const root of ROOTS) {
  for (const file of walk(root)) {
    scanned += 1;
    const text = readFileSync(file, 'utf8');
    for (const { name, re } of PATTERNS) {
      const m = re.exec(text);
      if (m) findings.push(`${file}: ${name} (${m[0].slice(0, 12)}…)`);
    }
  }
}

console.log(`secret-scan: ${scanned} bundle-source files scanned across [${ROOTS.join(', ')}]`);
if (findings.length > 0) {
  console.error(`\nFAIL secret-scan — possible leaked credentials in the FE bundle:`);
  for (const f of findings) console.error(`  ${f}`);
  console.error('Move the secret to a server-side env var; the FE bundle is public.');
  process.exit(1);
}
console.log('\nPASS secret-scan — no high-confidence provider secrets in the FE bundle.');
