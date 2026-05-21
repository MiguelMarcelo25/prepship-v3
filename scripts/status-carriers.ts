import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { connectorCapabilityMatrix } from '../src/connectors/matrix';
import { connectorImplementationStatus } from '../src/connectors/implementation-status';
import type { ConnectorCapability, ConnectorProvider } from '../src/connectors/types';

type ConnectorKind = 'carrier' | 'store' | 'carrier+store' | 'matrix_only';
type StatusValue = 'live' | 'registered_stub' | 'blocked_external_contract' | 'missing_status';

type StatusRow = {
  provider: string;
  type: ConnectorKind;
  status: StatusValue;
  capabilities: ConnectorCapability[];
  notes: string;
  registeredCarrier: boolean;
  registeredStore: boolean;
  failures: string[];
};

const args = new Set(process.argv.slice(2));
const jsonMode = args.has('--json');
const checkMode = args.has('--check');

function read(path: string): string {
  const absolutePath = resolve(path);
  if (!existsSync(absolutePath)) {
    throw new Error(`missing ${path}`);
  }
  return readFileSync(absolutePath, 'utf8');
}

function registryKeys(source: string, exportName: 'carrierConnectors' | 'storeConnectors'): Set<string> {
  const match = source.match(new RegExp(`export const ${exportName} = \\{([\\s\\S]*?)\\};`));
  if (!match) {
    throw new Error(`missing ${exportName} registry`);
  }

  const keys = [...match[1].matchAll(/^\s*([a-zA-Z0-9_]+):/gm)].map((entry) => entry[1]);
  return new Set(keys);
}

function connectorType(registeredCarrier: boolean, registeredStore: boolean): ConnectorKind {
  if (registeredCarrier && registeredStore) return 'carrier+store';
  if (registeredCarrier) return 'carrier';
  if (registeredStore) return 'store';
  return 'matrix_only';
}

function validateRow(row: StatusRow): string[] {
  const failures: string[] = [];

  if (row.status === 'missing_status') {
    failures.push('missing implementation status');
  }
  if (row.capabilities.length === 0) {
    failures.push('missing capability matrix entry');
  }
  if ((row.registeredCarrier || row.registeredStore) && row.status === 'blocked_external_contract') {
    failures.push('blocked connector should not be registered as active');
  }
  if (row.status === 'live' && !row.registeredCarrier && !row.registeredStore) {
    failures.push('live connector is not registered');
  }
  if (row.status === 'registered_stub' && !row.registeredCarrier && !row.registeredStore) {
    failures.push('registered stub is not present in a registry');
  }

  return failures;
}

function buildRows(): StatusRow[] {
  const registrySource = read('src/connectors/registry.ts');
  const carrierConnectors = registryKeys(registrySource, 'carrierConnectors');
  const storeConnectors = registryKeys(registrySource, 'storeConnectors');
  const providers = new Set<string>([
    ...Object.keys(connectorCapabilityMatrix),
    ...Object.keys(connectorImplementationStatus),
    ...carrierConnectors,
    ...storeConnectors,
  ]);

  return [...providers].sort().map((provider) => {
    const typedProvider = provider as ConnectorProvider;
    const implementation = connectorImplementationStatus[typedProvider];
    const registeredCarrier = carrierConnectors.has(provider);
    const registeredStore = storeConnectors.has(provider);
    const row: StatusRow = {
      provider,
      type: connectorType(registeredCarrier, registeredStore),
      status: implementation?.status ?? 'missing_status',
      capabilities: connectorCapabilityMatrix[typedProvider] ?? [],
      notes: implementation?.notes ?? 'Missing implementation status entry.',
      registeredCarrier,
      registeredStore,
      failures: [],
    };

    row.failures = validateRow(row);
    return row;
  });
}

function summarize(rows: StatusRow[]) {
  return rows.reduce(
    (summary, row) => {
      summary.total += 1;
      summary[row.status] += 1;
      if (row.registeredCarrier) summary.registeredCarriers += 1;
      if (row.registeredStore) summary.registeredStores += 1;
      summary.failures += row.failures.length;
      return summary;
    },
    {
      total: 0,
      live: 0,
      registered_stub: 0,
      blocked_external_contract: 0,
      missing_status: 0,
      registeredCarriers: 0,
      registeredStores: 0,
      failures: 0,
    },
  );
}

function printTable(rows: StatusRow[]) {
  const columns = [
    { label: 'Provider', width: 18, value: (row: StatusRow) => row.provider },
    { label: 'Type', width: 14, value: (row: StatusRow) => row.type },
    { label: 'Status', width: 27, value: (row: StatusRow) => row.status },
    { label: 'Capabilities', width: 72, value: (row: StatusRow) => row.capabilities.join(', ') },
  ];
  const header = columns.map((column) => column.label.padEnd(column.width)).join(' ');
  const divider = columns.map((column) => '-'.repeat(column.width)).join(' ');

  console.log('PrepShip Connector Status');
  console.log(header);
  console.log(divider);
  for (const row of rows) {
    console.log(columns.map((column) => column.value(row).padEnd(column.width)).join(' '));
    if (row.failures.length > 0) {
      console.log(`  failures: ${row.failures.join('; ')}`);
    }
  }
}

const rows = buildRows();
const summary = summarize(rows);
const failures = rows.flatMap((row) => row.failures.map((failure) => `${row.provider}: ${failure}`));

if (jsonMode) {
  console.log(JSON.stringify({ summary, rows, failures }, null, 2));
} else {
  printTable(rows);
  console.log('');
  console.log(
    `Summary: total=${summary.total} live=${summary.live} registered_stub=${summary.registered_stub} blocked_external_contract=${summary.blocked_external_contract} carrier_registry=${summary.registeredCarriers} store_registry=${summary.registeredStores} failures=${summary.failures}`,
  );
}

if (checkMode && failures.length > 0) {
  console.error('');
  console.error('Connector status check failed:');
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exitCode = 1;
}
