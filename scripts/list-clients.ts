#!/usr/bin/env tsx
import 'dotenv/config';
import { sql as pgClient } from '../src/db/client';
import { db } from '../src/db/client';
import { sql } from 'drizzle-orm';

const rows = await db.execute<{ id: number; name: string; active: boolean }>(
  sql`select id, name, active from clients order by id`,
);
for (const r of rows) console.log(`${r.id}\t${r.active ? ' ' : 'X'}\t${r.name}`);
await pgClient.end({ timeout: 2 });
