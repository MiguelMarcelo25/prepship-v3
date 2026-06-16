/**
 * PS-251 (Card 6) guard — caller-supplied carrier endpoint URLs are SSRF-checked.
 *
 * BEHAVIORAL: runs assertPublicHttpUrl against real attack URLs (metadata, localhost,
 * RFC-1918, link-local, IPv6 loopback, bad scheme) + confirms public hosts pass.
 * STATIC: the 5 verifiers with a caller-supplied host call the guard before fetch.
 *
 *   npx tsx scripts/ps-251-ssrf-allowlist-guard.ts
 */
import { readFileSync } from 'node:fs';
import { assertPublicHttpUrl, SsrfBlockedError } from '../src/lib/ssrf-guard';

let failures = 0;
function check(name: string, cond: boolean): void {
  if (!cond) { failures += 1; console.error(`FAIL ${name}`); }
  else console.log(`ok   ${name}`);
}
function blocks(url: string): boolean {
  try { assertPublicHttpUrl(url, 'test'); return false; }
  catch (e) { return e instanceof SsrfBlockedError; }
}
function allows(url: string): boolean {
  try { assertPublicHttpUrl(url, 'test'); return true; } catch { return false; }
}

// ── public carrier hosts pass ────────────────────────────────────────────────
check('public https carrier host allowed', allows('https://api.omniship.io'));
check('public https with path allowed', allows('https://swsim.stamps.com/swsim/swsimv135.asmx'));

// ── SSRF vectors blocked ─────────────────────────────────────────────────────
check('cloud metadata 169.254.169.254 blocked', blocks('http://169.254.169.254/latest/meta-data/'));
check('localhost blocked', blocks('http://localhost:8080/'));
check('127.0.0.1 blocked', blocks('http://127.0.0.1/'));
check('0.0.0.0 blocked', blocks('http://0.0.0.0/'));
check('RFC1918 10/8 blocked', blocks('https://10.0.0.5/v1/account'));
check('RFC1918 192.168/16 blocked', blocks('https://192.168.1.1/'));
check('RFC1918 172.16/12 blocked', blocks('https://172.20.5.5/'));
check('CGNAT 100.64/10 blocked', blocks('https://100.64.1.1/'));
check('link-local 169.254/16 blocked', blocks('https://169.254.1.1/'));
check('IPv6 loopback [::1] blocked', blocks('http://[::1]/'));
check('IPv6 ULA fc00::/7 blocked', blocks('http://[fc00::1]/'));
check('metadata.google.internal blocked', blocks('http://metadata.google.internal/'));
check('non-http scheme blocked', blocks('ftp://example.com/'));
check('garbage URL blocked', blocks('not-a-url'));

// ── the 5 caller-supplied-host verifiers call the guard before fetch ─────────
const src = readFileSync('src/connectors/carrier/credential-verification.ts', 'utf8');
check('imports assertPublicHttpUrl from the ssrf-guard owner',
  /import \{ assertPublicHttpUrl \} from '\.\.\/\.\.\/lib\/ssrf-guard\.js'/.test(src));
for (const label of [
  "assertPublicHttpUrl(apiBase, 'SEKO apiBase')",
  "assertPublicHttpUrl(apiBase, 'ePost Global apiBase')",
  "assertPublicHttpUrl(apiBase, 'IntelliQuick apiBase')",
  "assertPublicHttpUrl(apiBase, 'GLS US apiBase')",
  "assertPublicHttpUrl(endpoint, 'Stamps.com swsimEndpoint')",
]) {
  check(`verifier guarded: ${label}`, src.includes(label));
}

check('package.json wires test:ps-251-ssrf-allowlist',
  /test:ps-251-ssrf-allowlist/.test(readFileSync('package.json', 'utf8')));

if (failures > 0) {
  console.error(`\nFAIL PS-251 SSRF allowlist guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-251 SSRF allowlist guard');
