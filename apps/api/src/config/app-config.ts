import { defaultSecretsPath, loadTransitionalSecrets, type TransitionalSecrets } from "../../../../packages/shared/src/config/secrets-adapter.js";

export type DbProvider = "sqlite" | "memory" | "postgres";

export interface AppConfig {
  port: number;
  dbProvider: DbProvider;
  sqliteDbPath: string | null;
  databaseUrl: string | null;
  secretsPath: string;
  workerSyncEnabled: boolean;
  secrets: TransitionalSecrets;
  sessionToken: string;
}

function parseBooleanFlag(value: string | undefined, fallback: boolean): boolean {
  if (value == null) return fallback;
  return value === "1" || value.toLowerCase() === "true";
}

export function loadAppConfig(env = process.env): AppConfig {
  const dbProvider = (env.DB_PROVIDER ?? "sqlite") as DbProvider;
  const sqliteDbPath = env.SQLITE_DB_PATH;
  const databaseUrl = env.DATABASE_URL ?? null;

  if (dbProvider !== "sqlite" && dbProvider !== "memory" && dbProvider !== "postgres") {
    throw new Error(`Unsupported DB_PROVIDER: ${dbProvider}`);
  }

  if (dbProvider === "sqlite" && !sqliteDbPath) {
    throw new Error("SQLITE_DB_PATH is required when DB_PROVIDER=sqlite");
  }

  if (dbProvider === "postgres" && !databaseUrl) {
    throw new Error("DATABASE_URL is required when DB_PROVIDER=postgres");
  }

  const secretsPath = env.PREPSHIP_SECRETS_PATH ?? defaultSecretsPath(env);

  // SESSION_TOKEN must be set in production. In dev, fall back to a fixed
  // dev-only token so the server can still start without manual config.
  const isProduction = env.NODE_ENV === "production";
  const sessionToken = env.SESSION_TOKEN;
  
  if (isProduction && !sessionToken) {
    throw new Error("SESSION_TOKEN is required in production environment");
  }

  const fallbackToken = sessionToken ?? "dev-only-insecure-token-change-me";

  return {
    port: Number.parseInt(env.API_PORT ?? "4010", 10),
    dbProvider,
    sqliteDbPath: sqliteDbPath ?? null,
    databaseUrl,
    secretsPath,
    workerSyncEnabled: parseBooleanFlag(env.WORKER_SYNC_ENABLED, false),
    secrets: loadTransitionalSecrets(secretsPath),
    sessionToken: fallbackToken,
  };
}
