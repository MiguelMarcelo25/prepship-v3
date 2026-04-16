import type { DatabaseSync } from "node:sqlite";
import type { AllowedSettingKey } from "../../../../../../packages/contracts/src/settings/contracts.ts";
import type { SettingsRepository } from "../application/settings-repository.ts";

export class SqliteSettingsRepository implements SettingsRepository {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  async get(key: AllowedSettingKey): Promise<string | null> {
    const row = this.db.prepare("SELECT value FROM sync_meta WHERE key = ?").get(`setting:${key}`) as { value: string } | undefined;
    return row?.value ?? null;
  }

  async set(key: AllowedSettingKey, value: string): Promise<void> {
    this.db.prepare("INSERT OR REPLACE INTO sync_meta (key, value) VALUES (?, ?)").run(`setting:${key}`, value);
  }
}

