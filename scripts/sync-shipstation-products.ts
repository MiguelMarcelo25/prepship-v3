#!/usr/bin/env tsx
// Run ShipStation product sync end-to-end against ShipStation v1 /products
// for the env-default account + every client with its own ssApiKey set.
// Updates inventory rows that match (clientId, sku) — fills name, weightOz,
// length/width/height, imageUrl, active. Same logic as POST
// /inventory/sync-products but runnable from CLI without an auth token.
import 'dotenv/config';
import { and, eq, isNull } from 'drizzle-orm';
import { sql as pgClient, db } from '../src/db/client';
import { inventory } from '../src/db/schema/inventory';
import { clients } from '../src/db/schema/clients';
import { ssV1Request } from '../src/lib/shipstation/v1-client';

type SSProduct = {
  productId: number;
  sku: string | null;
  name: string | null;
  weightOz?: number | null;
  length?: number | null;
  width?: number | null;
  height?: number | null;
  active?: boolean;
  thumbnailUrl?: string | null;
  imageUrl?: string | null;
};
type SSProductsList = { products: SSProduct[]; total: number; page: number; pages: number };
type Account = {
  label: string;
  apiKey: string | undefined;
  apiSecret: string | undefined;
  ownerClientId: number | null;
};

async function main() {
  const accounts: Account[] = [
    { label: 'main', apiKey: undefined, apiSecret: undefined, ownerClientId: null },
  ];
  const clientRows = await db
    .select({ id: clients.id, name: clients.name, ssApiKey: clients.ssApiKey, ssApiSecret: clients.ssApiSecret })
    .from(clients)
    .where(eq(clients.active, true));
  for (const cli of clientRows) {
    if (cli.ssApiKey && cli.ssApiSecret) {
      accounts.push({ label: `client:${cli.name}`, apiKey: cli.ssApiKey, apiSecret: cli.ssApiSecret, ownerClientId: cli.id });
    }
  }

  console.log(`Accounts to sync: ${accounts.map((a) => a.label).join(', ')}\n`);

  let inserted = 0, updated = 0, skipped = 0;
  for (const acct of accounts) {
    let page = 1;
    let acctInserted = 0, acctUpdated = 0;
    try {
      while (true) {
        const res = await ssV1Request<SSProductsList>(
          `/products?pageSize=500&page=${page}`,
          { apiKey: acct.apiKey, apiSecret: acct.apiSecret, dedupeKey: `cli-products:${acct.label}:${page}` }
        );
        for (const p of res.products) {
          const sku = (p.sku ?? '').trim();
          if (!sku) { skipped += 1; continue; }
          const where = and(
            eq(inventory.sku, sku),
            acct.ownerClientId === null ? isNull(inventory.clientId) : eq(inventory.clientId, acct.ownerClientId)
          );
          const [existing] = await db.select({ id: inventory.id }).from(inventory).where(where).limit(1);
          const fields = {
            name: p.name ?? null,
            weightOz: p.weightOz ?? 0,
            length: p.length ?? null,
            width: p.width ?? null,
            height: p.height ?? null,
            active: p.active ?? true,
            imageUrl: p.thumbnailUrl ?? p.imageUrl ?? null,
          };
          if (existing) {
            await db.update(inventory).set({ ...fields, updatedAt: new Date() }).where(eq(inventory.id, existing.id));
            updated += 1; acctUpdated += 1;
          } else {
            await db.insert(inventory).values({ sku, clientId: acct.ownerClientId, ...fields });
            inserted += 1; acctInserted += 1;
          }
        }
        if (page >= res.pages || !res.products.length) break;
        page += 1;
      }
      console.log(`  ${acct.label}: ${acctInserted} new, ${acctUpdated} updated`);
    } catch (err) {
      console.warn(`  ${acct.label}: failed — ${(err as Error).message}`);
    }
  }
  console.log(`\nTotal: ${inserted} new, ${updated} updated, ${skipped} skipped`);
}

main()
  .catch((e) => { console.error('FAIL:', e); process.exitCode = 1; })
  .finally(async () => { await pgClient.end({ timeout: 5 }); });
