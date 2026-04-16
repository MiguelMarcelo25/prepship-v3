import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createWebApp } from "./app/web-app.ts";
import { startHttpServer } from "./app/server.ts";
import { resolveWebPublicDir } from "../../../packages/shared/src/config/repo-paths.ts";

// Load .env file if it exists (from project root).
const envPath = resolve(process.cwd(), ".env");
try {
  const envContent = readFileSync(envPath, "utf-8");
  for (const line of envContent.split("\n")) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith("#")) {
      const [key, ...valueParts] = trimmed.split("=");
      const value = valueParts.join("=");
      if (key && !(key in process.env)) {
        process.env[key] = value;
      }
    }
  }
} catch {
  // .env file doesn't exist
}

const apiBaseUrl = process.env.API_BASE_URL ?? "http://127.0.0.1:4010";
const port = Number.parseInt(process.env.WEB_PORT ?? "4011", 10);
const publicDir = resolveWebPublicDir(import.meta.url, process.env);
const app = createWebApp({ apiBaseUrl, publicDir });

startHttpServer(app, port).then(() => {
  console.log(`PrepshipV2 web listening on http://127.0.0.1:${port}`);
});
