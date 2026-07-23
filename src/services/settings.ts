import { asc, eq, inArray, like, or } from 'drizzle-orm';
import { db } from '../db/client';
import { settings } from '../db/schema/settings';
import {
  ALLOWED_SETTINGS,
  MARKUP_SETTING_LIKE_PATTERN,
} from './user-setting-policy';

export async function listUserSettings() {
  return db
    .select()
    .from(settings)
    .where(or(
      inArray(settings.key, [...ALLOWED_SETTINGS]),
      like(settings.key, MARKUP_SETTING_LIKE_PATTERN),
    ))
    .orderBy(asc(settings.key));
}

export async function listMarkupSettings() {
  return db
    .select()
    .from(settings)
    .where(like(settings.key, MARKUP_SETTING_LIKE_PATTERN))
    .orderBy(asc(settings.key));
}

export async function getSetting(key: string): Promise<string | null> {
  const [row] = await db
    .select()
    .from(settings)
    .where(eq(settings.key, key))
    .limit(1);
  return row?.value ?? null;
}

export async function setSetting(key: string, value: string): Promise<void> {
  await db
    .insert(settings)
    .values({ key, value })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value },
    });
}

export async function listSettingsByKeyPrefix(prefix: string) {
  const rows = await db
    .select({ key: settings.key, value: settings.value })
    .from(settings)
    .where(like(settings.key, `${prefix}%`));
  // SQL LIKE treats underscores as wildcards. Keep this exact JS boundary so a
  // maintenance caller can never receive an adjacent setting namespace.
  return rows.filter((row) => row.key.startsWith(prefix));
}

export async function deleteSettingsByKeys(keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  await db.delete(settings).where(inArray(settings.key, keys));
}

export async function getSettingNumber(key: string): Promise<number | null> {
  const v = await getSetting(key);
  if (v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
