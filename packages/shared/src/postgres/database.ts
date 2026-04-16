import postgres from "postgres";

let _sql: postgres.Sql | null = null;

export function createPgClient(databaseUrl: string): postgres.Sql {
  if (!_sql) {
    _sql = postgres(databaseUrl, {
      ssl: "require",
      max: 10,
      idle_timeout: 20,
      connect_timeout: 10,
      transform: postgres.camel,
    });
  }
  return _sql;
}

export type PgClient = postgres.Sql;
