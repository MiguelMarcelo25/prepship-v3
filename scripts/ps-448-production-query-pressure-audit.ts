/**
 * PS-448 read-only production query-pressure snapshot.
 *
 * The caller must provide PS448_DATABASE_URL for this process only. This script
 * reads aggregate pg_stat_statements metadata; it never reads application rows
 * and contains no INSERT, UPDATE, DELETE, DDL, or provider request path.
 */
import { createHash } from 'node:crypto'
import postgres from 'postgres'

const databaseUrl = process.env.PS448_DATABASE_URL?.trim()
if (!databaseUrl) {
  throw new Error('PS448_DATABASE_URL is required for the read-only PS-448 audit')
}

const sql = postgres(databaseUrl, {
  max: 1,
  idle_timeout: 5,
  connect_timeout: 10,
})

try {
  const [info] = await sql<{ statsReset: Date }[]>`
    SELECT stats_reset AS "statsReset"
    FROM pg_stat_statements_info
  `
  const statements = await sql<{
    queryId: string
    calls: string
    meanMs: string
    returnedRows: string
    query: string
  }[]>`
    SELECT
      queryid::text AS "queryId",
      calls::bigint::text AS calls,
      ROUND(mean_exec_time::numeric, 2)::text AS "meanMs",
      rows::bigint::text AS "returnedRows",
      query
    FROM pg_stat_statements AS pss
    WHERE LOWER(pss.query) LIKE '%orders%'
    ORDER BY pss.calls DESC
    LIMIT 20
  `

  console.log(JSON.stringify({
    capturedAt: new Date().toISOString(),
    statsReset: info?.statsReset ? new Date(info.statsReset).toISOString() : null,
    statements: statements.map((row) => {
      const normalized = row.query.replace(/\s+/g, ' ').trim()
      return {
        fingerprint: createHash('sha256').update(normalized).digest('hex').slice(0, 12),
        queryId: row.queryId,
        calls: Number(row.calls),
        meanMs: Number(row.meanMs),
        returnedRows: Number(row.returnedRows),
        shape: normalized.slice(0, 180),
      }
    }),
  }))
} finally {
  await sql.end({ timeout: 2 })
}
