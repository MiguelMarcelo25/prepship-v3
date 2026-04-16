import { ALLOWED_SETTINGS, type AllowedSettingKey } from "../../../../../../packages/contracts/src/settings/contracts.js";
import type { SettingsRepository } from "./settings-repository.js";

const ALLOWED = new Set<string>(ALLOWED_SETTINGS);

function assertAllowedKey(key: string): asserts key is AllowedSettingKey {
  if (!ALLOWED.has(key)) {
    throw new Error("Unknown setting");
  }
}

function parseStoredValue(raw: string | null): unknown {
  if (raw == null) return null;

  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

export class SettingsServices {
  private readonly repository: SettingsRepository;

  constructor(repository: SettingsRepository) {
    this.repository = repository;
  }

  async get(key: string): Promise<unknown> {
    assertAllowedKey(key);
    return parseStoredValue(await this.repository.get(key));
  }

  async set(key: string, value: unknown) {
    assertAllowedKey(key);
    const serialized = typeof value === "string" ? value : JSON.stringify(value);
    await this.repository.set(key, serialized);
    return { ok: true };
  }
}

