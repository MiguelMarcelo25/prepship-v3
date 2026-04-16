import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { bootstrapApi } from "../apps/api/src/app/bootstrap.js";

// Load .env if present (for local `vercel dev`)
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
  // no .env file
}

let handlerPromise: Promise<(request: Request) => Promise<Response>> | null = null;

function getHandler() {
  if (!handlerPromise) {
    console.log("[vercel] bootstrapping...", { DB_PROVIDER: process.env.DB_PROVIDER, hasDbUrl: !!process.env.DATABASE_URL });
    handlerPromise = bootstrapApi(process.env, {}).then(({ app }) => {
      console.log("[vercel] bootstrap complete");
      return app;
    }).catch((err) => {
      console.error("[vercel] bootstrap FAILED:", err);
      throw err;
    });
  }
  return handlerPromise;
}

export default async function handler(request: Request): Promise<Response> {
  const url = new URL(request.url, "http://localhost");

  // Quick health check — no bootstrap needed
  if (url.pathname === "/api/health") {
    return new Response(JSON.stringify({ ok: true, env: process.env.DB_PROVIDER, ts: Date.now() }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  try {
    const app = await getHandler();
    return app(request);
  } catch (err) {
    console.error("[vercel] handler error:", err);
    return new Response(JSON.stringify({ error: "Internal server error", detail: String(err) }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }
}
