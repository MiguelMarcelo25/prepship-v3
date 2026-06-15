// ──────────────────────────────────────────────────────────────────
// inventory-enrichment.ts
//
// Two background hygiene jobs that keep the Inventory table fully
// populated without operator intervention:
//
//   1. importSkusFromOrders()
//      Scans the JSONB items array on every order, seeds inventory
//      rows for SKUs we don't have yet, and back-fills missing
//      image_url / name on existing rows.
//
//   2. syncShipStationProducts()
//      Pulls the ShipStation product catalog for every active
//      ShipStation account (main env + per-client creds), upserting
//      weight, length, width, height, active, and image into the
//      inventory row matched on (sku, clientId).
//
// Both functions were previously inlined inside the route handlers
// in src/routes/inventory.ts (POST /import-from-orders and POST
// /sync-products). They've been extracted here so the in-process
// scheduler (sync-scheduler.ts) and the cron HTTP routes
// (routes/cron.ts) can invoke the same logic on a schedule. The
// route handlers now delegate to these functions — net behavior of
// the manual buttons in the Inventory toolbar is unchanged.
//
// Why automate this? Operator pain point 2026-05-13: many inventory
// rows render with "no img" because the manual "Import SKUs from
// Orders" and "Import Dims from SS" buttons get forgotten. Moving
// the work to a scheduled background tick means images and dims
// appear on their own as new SKUs and product-catalog updates land.
// ──────────────────────────────────────────────────────────────────

import { and, eq, isNull, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { inventory } from '../db/schema/inventory';
import { clients } from '../db/schema/clients';
import { listShipStationProducts } from '../connectors/store/shipstation';
import { createSyncRunBudget, syncRunBudgetTimeExhausted } from '../lib/sync-run-budget';

// PS-265: bound the per-run SKU import so the job finishes UNDER the worker's ~10-min deadline.
// It was an unbounded full-catalog DISTINCT scan + a per-row N+1 (SELECT-then-upsert) over EVERY
// distinct SKU every run, which hung as the catalog grew. The NOT EXISTS filter + this cap drain
// only NOT-yet-imported SKUs (each batch is excluded next run, so it acts as the cursor) and
// terminate once the catalog is fully imported.
const MAX_SKUS_PER_RUN = 1000;

export interface ImportSkusFromOrdersResult {
  inserted: number;
  skipped: number;
  message: string;
}

// Scan orders.items for SKUs and seed inventory rows we don't yet have.
// Also back-fills missing image_url / name on existing rows when the
// order item carries one (e.g. ShipStation now returns imageUrl, but
// older inventory rows were created before that field was populated).
export async function importSkusFromOrders(): Promise<ImportSkusFromOrdersResult> {
  const rows = await db.execute<{
    sku: string;
    name: string | null;
    image_url: string | null;
    client_id: number | null;
  }>(sql`
    select distinct on (oi.sku, o.client_id)
      oi.sku                                    as sku,
      coalesce(oi.name, '')                     as name,
      nullif(oi.image_url, '')                  as image_url,
      o.client_id                               as client_id
    from order_items oi
    join orders o on o.id = oi.order_id
    where oi.sku is not null
      and oi.sku <> ''
      -- PS-265: only SKUs not yet in inventory. Each run imports up to MAX_SKUS_PER_RUN and
      -- they are excluded next run (this NOT EXISTS is the cursor), so the import drains and
      -- TERMINATES instead of re-scanning the full catalog every run with a per-row N+1 (the
      -- hang). Legacy image/name back-fill on already-existing rows is a separate bounded
      -- follow-up — not this hot loop.
      and not exists (
        select 1 from inventory inv
        where inv.sku = oi.sku
          and (inv.client_id = o.client_id or (inv.client_id is null and o.client_id is null))
      )
    order by oi.sku, o.client_id, oi.updated_at desc
    limit ${MAX_SKUS_PER_RUN}
  `);

  let inserted = 0;
  let skipped = 0;
  // PS-265: defense-in-depth wall-clock bound on the per-row loop (the LIMIT already caps rows).
  const budget = createSyncRunBudget();

  for (const r of rows) {
    if (syncRunBudgetTimeExhausted(budget)) break;
    const [existing] = await db
      .select({ id: inventory.id })
      .from(inventory)
      .where(
        and(
          eq(inventory.sku, r.sku),
          r.client_id !== null
            ? eq(inventory.clientId, r.client_id)
            : isNull(inventory.clientId)
        )
      )
      .limit(1);

    if (existing) {
      // Back-fill image/name on rows that already exist but are
      // missing these enrichments. coalesce() preserves whatever the
      // operator may have set manually — we only write when the
      // existing column is NULL/empty.
      if (r.image_url || r.name) {
        const patch: Record<string, unknown> = { updatedAt: new Date() };
        if (r.image_url) patch.imageUrl = sql`coalesce(${inventory.imageUrl}, ${r.image_url})`;
        if (r.name) patch.name = sql`coalesce(nullif(${inventory.name}, ''), ${r.name})`;
        await db.update(inventory).set(patch).where(eq(inventory.id, existing.id));
      }
      skipped += 1;
      continue;
    }
    await db.insert(inventory).values({
      sku: r.sku,
      name: r.name || null,
      imageUrl: r.image_url,
      clientId: r.client_id,
    });
    inserted += 1;
  }

  return {
    inserted,
    skipped,
    message: `Imported ${inserted} new SKUs from orders (capped ${MAX_SKUS_PER_RUN}/run; ${skipped} already existed). Any remaining new SKUs import on the next run.`,
  };
}

export interface SyncShipStationProductsResult {
  inserted: number;
  updated: number;
  skipped: number;
  byAccount: Record<string, { inserted: number; updated: number }>;
  message: string;
}

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

type SSProductsList = {
  products: SSProduct[];
  total: number;
  page: number;
  pages: number;
};

type SSAccount = {
  label: string;
  apiKey: string | undefined;
  apiSecret: string | undefined;
  ownerClientId: number | null;
};

// Pull the product catalog from ShipStation v1 /products for every
// active ShipStation account we know about (main env creds + any
// client that supplied its own keys) and upsert into the inventory
// table. stockQty stays untouched — the standard SS API doesn't
// expose stock levels.
//
// Matching rules:
//   • Main env account → clientId IS NULL  (shared catalog)
//   • Per-client account → clientId = that client's id
//
// Image preservation: SS often returns null thumbnailUrl/imageUrl
// for products that DO have images sourced elsewhere (e.g. extracted
// from order items by importSkusFromOrders). We only OVERWRITE the
// imageUrl column when SS actually returned a non-null value.
export async function syncShipStationProducts(): Promise<SyncShipStationProductsResult> {
  // Build the account list — env-main first, then any active client
  // that has its own ShipStation credentials wired in Settings.
  const accounts: SSAccount[] = [
    { label: 'main', apiKey: undefined, apiSecret: undefined, ownerClientId: null },
  ];
  const clientRows = await db
    .select({
      id: clients.id,
      name: clients.name,
      ssApiKey: clients.ssApiKey,
      ssApiSecret: clients.ssApiSecret,
    })
    .from(clients)
    .where(eq(clients.active, true));
  for (const cli of clientRows) {
    if (cli.ssApiKey && cli.ssApiSecret) {
      accounts.push({
        label: `client:${cli.name}`,
        apiKey: cli.ssApiKey,
        apiSecret: cli.ssApiSecret,
        ownerClientId: cli.id,
      });
    }
  }

  let inserted = 0;
  let updated = 0;
  let skipped = 0;
  const byAccount: Record<string, { inserted: number; updated: number }> = {};

  for (const acct of accounts) {
    byAccount[acct.label] = { inserted: 0, updated: 0 };
    let page = 1;

    try {
      while (true) {
        const res = await listShipStationProducts<SSProduct>({
          pageSize: 500,
          page,
          apiKey: acct.apiKey,
          apiSecret: acct.apiSecret,
          dedupeKey: `products:list:${acct.label}:${page}`,
        });

        for (const p of res.products) {
          const sku = (p.sku ?? '').trim();
          if (!sku) {
            skipped += 1;
            continue;
          }

          const [existing] = await db
            .select({ id: inventory.id })
            .from(inventory)
            .where(
              and(
                eq(inventory.sku, sku),
                acct.ownerClientId === null
                  ? isNull(inventory.clientId)
                  : eq(inventory.clientId, acct.ownerClientId)
              )
            )
            .limit(1);

          const incomingImage = p.thumbnailUrl ?? p.imageUrl ?? null;
          const incomingName = p.name ?? null;

          if (existing) {
            const updateFields: Record<string, unknown> = {
              weightOz: p.weightOz ?? 0,
              length: p.length ?? null,
              width: p.width ?? null,
              height: p.height ?? null,
              active: p.active ?? true,
              updatedAt: new Date(),
            };
            if (incomingName) {
              updateFields.name = sql`coalesce(nullif(${inventory.name}, ''), ${incomingName})`;
            }
            if (incomingImage) {
              // Only overwrite when SS actually returned an image.
              // Null/empty SS values keep whatever was already on the
              // row (from order-item extraction etc.).
              updateFields.imageUrl = incomingImage;
            }
            await db
              .update(inventory)
              .set(updateFields)
              .where(eq(inventory.id, existing.id));
            updated += 1;
            byAccount[acct.label]!.updated += 1;
          } else {
            await db
              .insert(inventory)
              .values({
                sku,
                clientId: acct.ownerClientId,
                name: incomingName,
                weightOz: p.weightOz ?? 0,
                length: p.length ?? null,
                width: p.width ?? null,
                height: p.height ?? null,
                active: p.active ?? true,
                imageUrl: incomingImage,
              });
            inserted += 1;
            byAccount[acct.label]!.inserted += 1;
          }
        }

        if (page >= res.pages || !res.products.length) break;
        page += 1;
      }
    } catch (err) {
      console.error(
        `[sync-products] account "${acct.label}" failed:`,
        (err as Error).message
      );
    }
  }

  return {
    inserted,
    updated,
    skipped,
    byAccount,
    message: `Synced ${inserted + updated} products across ${accounts.length} account(s) (${inserted} new, ${updated} updated, ${skipped} without SKU)`,
  };
}
