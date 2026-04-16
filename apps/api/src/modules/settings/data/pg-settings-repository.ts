import type { PgClient } from "../../../../../../packages/shared/src/postgres/database.ts";
import type { AllowedSettingKey } from "../../../../../../packages/contracts/src/settings/contracts.ts";
import type { SettingsRepository } from "../application/settings-repository.ts";

export class PgSettingsRepository implements SettingsRepository {
  constructor(private readonly sql: PgClient) {}

  async get(key: AllowedSettingKey): Promise<string | null> {
    const rows = await this.sql`SELECT value FROM sync_meta WHERE key = ${"setting:" + key} LIMIT 1`;
    const row = rows[0] as { value: string } | undefined;
    return row?.value ?? null;
  }

  async set(key: AllowedSettingKey, value: string): Promise<void> {
    await this.sql`
      INSERT INTO sync_meta (key, value)
      VALUES (${"setting:" + key}, ${value})
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
    `;
  }
}
