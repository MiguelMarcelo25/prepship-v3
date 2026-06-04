// Read-only connector / credential health report.
//
// Tells you, at a glance, whether the carriers and marketplace connectors are
// READY — code-wise (what's wired) and config-wise (which accounts have
// credentials). Use it before relying on direct-carrier label + confirmation.
//
// SAFETY: reads ONLY connector config tables (carrier_accounts, store_accounts).
//   - NEVER reads, writes, or touches orders / shipments.
//   - NEVER buys postage, creates labels, or sends marketplace notifications.
//   - NEVER prints secret VALUES — only which credential FIELD NAMES are set.
//
//   npm run connector:health        (needs DATABASE_URL for the config section;
//                                     the code-readiness section needs nothing)
import {
  buildCompatibilityMatrix,
  carrierCanCreateLabel,
  sourceConfirmation,
  LABEL_CAPABLE_CARRIERS,
} from '../src/connectors/compatibility-matrix';
import type { ConnectorProvider } from '../src/connectors/types';

function normalizeProvider(value: unknown): string {
  return String(value ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
}

// Credential FIELD NAMES that are populated — never the values. Empty string /
// null fields are treated as "not set" so a half-filled credential shows up.
function setCredentialKeys(creds: unknown): string[] {
  if (!creds || typeof creds !== 'object') return [];
  return Object.entries(creds as Record<string, unknown>)
    .filter(([, v]) => v != null && String(v).trim() !== '')
    .map(([k]) => k)
    .sort();
}

const pad = (s: string, n: number) => (s + ' '.repeat(n)).slice(0, n);

// --verify makes a live, READ-ONLY auth check per account (no postage, labels,
// notifications, or orders). Short, sanitized reason — never raw payloads.
const doVerify = process.argv.includes('--verify');
function shortReason(text: unknown): string {
  return String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
}

async function main(): Promise<void> {
  // ── Section 1: CODE readiness (no DB needed) ───────────────────────────────
  console.log('\n=== 1) CODE READINESS (what is wired) ===');
  const matrix = buildCompatibilityMatrix();
  const labelCarriers = LABEL_CAPABLE_CARRIERS.filter((c) => c !== 'shipstation');
  console.log(`Direct carriers that can BUY labels: ${labelCarriers.join(', ')} (+ shipstation via Render)`);
  const liveSources = [...new Set(
    matrix
      .filter((r) => r.confirmationState === 'pending')
      .map((r) => r.confirmationOwner)
      .filter((owner) => /^[a-z_]+$/.test(owner)), // real provider keys only, skip synthetic labels
  )];
  console.log(`Marketplace sources with LIVE confirmation: ${liveSources.join(', ')}`);
  const blockedSources = [...new Set(matrix.filter((r) => r.confirmationState === 'not_supported').map((r) => r.storeSource))];
  if (blockedSources.length) console.log(`Sources whose confirmation is a STUB (not_supported): ${blockedSources.join(', ')}`);

  // ── Section 2: CONFIG readiness (needs DATABASE_URL) ───────────────────────
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.log('\n=== 2) CONFIG READINESS — SKIPPED ===');
    console.log('DATABASE_URL is not set in this environment. Run with a read-only');
    console.log('DATABASE_URL to see which carrier/store accounts have credentials.');
    console.log('\nDONE (code-readiness only).');
    return;
  }

  // Defer the driver import so the code-readiness section works with no deps.
  const postgres = (await import('postgres')).default;
  const sql = postgres(dbUrl, { max: 1, prepare: false, idle_timeout: 5, connect_timeout: 10 });

  // Live read-only credential verifier (only loaded when --verify is passed).
  const verifyProviderCredentials = doVerify
    ? (await import('../src/connectors/carrier/credential-verification')).verifyProviderCredentials
    : null;
  async function liveVerify(provider: string, credentials: unknown): Promise<string> {
    if (!verifyProviderCredentials) return '';
    try {
      const r = await verifyProviderCredentials(provider, (credentials ?? {}) as Record<string, unknown>);
      return r?.ok ? 'verify=OK' : `verify=FAIL (${shortReason(r?.error) || 'auth failed'})`;
    } catch (err) {
      return `verify=ERROR (${shortReason(err instanceof Error ? err.message : err)})`;
    }
  }

  let carrierReady = 0;
  let carrierMissing = 0;
  let carrierVerifyFail = 0;
  let storeReady = 0;
  let storeMissing = 0;
  let storeVerifyFail = 0;

  try {
    console.log(`\n=== 2) CONFIG READINESS — carrier accounts (label buying)${doVerify ? ' [LIVE VERIFY]' : ''} ===`);
    console.log(
      pad('id', 6) + pad('provider', 18) + pad('nickname', 22) + pad('active', 8) +
      pad('label?', 8) + pad('credentials set', doVerify ? 40 : 0) + (doVerify ? 'live verify' : ''),
    );
    console.log('-'.repeat(doVerify ? 120 : 96));
    const carriers = await sql<Array<{ id: number; provider: string; label: string | null; active: boolean; credentials: unknown }>>`
      SELECT id, provider, label, active, credentials FROM carrier_accounts ORDER BY provider, id
    `;
    for (const c of carriers) {
      const keys = setCredentialKeys(c.credentials);
      const canLabel = carrierCanCreateLabel(normalizeProvider(c.provider) as ConnectorProvider);
      const hasCreds = keys.length > 0;
      if (canLabel && hasCreds && c.active) carrierReady += 1;
      else if (canLabel) carrierMissing += 1;
      const verifyText = canLabel && hasCreds ? await liveVerify(c.provider, c.credentials) : '';
      if (verifyText.startsWith('verify=FAIL') || verifyText.startsWith('verify=ERROR')) carrierVerifyFail += 1;
      const credCell = hasCreds ? `[${keys.join(', ')}]` : '*** NONE ***';
      console.log(
        pad(String(c.id), 6) + pad(normalizeProvider(c.provider), 18) + pad(c.label ?? '(no label)', 22) +
        pad(c.active ? 'yes' : 'NO', 8) + pad(canLabel ? 'yes' : 'no', 8) +
        (doVerify ? pad(credCell, 40) + verifyText : credCell),
      );
    }

    console.log(`\n=== 2) CONFIG READINESS — store/source accounts (marketplace confirmation)${doVerify ? ' [LIVE VERIFY]' : ''} ===`);
    console.log(
      pad('id', 6) + pad('provider', 18) + pad('nickname', 22) + pad('confirm', 16) +
      pad('credentials set', doVerify ? 40 : 0) + (doVerify ? 'live verify' : ''),
    );
    console.log('-'.repeat(doVerify ? 120 : 96));
    const stores = await sql<Array<{ id: number; provider: string; label: string | null; credentials: unknown }>>`
      SELECT id, provider, label, credentials FROM store_accounts ORDER BY provider, id
    `;
    for (const s of stores) {
      const keys = setCredentialKeys(s.credentials);
      const conf = sourceConfirmation(normalizeProvider(s.provider) as never);
      const hasCreds = keys.length > 0;
      if (conf.state === 'pending' && hasCreds) storeReady += 1;
      else if (conf.state === 'pending') storeMissing += 1;
      const verifyText = conf.state === 'pending' && hasCreds ? await liveVerify(s.provider, s.credentials) : '';
      if (verifyText.startsWith('verify=FAIL') || verifyText.startsWith('verify=ERROR')) storeVerifyFail += 1;
      const credCell = hasCreds ? `[${keys.join(', ')}]` : '*** NONE ***';
      console.log(
        pad(String(s.id), 6) + pad(normalizeProvider(s.provider), 18) + pad(s.label ?? '(no label)', 22) +
        pad(conf.state === 'pending' ? 'live' : conf.state, 16) +
        (doVerify ? pad(credCell, 40) + verifyText : credCell),
      );
    }

    console.log('\n=== SUMMARY ===');
    console.log(`Label-capable carrier accounts ready (active + credentials): ${carrierReady}`);
    if (carrierMissing > 0) console.log(`Label-capable carrier accounts MISSING credentials/active: ${carrierMissing}  <-- fix these`);
    console.log(`Marketplace-confirm accounts ready (credentials set): ${storeReady}`);
    if (storeMissing > 0) console.log(`Marketplace-confirm accounts MISSING credentials: ${storeMissing}  <-- fix these`);
    if (doVerify) {
      console.log(`Live credential verify failures: ${carrierVerifyFail + storeVerifyFail}` +
        (carrierVerifyFail + storeVerifyFail > 0 ? '  <-- these keys did not authenticate (likely expired/invalid)' : '  (all configured keys authenticated)'));
    } else {
      console.log('Run with --verify to confirm the saved keys actually AUTHENTICATE (read-only, no postage/orders).');
    }
    console.log('\nNote: ShipStation confirmation uses CLIENT-level credentials (not store_accounts);');
    console.log('this report does not include them. No orders were read or modified.');
  } finally {
    try { await sql.end({ timeout: 1 }); } catch { /* ignore */ }
  }
}

main().catch((err) => {
  console.error('connector health report failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
