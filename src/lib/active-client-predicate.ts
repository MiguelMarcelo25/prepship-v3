// PS-132 (old PS-141): single source for the "active, non-test client" SQL predicates that
// were copy-pasted as raw SQL across analytics/billing/dashboard/clients routes.
//
// Two distinct shapes existed in the codebase — BOTH are preserved EXACTLY here (the helpers
// render byte-identical SQL, so behavior is unchanged; the ps-132 guard asserts this):
//
//   1. INCLUSION:  `coalesce(<alias>.active, true) = true`
//      "client is active (a NULL active flag counts as active)". Used in WHERE/EXISTS.
//   2. EXCLUSION:  `(<alias>.is_test = true or coalesce(<alias>.active, true) = false)`
//      "client is a test client OR inactive". Used inside NOT EXISTS to drop those orders.
//
// Aliases are hardcoded literals supplied by the caller (c / owner_client / visible_client),
// so embedding them is injection-safe. Embed via `${sql.raw(activeClientPredicateSql('c'))}`,
// mirroring the existing EXCLUDED_STORE_IDS_SQL pattern.
//
// NOTE: the stricter Drizzle-builder predicate `eq(clients.active, true)` (no coalesce, no
// is_test) is a DIFFERENT rule and is intentionally NOT replaced by these helpers.

/** `coalesce(<alias>.active, true) = true` — client is active (NULL = active). */
export function activeClientPredicateSql(alias = 'c'): string {
  return `coalesce(${alias}.active, true) = true`;
}

/** `(<alias>.is_test = true or coalesce(<alias>.active, true) = false)` — test OR inactive. */
export function testOrInactiveClientPredicateSql(alias = 'c'): string {
  return `(${alias}.is_test = true or coalesce(${alias}.active, true) = false)`;
}
