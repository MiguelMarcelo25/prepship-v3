import type { AllowedSettingKey } from "../../../../../../packages/contracts/src/settings/contracts.js";

export interface SettingsRepository {
  get(key: AllowedSettingKey): Promise<string | null>;
  set(key: AllowedSettingKey, value: string): Promise<void>;
}

