// PS-497 Slice 2 (Release A blocker 5) — proves the runtime-schema-readiness enrollment fails boot closed
// for every occurrence object the Drizzle mapping names, WITHOUT a live database. Starts from a complete
// catalog (every required object present → zero missing) and removes one object at a time, asserting the
// exact missing token is reported. Covers the three columns Hermes found omitted (id/created_at/updated_at)
// and the discriminator-kind CHECK, plus the S2.0 columns/indexes/constraints already claimed.
import assert from 'node:assert/strict';
import type { SchemaCatalog } from '../src/services/runtime-schema-readiness.js';

// runtime-schema-readiness imports the db client (env-validated at load); set offline env BEFORE importing,
// then pull the pure functions dynamically. This guard never touches a database.
process.env.VERCEL ??= '1';
process.env.DATABASE_URL ??= 'postgres://user:pass@localhost:5432/test';
process.env.SUPABASE_URL ??= 'http://localhost';

const { collectMissingSchemaObjects, requiredSchemaCatalogForTests } = await import(
  '../src/services/runtime-schema-readiness.js'
);

let passed = 0;
const ok = (m: string) => { passed += 1; console.log('ok   ' + m); };

function clone(base: SchemaCatalog): SchemaCatalog {
  return {
    relations: new Set(base.relations),
    columnsByTable: new Map(Array.from(base.columnsByTable, ([t, cols]) => [t, new Set(cols)])),
    indexes: new Set(base.indexes),
    constraints: new Set(base.constraints),
    functions: new Set(base.functions),
    triggers: new Set(base.triggers),
  };
}

// A complete catalog reports nothing missing.
{
  const complete = requiredSchemaCatalogForTests();
  assert.deepEqual(collectMissingSchemaObjects(complete), [], 'a complete catalog has zero missing objects');
  ok('complete required catalog → zero missing');
}

// Removing a required occurrence COLUMN is reported — including the three Hermes found omitted.
for (const col of ['id', 'created_at', 'updated_at', 'order_id', 'occurrence_key', 'discriminator_kind', 'first_seen_source', 'superseded_by_occurrence_id', 'effective_at', 'shipment_id'] as const) {
  const cat = clone(requiredSchemaCatalogForTests());
  cat.columnsByTable.get('fulfillment_occurrences')?.delete(col);
  const missing = collectMissingSchemaObjects(cat);
  assert.ok(missing.includes(`column:fulfillment_occurrences.${col}`), `missing occurrence column ${col} is reported`);
}
ok('every mapped fulfillment_occurrences column (incl. id/created_at/updated_at) fails boot when absent');

// Removing the occurrence projection columns on the two sidecars is reported.
for (const [table, col] of [
  ['order_lifecycle_events', 'occurrence_id'],
  ['fulfillment_line_claims', 'occurrence_id'],
  ['fulfillment_line_claims', 'canonical_line_identity'],
  ['fulfillment_line_claims', 'supply'],
] as const) {
  const cat = clone(requiredSchemaCatalogForTests());
  cat.columnsByTable.get(table)?.delete(col);
  assert.ok(collectMissingSchemaObjects(cat).includes(`column:${table}.${col}`), `missing ${table}.${col} is reported`);
}
ok('sidecar occurrence projection columns fail boot when absent');

// Removing a required occurrence CONSTRAINT is reported — including the kind CHECK Hermes found omitted.
for (const con of ['fulfillment_occurrences_kind_chk', 'fulfillment_line_claims_occ_identity_present_chk', 'fulfillment_line_claims_supply_chk'] as const) {
  const cat = clone(requiredSchemaCatalogForTests());
  cat.constraints.delete(con);
  assert.ok(collectMissingSchemaObjects(cat).includes(`constraint:${con}`), `missing constraint ${con} is reported`);
}
ok('occurrence constraints (incl. fulfillment_occurrences_kind_chk) fail boot when absent');

// The relation and the 0104 occurrence indexes fail boot when absent.
{
  const rel = clone(requiredSchemaCatalogForTests());
  rel.relations.delete('fulfillment_occurrences');
  assert.ok(collectMissingSchemaObjects(rel).includes('relation:fulfillment_occurrences'), 'missing occurrence relation reported');
  for (const idx of ['fulfillment_occurrences_key_unq', 'fulfillment_occurrences_order_idx', 'fulfillment_occurrences_shipment_unq', 'fulfillment_line_claims_occ_line_dir_unq', 'fulfillment_line_claims_reverse_original_unq'] as const) {
    const cat = clone(requiredSchemaCatalogForTests());
    cat.indexes.delete(idx);
    assert.ok(collectMissingSchemaObjects(cat).includes(`index:${idx}`), `missing index ${idx} reported`);
  }
}
ok('occurrence relation + 0104 indexes fail boot when absent');

// The old 0090 quantity_state_check is deliberately NOT enrolled (0105 replaces it): removing it from a
// catalog changes nothing, and it is never in the missing list.
{
  const complete = requiredSchemaCatalogForTests();
  assert.ok(!collectMissingSchemaObjects(complete).some((m) => m.includes('quantity_state_check')), '0090 quantity_state_check is not enrolled (0105 replaces it)');
}
ok('0090 quantity_state_check is intentionally not required (0105 replaces it) — no false post-0105 boot failure');

console.log(`\nPASS PS-497 readiness-enrollment — ${passed}/${passed} checks`);
