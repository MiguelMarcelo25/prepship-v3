import { eq } from 'drizzle-orm';
import { db } from '../db/client';
import { settings } from '../db/schema/settings';

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

export async function getSettingNumber(key: string): Promise<number | null> {
  const v = await getSetting(key);
  if (v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
