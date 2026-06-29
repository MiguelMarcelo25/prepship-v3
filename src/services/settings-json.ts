import { getSetting, setSetting } from './settings';

export type JsonSettingRow<T> = {
  key: string;
  value: T;
};

export async function setJsonSetting(key: string, value: unknown): Promise<void> {
  await setSetting(key, JSON.stringify(value));
}

export async function setJsonSettings(rows: ReadonlyArray<JsonSettingRow<unknown>>): Promise<void> {
  for (const row of rows) {
    await setJsonSetting(row.key, row.value);
  }
}

export async function getJsonSetting<T>(key: string): Promise<T | null> {
  const value = await getSetting(key);
  if (value == null) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}
