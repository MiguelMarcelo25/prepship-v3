import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { repoRootFromModule, resolveV1RepoRoot } from "./repo-paths.js";

export interface TransitionalSecrets {
  shipstation?: {
    api_key?: string;
    api_secret?: string;
    api_key_v2?: string;
  };
  shipstationKfg?: {
    apiKey?: string;
    apiSecret?: string;
    apiKeyV2?: string;
  };
  portal?: {
    setupToken?: string;
  };
  session?: {
    secret?: string;
  };
}

export function defaultSecretsPath(env = process.env): string {
  const repoRoot = repoRootFromModule(import.meta.url);
  const localPath = path.resolve(repoRoot, "secrets.json");
  if (existsSync(localPath)) {
    return localPath;
  }
  return path.resolve(resolveV1RepoRoot(import.meta.url, env), "secrets.json");
}

export function loadTransitionalSecrets(secretsPath: string): TransitionalSecrets {
  let fileSecrets: TransitionalSecrets = {};
  
  if (existsSync(secretsPath)) {
    try {
      const raw = readFileSync(secretsPath, "utf8");
      fileSecrets = JSON.parse(raw) as TransitionalSecrets;
    } catch (e) {
      console.warn(`Failed to parse secrets file at ${secretsPath}:`, e);
    }
  }

  return {
    ...fileSecrets,
    shipstation: {
      api_key: process.env.SHIPSTATION_API_KEY ?? fileSecrets.shipstation?.api_key,
      api_secret: process.env.SHIPSTATION_API_SECRET ?? fileSecrets.shipstation?.api_secret,
      api_key_v2: process.env.SHIPSTATION_API_KEY_V2 ?? fileSecrets.shipstation?.api_key_v2,
    },
    shipstationKfg: {
      apiKey: process.env.SHIPSTATION_KFG_API_KEY,
      apiSecret: process.env.SHIPSTATION_KFG_API_SECRET,
      apiKeyV2: process.env.SHIPSTATION_KFG_API_KEY_V2,
    },
    portal: {
      setupToken: process.env.PORTAL_SETUP_TOKEN ?? fileSecrets.portal?.setupToken,
    },
    session: {
      secret: process.env.SESSION_TOKEN ?? fileSecrets.session?.secret,
    }
  };
}
