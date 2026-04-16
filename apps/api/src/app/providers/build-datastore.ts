import type { AppConfig } from "../../config/app-config.js";
import { EXCLUDED_STORE_IDS } from "../../common/prepship-config.js";
import type { ApiDataStore } from "../datastore.js";
import { createMemoryDataStore, type MemoryDataStoreSeed } from "./memory-datastore.js";

export async function buildDataStore(config: AppConfig, memorySeed?: MemoryDataStoreSeed): Promise<ApiDataStore> {
  if (config.dbProvider === "memory") {
    return createMemoryDataStore(memorySeed);
  }

  if (config.dbProvider === "postgres") {
    const { createPgDataStore } = await import("./pg-datastore.js");
    return createPgDataStore(config.databaseUrl as string, EXCLUDED_STORE_IDS, config.secrets.shipstation?.api_key_v2 ?? null);
  }

  const { createSqliteDataStore } = await import("./sqlite-datastore.js");
  return createSqliteDataStore(config.sqliteDbPath as string, EXCLUDED_STORE_IDS, config.secrets.shipstation?.api_key_v2 ?? null);
}
