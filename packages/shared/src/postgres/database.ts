import postgres from "postgres";

let _sql: postgres.Sql | null = null;

const isServerless = !!process.env.VERCEL || !!process.env.AWS_LAMBDA_FUNCTION_NAME;

export function createPgClient(databaseUrl: string): postgres.Sql {
  if (!_sql) {
    _sql = postgres(databaseUrl, {
      ssl: "require",
      max: isServerless ? 1 : 10,
      idle_timeout: isServerless ? 10 : 20,
      connect_timeout: 10,
      transform: postgres.camel,
    });
  }
  return _sql;
}

export type PgClient = postgres.Sql;
