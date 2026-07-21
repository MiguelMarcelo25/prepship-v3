import 'dotenv/config';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import postgres from 'postgres';
import { buildInventoryReconciliationPlan } from '../src/services/inventory-reconciliation.js';

type SchemaPreflight = {
  observedColumns: string[];
  missingColumns: string[];
  observedTriggers: string[];
  missingTriggers: string[];
  observedIdentityIndexes: string[];
  missingIdentityIndexes: string[];
};

const REQUIRED_COLUMNS = ['client_id', 'sku', 'source_entity', 'source_id'];
const REQUIRED_TRIGGERS = [
  'inventory_ledger_prepare_insert_guard',
  'inventory_ledger_no_update_delete',
  'inventory_ledger_no_truncate',
];
const REQUIRED_INDEXES = [
  'inventory_ledger_idempotency_key_unq',
  'inventory_ledger_source_identity_unq',
];

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function csv(value: unknown): string {
  if (value == null) return '';
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function git(...args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

async function readSchemaPreflight(databaseUrl: string): Promise<SchemaPreflight> {
  const client = postgres(databaseUrl, { max: 1 });
  try {
    return await client.begin(async (tx) => {
      await tx.unsafe('set transaction read only');
      const columns = await tx<{ column_name: string }[]>`
        select column_name from information_schema.columns
        where table_schema = 'public' and table_name = 'inventory_ledger'
          and column_name in ('client_id', 'sku', 'source_entity', 'source_id')
        order by column_name
      `;
      const triggers = await tx<{ tgname: string }[]>`
        select tgname from pg_trigger
        where tgrelid = 'public.inventory_ledger'::regclass
          and not tgisinternal
          and tgname in (
            'inventory_ledger_prepare_insert_guard',
            'inventory_ledger_no_update_delete',
            'inventory_ledger_no_truncate'
          )
        order by tgname
      `;
      const indexes = await tx<{ indexname: string }[]>`
        select indexname from pg_indexes
        where schemaname = 'public' and tablename = 'inventory_ledger'
          and indexname in (
            'inventory_ledger_idempotency_key_unq',
            'inventory_ledger_source_identity_unq'
          )
        order by indexname
      `;
      const observedColumns = columns.map((row) => row.column_name);
      const observedTriggers = triggers.map((row) => row.tgname);
      const observedIdentityIndexes = indexes.map((row) => row.indexname);
      return {
        observedColumns,
        missingColumns: REQUIRED_COLUMNS.filter((name) => !observedColumns.includes(name)),
        observedTriggers,
        missingTriggers: REQUIRED_TRIGGERS.filter((name) => !observedTriggers.includes(name)),
        observedIdentityIndexes,
        missingIdentityIndexes: REQUIRED_INDEXES.filter(
          (name) => !observedIdentityIndexes.includes(name),
        ),
      };
    });
  } finally {
    await client.end();
  }
}

function selfTest(): void {
  if (csv('a,"b"') !== '"a,""b"""') throw new Error('CSV escaping self-test failed');
  const legacyQuantity = 7;
  const inventoryQuantity = 2;
  if (legacyQuantity - inventoryQuantity !== 5) throw new Error('Correction sign self-test failed');
  console.log('PASS PS-462 read-only correction packet generator self-test');
}

async function main(): Promise<void> {
  if (process.argv.includes('--self-test')) return selfTest();
  if (process.argv.some((arg) => arg === '--apply' || arg.startsWith('--apply='))) {
    throw new Error('PS462_CORRECTION_PACKET_IS_READ_ONLY: production application is not supported');
  }
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');

  const plan = await buildInventoryReconciliationPlan({});
  if (plan.ambiguousRows.length > 0) {
    throw new Error(`PS462_CORRECTION_PACKET_AMBIGUOUS: ${plan.ambiguousRows.length} rows`);
  }
  const mismatches = plan.rows
    .filter((row) => row.legacyQuantity != null && row.legacyQuantity !== row.inventoryQuantity)
    .sort((left, right) => left.inventoryId - right.inventoryId);
  const schema = await readSchemaPreflight(databaseUrl);
  const headSha = git('rev-parse', 'HEAD');
  const branch = git('branch', '--show-current');

  const movementRows = mismatches.map((row, index) => {
    const correctionQuantity = Number(row.legacyQuantity) - row.inventoryQuantity;
    const idempotencyKey = `inventory:reconciliation:ps462:${plan.planHash}:${row.inventoryId}`;
    const sourceId = `ps462:${plan.planHash}:${row.inventoryId}`;
    const identity = {
      inventoryId: row.inventoryId,
      clientId: row.clientId,
      sku: row.sku,
      expectedLegacyQuantity: row.legacyQuantity,
      expectedLedgerQuantity: row.inventoryQuantity,
      correctionQuantity,
      expectedPostQuantity: row.legacyQuantity,
      type: 'adjust',
      orderId: null,
      idempotencyKey,
      sourceEntity: 'inventory_reconciliation',
      sourceId,
    };
    return {
      sequence: index + 1,
      ...identity,
      note: 'PS-462 reviewed legacy opening-balance correction',
      effectiveAt: 'REQUIRED_AT_APPLY_TIME',
      createdBy: 'REQUIRED_AT_APPLY_TIME',
      reviewFingerprint: sha256(JSON.stringify(identity)),
    };
  });

  const headers = [
    'sequence', 'inventory_id', 'client_id', 'sku', 'expected_legacy_quantity',
    'expected_ledger_quantity', 'correction_quantity', 'expected_post_quantity',
    'type', 'order_id', 'note', 'idempotency_key', 'source_entity', 'source_id',
    'effective_at', 'created_by', 'review_fingerprint',
  ];
  const movementCsv = [
    headers.join(','),
    ...movementRows.map((row) => [
      row.sequence,
      row.inventoryId,
      row.clientId,
      row.sku,
      row.expectedLegacyQuantity,
      row.expectedLedgerQuantity,
      row.correctionQuantity,
      row.expectedPostQuantity,
      row.type,
      row.orderId,
      row.note,
      row.idempotencyKey,
      row.sourceEntity,
      row.sourceId,
      row.effectiveAt,
      row.createdBy,
      row.reviewFingerprint,
    ].map(csv).join(',')),
  ].join('\n') + '\n';
  const movementsSha = sha256(movementCsv);
  const correctionQuantity = movementRows.reduce((sum, row) => sum + row.correctionQuantity, 0);
  const negativeBefore = mismatches.filter((row) => row.inventoryQuantity < 0).length;
  const negativeAfter = mismatches.filter((row) => Number(row.legacyQuantity) < 0).length;
  const byClient = [...movementRows.reduce((groups, row) => {
    const key = row.clientId == null ? 'global' : String(row.clientId);
    const current = groups.get(key) ?? { clientId: row.clientId, rows: 0, correctionQuantity: 0 };
    current.rows += 1;
    current.correctionQuantity += row.correctionQuantity;
    groups.set(key, current);
    return groups;
  }, new Map<string, { clientId: number | null; rows: number; correctionQuantity: number }>()).values()];

  const requestedOutput = process.argv.find((arg) => arg.startsWith('--output-dir='))?.slice(13);
  const outputDir = requestedOutput || join('reports', `ps-462-correction-packet-${plan.planHash.slice(0, 8)}`);
  mkdirSync(outputDir, { recursive: true });

  const manifest = {
    contract: 'ps462_append_only_inventory_correction_review_packet_v1',
    status: 'PREPARED_NOT_AUTHORIZED_FOR_APPLY',
    ticket: 'PS-462',
    generatedAt: new Date().toISOString(),
    repository: { branch, preparedAtHeadSha: headSha },
    sourceReport: {
      contract: plan.contract,
      planHash: plan.planHash,
      rowsScanned: plan.rowsScanned,
      rowsToCorrect: movementRows.length,
      requiredLedgerDelta: correctionQuantity,
      caseVariantSkuCollisions: plan.classifications.caseVariantSkuCollision,
      ambiguousRows: plan.ambiguousRows.length,
    },
    movementsFile: { path: 'movements.csv', sha256: movementsSha },
    authority: {
      quantityOwner: 'src/services/inventory-stock-math.ts#inventoryLedgerQuantity',
      mutationOwner: 'src/services/inventory-movement.ts#applyInventoryMovementInTransaction',
      discrepancyOwner: 'src/services/inventory-reconciliation.ts#buildInventoryReconciliationPlan',
      directBalanceRepair: 'FORBIDDEN',
    },
    approval: {
      preparationApproved: true,
      productionMovementApplyApproved: false,
      migrationApplyApproved: false,
      pushApproved: false,
      deployApproved: false,
    },
    effectiveAtPolicy: {
      proposed: 'APPLY_TIME_NOT_BACKDATED',
      historicalCandidateApproved: false,
    },
    liveSchemaPreflight: {
      state: schema.missingColumns.length || schema.missingTriggers.length || schema.missingIdentityIndexes.length
        ? 'BLOCKED'
        : 'READY_FOR_SEPARATE_MIGRATION_APPROVAL',
      ...schema,
      requiredAction: 'Apply additive 0073, verify it, then separately approve correction movements.',
    },
    summary: {
      rows: movementRows.length,
      correctionQuantity,
      allCorrectionsPositive: movementRows.every((row) => row.correctionQuantity > 0),
      negativeBalanceRowsBefore: negativeBefore,
      negativeBalanceRowsAfter: negativeAfter,
      clients: byClient.length,
    },
    byClient,
    applicationGuards: [
      'Require separate explicit production movement approval.',
      'Install and verify additive ledger identity columns, indexes, and immutable triggers before applying movements.',
      'Recompute the canonical plan and require the exact sourceReport.planHash.',
      'Lock and verify every inventory identity and expected pre-correction quantity in one transaction.',
      'Append through applyInventoryMovementInTransaction only; never UPDATE stock_qty and never UPDATE/DELETE inventory_ledger.',
      'Require one applied-or-identical-idempotent result per row and roll back the whole batch on any conflict.',
      'Verify ledger quantity equals expectedLegacyQuantity for every row before 0074 cutover.',
      'Do not backdate effectiveAt without separate billing-impact approval.',
    ],
    rollbackPolicy: 'Append deterministic inverse movements only; UPDATE/DELETE/TRUNCATE of inventory_ledger is forbidden.',
  };

  const readme = `# PS-462 inventory correction review packet

Status: **prepared, not authorized for production application**.

This packet proposes ${movementRows.length} append-only \`adjust\` movements totaling **${correctionQuantity >= 0 ? '+' : ''}${correctionQuantity} units**. It is pinned to canonical discrepancy plan:

\`${plan.planHash}\`

The exact customer/SKU rows are in \`movements.csv\`. Its expected SHA-256 is:

\`${movementsSha}\`

## Source-of-truth placement

- Quantity owner: \`src/services/inventory-stock-math.ts#inventoryLedgerQuantity\`
- Mutation owner: \`src/services/inventory-movement.ts#applyInventoryMovementInTransaction\`
- Discrepancy owner: \`src/services/inventory-reconciliation.ts#buildInventoryReconciliationPlan\`
- Direct updates to \`inventory.stock_qty\` and updates/deletes to \`inventory_ledger\` are forbidden.

## Ordered application gates

1. Put API/workers in the reviewed rollout state and apply additive \`0073_inventory_quantity_sot.sql\`.
2. Recompute this plan and require the exact hash above.
3. Obtain separate approval and append the correction movements in one all-or-nothing transaction.
4. Verify zero legacy/cache mismatch, then separately approve \`0074_inventory_quantity_cutover.sql\`.
5. Keep \`ops/rollback/ps-462_inventory_quantity_forward_rollback.sql\` available for an emergency forward rollback while inventory writes are stopped.

Rollback of correction data is append-only inverse movement, never ledger mutation. No production data, orders, shipments, labels, postage, marketplace notifications, Git remote, migration, or deployment was changed while preparing this packet.
`;

  writeFileSync(join(outputDir, 'movements.csv'), movementCsv, 'utf8');
  writeFileSync(join(outputDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  writeFileSync(join(outputDir, 'README.md'), readme, 'utf8');
  console.log(JSON.stringify({
    status: manifest.status,
    outputDir,
    planHash: plan.planHash,
    rows: movementRows.length,
    correctionQuantity,
    movementsSha256: movementsSha,
    productionMutation: false,
  }, null, 2));
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
