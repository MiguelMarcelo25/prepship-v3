import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { bootstrapApi } from "./app/bootstrap.ts";
import { startHttpServer } from "./app/server.ts";
import { OrderStatusSyncWorker } from "./modules/sync/order-status-sync.ts";

// Load .env file if it exists (from project root).
// IMPORTANT: plist/environment values win — .env only fills in MISSING vars.
const envPath = resolve(process.cwd(), ".env");
try {
  const envContent = readFileSync(envPath, "utf-8");
  for (const line of envContent.split("\n")) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith("#")) {
      const [key, ...valueParts] = trimmed.split("=");
      const value = valueParts.join("=");
      // Only set if not already defined by launchd/shell environment
      if (key && !(key in process.env)) {
        process.env[key] = value;
      }
    }
  }
} catch {
  // .env file doesn't exist, use existing process.env
}

const { config, app } = await bootstrapApi(process.env, {});

startHttpServer(app, config.port).then(() => {
  console.log(`PrepshipV2 API listening on http://127.0.0.1:${config.port}`);
  console.log(`[Note] Authentication delegated to Cloudflare Access`);

  // Start order status sync worker if enabled
  if (config.workerSyncEnabled) {
    const apiKey = config.secrets.shipstation?.api_key ?? "";
    const apiSecret = config.secrets.shipstation?.api_secret ?? "";
    if (apiKey && apiSecret) {
      const db = new DatabaseSync(config.sqliteDbPath as string);
      const syncWorker = new OrderStatusSyncWorker(db, apiKey, apiSecret);
      syncWorker.start();
      console.log("[sync] Order status sync worker enabled");
    } else {
      console.warn("[sync] WORKER_SYNC_ENABLED=true but ShipStation credentials missing");
    }
  } else {
    console.log("[sync] Order status sync disabled (WORKER_SYNC_ENABLED=false)");
  }
});
