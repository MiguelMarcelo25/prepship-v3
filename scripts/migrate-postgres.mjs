#!/usr/bin/env node
/**
 * migrate-postgres.mjs
 *
 * Runs SQL migration files against a PostgreSQL database.
 *
 * Usage:
 *   node scripts/migrate-postgres.mjs
 *   DATABASE_URL=postgres://... node scripts/migrate-postgres.mjs
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const __dirname = dirname(fileURLToPath(import.meta.url));

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("ERROR: DATABASE_URL environment variable is required");
  process.exit(1);
}

const sql = postgres(databaseUrl, { ssl: "require" });

const migrationPath = resolve(__dirname, "../packages/shared/src/postgres/migrations/001-initial-schema.sql");
const migration = readFileSync(migrationPath, "utf-8");

console.log("Running PostgreSQL migration...");

try {
  await sql.unsafe(migration);
  console.log("Migration completed successfully.");
} catch (error) {
  console.error("Migration failed:", error.message);
  process.exit(1);
} finally {
  await sql.end();
}
