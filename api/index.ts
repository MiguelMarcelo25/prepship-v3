import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { bootstrapApi } from "../apps/api/src/app/bootstrap.ts";

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
    handlerPromise = bootstrapApi(process.env, {}).then(({ app }) => app);
  }
  return handlerPromise;
}

export default async function handler(request: Request): Promise<Response> {
  const app = await getHandler();
  return app(request);
}
