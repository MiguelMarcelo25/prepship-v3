#!/usr/bin/env tsx
/**
 * Live, non-purchase go/no-go probe for ShipStation `carrier_ids` batching.
 *
 * Safety:
 * - Calls only GET /v2/carriers and POST /v2/rates/estimate.
 * - Never creates labels, updates orders, writes shipments, or notifies marketplaces.
 * - Never prints API keys; credential sources are identified by source key + hash prefix.
 * - Requires both `--live` and an explicit credential source selection.
 *
 * Recommended production run before enabling SHIPSTATION_BATCHED_RATE_FANOUT:
 *   npm run probe:shipstation-batched-rate-estimate -- --live --source=all
 */
import 'dotenv/config';
import assert from 'node:assert/strict';
import {
  KNOWN_CARRIER_ACCOUNTS,
  carrierIdForProvider,
} from '../src/lib/carrier-account-registry';

type Money = { amount?: number | string | null };
type ProbeRate = {
  carrier_id?: string | null;
  carrier_code?: string | null;
  service_code?: string | null;
  service_type?: string | null;
  package_type?: string | null;
  shipping_amount?: Money | null;
  other_amount?: Money | null;
  insurance_amount?: Money | null;
  confirmation_amount?: Money | null;
};

type Carrier = {
  carrier_id?: string | null;
  carrier_code?: string | null;
  nickname?: string | null;
  friendly_name?: string | null;
  disabled_by_billing_plan?: boolean | null;
};

type ProbeOptions = {
  live: boolean;
  selfTest: boolean;
  help: boolean;
  sourceKeys: string[];
  carrierIds: string[];
  maxCarriers: number;
  timeoutMs: number;
  fromPostalCode: string;
  toPostalCode: string;
  weightOz: number;
  lengthIn: number;
  widthIn: number;
  heightIn: number;
};

type CarrierComparison = {
  carrierId: string;
  singleCount: number;
  batchCount: number;
  missingFromBatch: string[];
  batchOnly: string[];
  match: boolean;
};

const RATEABLE_CARRIER_CODES = new Set([
  'usps',
  'ups',
  'ups_walleted',
  'fedex',
  'fedex_walleted',
  'dhl_express',
  'stamps_com',
]);

const PRIMARY_UPS_CARRIER_IDS = KNOWN_CARRIER_ACCOUNTS
  .filter((account) => account.clientId === null)
  .filter((account) => account.carrierCode === 'ups' || account.carrierCode === 'ups_walleted')
  .map((account) => carrierIdForProvider(account.shippingProviderId));
const MIN_PRIMARY_UPS_ACCOUNTS = 2;

const usage = `
ShipStation batched-rate estimate probe (no purchases or order mutations)

Usage:
  npm run probe:shipstation-batched-rate-estimate -- --self-test
  npm run probe:shipstation-batched-rate-estimate -- --live --source=all
  npm run probe:shipstation-batched-rate-estimate -- --live --source=env:primary --source=env:kfg
  npm run probe:shipstation-batched-rate-estimate -- --live --source=client:123 --carrier-ids=se-1,se-2

Options:
  --live                     Required for provider calls.
  --source=<key>             Repeatable. all | env:primary | env:kfg | client:<id>.
  --carrier-ids=<ids>        Optional comma-separated carrier IDs (must belong to each source).
  --max-carriers=<2..20>     Auto-selected carriers per source (default 8).
  --timeout-ms=<ms>          Per provider request (default 15000; min 3000, max 90000).
  --from-postal=<zip>        Default 90248.
  --to-postal=<zip>          Default 29707.
  --weight-oz=<n>            Default 87.
  --dimensions=<LxWxH>       Inches, default 11x8x5.
  --self-test                Offline comparison-contract proof; makes no DB/provider calls.
`;

function valueAfterEquals(arg: string, name: string): string {
  const value = arg.slice(name.length + 1).trim();
  if (!value) throw new Error(`${name} requires a value`);
  return value;
}

function finiteNumber(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be a finite number`);
  return parsed;
}

function parseArgs(argv: string[]): ProbeOptions {
  const result: ProbeOptions = {
    live: false,
    selfTest: false,
    help: false,
    sourceKeys: [],
    carrierIds: [],
    maxCarriers: 8,
    timeoutMs: 15_000,
    fromPostalCode: '90248',
    toPostalCode: '29707',
    weightOz: 87,
    lengthIn: 11,
    widthIn: 8,
    heightIn: 5,
  };

  for (const arg of argv) {
    if (arg === '--live') result.live = true;
    else if (arg === '--self-test') result.selfTest = true;
    else if (arg === '--help' || arg === '-h') result.help = true;
    else if (arg.startsWith('--source=')) {
      result.sourceKeys.push(...valueAfterEquals(arg, '--source').split(',').map((value) => value.trim()).filter(Boolean));
    } else if (arg.startsWith('--carrier-ids=')) {
      result.carrierIds.push(...valueAfterEquals(arg, '--carrier-ids').split(',').map((value) => value.trim()).filter(Boolean));
    } else if (arg.startsWith('--max-carriers=')) {
      result.maxCarriers = finiteNumber(valueAfterEquals(arg, '--max-carriers'), '--max-carriers');
    } else if (arg.startsWith('--timeout-ms=')) {
      result.timeoutMs = finiteNumber(valueAfterEquals(arg, '--timeout-ms'), '--timeout-ms');
    } else if (arg.startsWith('--from-postal=')) {
      result.fromPostalCode = valueAfterEquals(arg, '--from-postal');
    } else if (arg.startsWith('--to-postal=')) {
      result.toPostalCode = valueAfterEquals(arg, '--to-postal');
    } else if (arg.startsWith('--weight-oz=')) {
      result.weightOz = finiteNumber(valueAfterEquals(arg, '--weight-oz'), '--weight-oz');
    } else if (arg.startsWith('--dimensions=')) {
      const dimensions = valueAfterEquals(arg, '--dimensions').split(/[xX]/).map(Number);
      if (dimensions.length !== 3 || dimensions.some((value) => !Number.isFinite(value))) {
        throw new Error('--dimensions must use LxWxH, for example 11x8x5');
      }
      [result.lengthIn, result.widthIn, result.heightIn] = dimensions as [number, number, number];
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  result.sourceKeys = [...new Set(result.sourceKeys)];
  result.carrierIds = [...new Set(result.carrierIds)];
  if (!Number.isInteger(result.maxCarriers) || result.maxCarriers < 2 || result.maxCarriers > 20) {
    throw new Error('--max-carriers must be an integer from 2 through 20');
  }
  if (!Number.isInteger(result.timeoutMs) || result.timeoutMs < 3_000 || result.timeoutMs > 90_000) {
    throw new Error('--timeout-ms must be an integer from 3000 through 90000');
  }
  if (![result.weightOz, result.lengthIn, result.widthIn, result.heightIn].every((value) => value > 0)) {
    throw new Error('weight and dimensions must be greater than zero');
  }
  for (const [name, postalCode] of [['--from-postal', result.fromPostalCode], ['--to-postal', result.toPostalCode]]) {
    if (!/^\d{5}(?:-\d{4})?$/.test(postalCode)) throw new Error(`${name} must be a US ZIP or ZIP+4`);
  }
  if (result.sourceKeys.includes('all') && result.sourceKeys.length > 1) {
    throw new Error('--source=all cannot be combined with another --source');
  }
  return result;
}

function moneySignature(money: Money | null | undefined): string {
  const raw = money?.amount;
  if (raw === null || raw === undefined) return 'missing';
  const value = typeof raw === 'string' ? raw.trim() : raw;
  const numeric = Number(value);
  return value !== '' && Number.isFinite(numeric) ? String(numeric) : `invalid:${String(raw)}`;
}

function rateSignature(rate: ProbeRate): string {
  return [
    String(rate.carrier_id ?? ''),
    String(rate.service_code ?? ''),
    String(rate.package_type ?? ''),
    moneySignature(rate.shipping_amount),
    moneySignature(rate.other_amount),
    moneySignature(rate.insurance_amount),
    moneySignature(rate.confirmation_amount),
  ].join('|');
}

function signatureDifference(left: string[], right: string[]): string[] {
  const available = new Map<string, number>();
  for (const signature of right) available.set(signature, (available.get(signature) ?? 0) + 1);
  return left.filter((signature) => {
    const count = available.get(signature) ?? 0;
    if (count <= 0) return true;
    available.set(signature, count - 1);
    return false;
  });
}

function compareBatchAgainstSingles(
  carrierIds: string[],
  batchRates: ProbeRate[],
  singleRatesByCarrier: Map<string, ProbeRate[]>,
): { rejectedBatchRows: number; comparisons: CarrierComparison[]; go: boolean } {
  const requested = new Set(carrierIds);
  const batchByCarrier = new Map(carrierIds.map((carrierId) => [carrierId, [] as ProbeRate[]]));
  let rejectedBatchRows = 0;
  for (const rate of batchRates) {
    const carrierId = String(rate.carrier_id ?? '').trim();
    if (!requested.has(carrierId)) {
      rejectedBatchRows += 1;
      continue;
    }
    batchByCarrier.get(carrierId)!.push(rate);
  }

  const comparisons = carrierIds.map((carrierId): CarrierComparison => {
    const single = (singleRatesByCarrier.get(carrierId) ?? []).map(rateSignature).sort();
    const batch = (batchByCarrier.get(carrierId) ?? []).map(rateSignature).sort();
    const missingFromBatch = signatureDifference(single, batch);
    const batchOnly = signatureDifference(batch, single);
    return {
      carrierId,
      singleCount: single.length,
      batchCount: batch.length,
      missingFromBatch,
      batchOnly,
      match: missingFromBatch.length === 0 && batchOnly.length === 0,
    };
  });

  return {
    rejectedBatchRows,
    comparisons,
    go: rejectedBatchRows === 0 && comparisons.every((comparison) => comparison.match),
  };
}

function runSelfTest(): void {
  const carrierIds = ['se-1', 'se-2'];
  const singleRates = new Map<string, ProbeRate[]>([
    ['se-1', stampSingleCarrierRates('se-1', [{
      service_code: 'ups_ground',
      package_type: 'package',
      shipping_amount: { amount: 8.25 },
      other_amount: { amount: 1 },
      insurance_amount: { amount: 0.5 },
      confirmation_amount: { amount: 0.25 },
    }])],
    ['se-2', stampSingleCarrierRates('se-2', [{
      service_code: 'usps_priority',
      package_type: 'package',
      shipping_amount: { amount: 9.1 },
      other_amount: { amount: 0 },
      insurance_amount: { amount: 0 },
      confirmation_amount: { amount: 0 },
    }])],
  ]);
  const pass = compareBatchAgainstSingles(carrierIds, [...singleRates.values()].flat(), singleRates);
  assert.equal(pass.go, true);

  const offsettingMoneyDrift = compareBatchAgainstSingles(
    carrierIds,
    [...singleRates.values()].flat().map((rate) => rate.carrier_id === 'se-1'
      ? { ...rate, shipping_amount: { amount: 9.25 }, other_amount: { amount: 0 } }
      : rate),
    singleRates,
  );
  assert.equal(
    offsettingMoneyDrift.go,
    false,
    'equal totals must not hide drift between shipping, other, insurance, or confirmation amounts',
  );

  const missing = compareBatchAgainstSingles(carrierIds, singleRates.get('se-1')!, singleRates);
  assert.equal(missing.go, false);
  assert.equal(missing.comparisons.find((row) => row.carrierId === 'se-2')?.missingFromBatch.length, 1);
  const unattributed = compareBatchAgainstSingles(
    carrierIds,
    [...singleRates.values()].flat().concat({ service_code: 'unknown', shipping_amount: { amount: 1 } }),
    singleRates,
  );
  assert.equal(unattributed.go, false);
  assert.equal(unattributed.rejectedBatchRows, 1);

  const primaryUpsCarriers: Carrier[] = PRIMARY_UPS_CARRIER_IDS.map((carrierId, index) => ({
    carrier_id: carrierId,
    carrier_code: index === 0 ? 'ups_walleted' : 'ups',
  }));
  const livePrimaryUpsCarriers = primaryUpsCarriers.filter((carrier) => carrier.carrier_id !== 'se-604209');
  const selectedPrimary = chooseCarriers(
    livePrimaryUpsCarriers.concat({ carrier_id: 'se-usps', carrier_code: 'stamps_com' }),
    parseArgs([]),
    'env:primary',
  );
  assert.deepEqual(
    selectedPrimary.slice(0, livePrimaryUpsCarriers.length).map((carrier) => carrier.carrier_id),
    livePrimaryUpsCarriers.map((carrier) => carrier.carrier_id),
    'DR PREPPER auto-selection must include every live UPS account',
  );
  assert.throws(
    () => chooseCarriers(livePrimaryUpsCarriers.slice(0, 1), parseArgs([]), 'env:primary'),
    /requires at least 2 live UPS accounts/,
    'DR PREPPER probe must fail closed without a genuine multi-UPS case',
  );
  assert.throws(
    () => chooseCarriers(primaryUpsCarriers, { ...parseArgs([]), maxCarriers: 5 }, 'env:primary'),
    /requires --max-carriers >= 6 to cover every live UPS account/,
    'DR PREPPER probe must never truncate live UPS account coverage',
  );
  console.log('PASS batched-rate live probe comparison self-test (no DB/provider calls)');
}

function chooseCarriers(carriers: Carrier[], options: ProbeOptions, sourceKey: string): Carrier[] {
  const eligible = carriers
    .filter((carrier) => !carrier.disabled_by_billing_plan)
    .filter((carrier) => RATEABLE_CARRIER_CODES.has(String(carrier.carrier_code ?? '').toLowerCase()))
    .filter((carrier) => Boolean(String(carrier.carrier_id ?? '').trim()))
    .sort((left, right) => String(left.carrier_id).localeCompare(String(right.carrier_id)));
  const byId = new Map(eligible.map((carrier) => [String(carrier.carrier_id), carrier]));
  if (!options.carrierIds.length) {
    if (sourceKey !== 'env:primary') return eligible.slice(0, options.maxCarriers);
    const primaryUps = eligible.filter((carrier) => {
      const code = String(carrier.carrier_code ?? '').toLowerCase();
      return code === 'ups' || code === 'ups_walleted';
    });
    if (primaryUps.length < MIN_PRIMARY_UPS_ACCOUNTS) {
      throw new Error(
        `env:primary has ${primaryUps.length} live UPS account(s); the rollout probe requires at least ${MIN_PRIMARY_UPS_ACCOUNTS} live UPS accounts`,
      );
    }
    if (options.maxCarriers < primaryUps.length) {
      throw new Error(
        `env:primary requires --max-carriers >= ${primaryUps.length} to cover every live UPS account`,
      );
    }
    const knownUpsOrder = new Map(PRIMARY_UPS_CARRIER_IDS.map((carrierId, index) => [carrierId, index]));
    const prioritizedUps = primaryUps.sort((left, right) => {
      const leftOrder = knownUpsOrder.get(String(left.carrier_id)) ?? Number.MAX_SAFE_INTEGER;
      const rightOrder = knownUpsOrder.get(String(right.carrier_id)) ?? Number.MAX_SAFE_INTEGER;
      return leftOrder - rightOrder || String(left.carrier_id).localeCompare(String(right.carrier_id));
    });
    const primaryUpsIds = new Set(prioritizedUps.map((carrier) => String(carrier.carrier_id)));
    return prioritizedUps.concat(
      eligible.filter((carrier) => !primaryUpsIds.has(String(carrier.carrier_id))),
    ).slice(0, options.maxCarriers);
  }
  const missing = options.carrierIds.filter((carrierId) => !byId.has(carrierId));
  if (missing.length) {
    throw new Error(`requested carrier IDs are unavailable or not generic-rate eligible: ${missing.join(', ')}`);
  }
  return options.carrierIds.map((carrierId) => byId.get(carrierId)!);
}

function unwrapRates(payload: ProbeRate[] | { rates?: ProbeRate[] }): ProbeRate[] {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.rates)) return payload.rates;
  throw new Error('ShipStation returned an unexpected rate-estimate response shape');
}

function stampSingleCarrierRates(carrierId: string, rates: ProbeRate[]): ProbeRate[] {
  return rates.map((rate) => ({ ...rate, carrier_id: rate.carrier_id || carrierId }));
}

async function runLive(options: ProbeOptions): Promise<void> {
  if (!options.live) throw new Error('refusing provider calls without --live');
  if (!options.sourceKeys.length) throw new Error('select --source=all or at least one explicit credential source');

  const [{ loadShipStationCarrierAccountSources }, { ssRequest }, { sql }] = await Promise.all([
    import('../src/services/shipstation-carrier-account-snapshots'),
    import('../src/lib/shipstation/client'),
    import('../src/db/client'),
  ]);

  try {
    const loaded = await loadShipStationCarrierAccountSources();
    if (options.sourceKeys.includes('all') && loaded.dbError) {
      throw new Error('credential-source discovery is incomplete; check database connectivity before probing all sources');
    }
    const bySourceKey = new Map(loaded.sources.map((source) => [source.sourceKey, source]));
    const selected = options.sourceKeys.includes('all')
      ? loaded.sources
      : options.sourceKeys.map((sourceKey) => {
          const source = bySourceKey.get(sourceKey);
          if (!source) throw new Error(`credential source not found: ${sourceKey}`);
          return source;
        });
    if (!selected.length) throw new Error('no distinct ShipStation v2 credential sources were found');

    console.log(`Live probe: ${selected.length} distinct credential source(s); no purchase or order mutation endpoints are called.`);
    let allGo = true;
    for (const source of selected) {
      console.log(`\n[${source.sourceKey}] ${source.keySource}; key sha256=${source.credentialFingerprint.slice(0, 12)}…`);
      const carriersPayload = await ssRequest<{ carriers?: Carrier[] }>('/v2/carriers', {
        apiKey: source.apiKeyV2,
        maxRetries: 1,
        timeoutMs: options.timeoutMs,
        priority: 'interactive',
      });
      const carriers = chooseCarriers(carriersPayload.carriers ?? [], options, source.sourceKey);
      if (carriers.length < 2) {
        throw new Error(`${source.sourceKey} has only ${carriers.length} generic-rate eligible carrier account(s); batching needs at least 2`);
      }
      const carrierIds = carriers.map((carrier) => String(carrier.carrier_id));
      console.log(`  carriers (${carrierIds.length}): ${carriers.map((carrier) => `${carrier.carrier_code}:${carrier.carrier_id}`).join(', ')}`);

      const baseBody = {
        from_country_code: 'US',
        from_postal_code: options.fromPostalCode,
        to_country_code: 'US',
        to_postal_code: options.toPostalCode,
        weight: { value: options.weightOz, unit: 'ounce' },
        dimensions: {
          length: options.lengthIn,
          width: options.widthIn,
          height: options.heightIn,
          unit: 'inch',
        },
        address_residential_indicator: 'yes',
        ship_date: new Date().toISOString(),
      };
      const requestRates = async (ids: string[]) => unwrapRates(await ssRequest<ProbeRate[] | { rates?: ProbeRate[] }>('/v2/rates/estimate', {
        method: 'POST',
        body: { ...baseBody, carrier_ids: ids },
        apiKey: source.apiKeyV2,
        maxRetries: 1,
        timeoutMs: options.timeoutMs,
        priority: 'interactive',
      }));

      const batchRates = await requestRates(carrierIds);
      const singles = new Map<string, ProbeRate[]>();
      for (const carrierId of carrierIds) {
        // ShipStation may omit carrier_id on a single-account estimate. The
        // production fallback safely stamps that known request identity too;
        // only the multi-account response is required to self-attribute rows.
        singles.set(
          carrierId,
          stampSingleCarrierRates(carrierId, await requestRates([carrierId])),
        );
      }
      const comparison = compareBatchAgainstSingles(carrierIds, batchRates, singles);
      for (const row of comparison.comparisons) {
        console.log(
          `  ${row.match ? 'MATCH' : 'MISMATCH'} ${row.carrierId}: batch=${row.batchCount}, single=${row.singleCount}`,
        );
        for (const signature of row.missingFromBatch.slice(0, 5)) console.log(`    missing batch: ${signature}`);
        for (const signature of row.batchOnly.slice(0, 5)) console.log(`    batch only:    ${signature}`);
      }
      if (comparison.rejectedBatchRows) console.log(`  rejected/unattributed batch rows: ${comparison.rejectedBatchRows}`);
      console.log(`  RESULT ${comparison.go ? 'GO' : 'NO-GO'} for ${source.sourceKey}`);
      allGo &&= comparison.go;
    }

    if (!allGo) throw new Error('NO-GO: batch and single rate sets differ; leave SHIPSTATION_BATCHED_RATE_FANOUT disabled');
    console.log('\nGO: every selected credential source returned identical attributed batch and single rate sets.');
  } finally {
    await sql.end({ timeout: 2 });
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage.trim());
    return;
  }
  if (options.selfTest) {
    if (options.live) throw new Error('--self-test cannot be combined with --live');
    runSelfTest();
    return;
  }
  await runLive(options);
}

main().catch((error) => {
  console.error(`FAIL batched-rate estimate probe: ${error instanceof Error ? error.message : String(error)}`);
  console.error(usage.trim());
  process.exitCode = 1;
});
