import { sql, type SQL } from 'drizzle-orm';

/**
 * PS-168: canonical client/store scope SQL primitives.
 *
 * `normalizeScopeIds` + `intArraySql` were previously DUPLICATED verbatim across the analysis, billing
 * (route + service), inventory, dashboard, print-queue, and reporting-metrics modules (6–7 byte-identical
 * copies). This is their single owner so the scope-filtering primitives cannot drift. Pure functions,
 * no DB/IO — safe to import anywhere.
 *
 * NOTE: the various `*ScopePredicate` helpers are intentionally NOT centralized here — they diverge
 * semantically (some return `SQL | undefined`, some `SQL`) and unifying them would change behavior.
 */

/** De-dupe + coerce a scope id list to positive integers (drops non-integers, <=0, and non-arrays). */
export function normalizeScopeIds(values: number[] | undefined): number[] {
  if (!Array.isArray(values)) return [];
  return Array.from(
    new Set(
      values
        .map((value) => Number(value))
        .filter((value) => Number.isInteger(value) && value > 0)
    )
  );
}

/** Build a Postgres `int[]` array literal from a list of numbers. */
export function intArraySql(values: number[]): SQL {
  return sql`array[${sql.join(values.map((value) => sql`${value}`), sql`, `)}]::int[]`;
}

/**
 * PS-509: same primitive for `text[]`. The drizzle `sql` template expands a JS array
 * parameter to a `($1, $2)` record — not an array — so `unnest(${list}::text[])` fails
 * with "cannot cast type record to text[]" (the exact defect intArraySql exists for).
 */
export function textArraySql(values: readonly string[]): SQL {
  return sql`array[${sql.join(values.map((value) => sql`${value}`), sql`, `)}]::text[]`;
}
