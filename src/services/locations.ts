import { and, eq, ne } from 'drizzle-orm';
import { db } from '../db/client.js';
import { locations, type Location } from '../db/schema/locations.js';

export async function setDefaultLocation(id: number): Promise<Location> {
  return db.transaction(async (tx) => {
    const [exists] = await tx
      .select({ id: locations.id })
      .from(locations)
      .where(eq(locations.id, id))
      .limit(1);
    if (!exists) throw new Error('Location not found');

    await tx
      .update(locations)
      .set({ isDefault: false, updatedAt: new Date() })
      .where(and(ne(locations.id, id), eq(locations.isDefault, true)));

    const [row] = await tx
      .update(locations)
      .set({ isDefault: true, updatedAt: new Date() })
      .where(eq(locations.id, id))
      .returning();

    return row!;
  });
}

export async function getDefaultLocation(): Promise<Location | null> {
  const [row] = await db
    .select()
    .from(locations)
    .where(and(eq(locations.isDefault, true), eq(locations.active, true)))
    .limit(1);
  return row ?? null;
}
