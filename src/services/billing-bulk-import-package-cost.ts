/**
 * PS-499 step 6 — the ONE server-side answer to "what does this imported box cost?".
 *
 * The pasted Box Size import used to price boxes in the browser: it read the
 * client's configured price out of `billingEditPackagePrices` and submitted it as
 * `packageCost`. That was wrong twice over. It skipped the package-cost MARKUP
 * that `decidePackageCostLine` applies during generation, so an imported box was
 * billed at raw configured price; and because the route reads a present
 * `packageCost` as an explicit operator override, every imported row pinned
 * `billing_box_resolutions.override_price` and froze that amount against future
 * price changes.
 *
 * So the import now sends only `packageId`, and this module resolves the amount
 * from the same policy the generator uses. It deliberately passes
 * `overridePrice: null`: a bulk import is never an explicit price decision, so
 * the resulting line is a normal configured-price line that later regeneration
 * may legitimately reflow.
 *
 * Fails closed. If the package is unknown, or the client has no configured
 * positive price for it and it is not a flagged no-charge box, this returns
 * `unresolved` rather than inventing 0 or silently keeping the previous box's
 * cost — the route turns that into a 422 with no mutation.
 */
import { type SQL, sql } from 'drizzle-orm';
import { decidePackageCostLine, type BoxPackage } from './billing-box-policy';

/**
 * Same narrow shape the other billing services accept (see
 * BillingOrderDescriptionExecutor), so a `tx` or `db` both satisfy it without
 * dragging drizzle's transaction generics through this module.
 */
export type BulkImportPackageCostExecutor = {
  execute: (query: SQL) => Promise<unknown>;
};

/**
 * Drizzle's drivers disagree on what `execute` returns: postgres-js (production)
 * yields an array-like of rows, while the pglite driver used by the integration
 * test yields `{ rows: [...] }`. Normalising here keeps the adapter portable —
 * without it the pglite path silently sees zero rows and every box resolves as
 * `unknown_package`, which is exactly how this was caught.
 */
async function rows<T>(executor: BulkImportPackageCostExecutor, query: SQL): Promise<T[]> {
  const result = (await executor.execute(query)) as unknown;
  if (Array.isArray(result)) return result as T[];
  const nested = (result as { rows?: unknown } | null)?.rows;
  return Array.isArray(nested) ? (nested as T[]) : [];
}

export type BulkImportPackageCostDecision =
  | { kind: 'line'; amount: number; packageId: number; pkgName: string }
  | {
      kind: 'unresolved';
      packageId: number;
      reason: 'unknown_package' | 'client_has_no_box_pricing' | 'no_configured_price';
    };

type PackageRow = {
  id: number;
  name: string | null;
  package_code: string | null;
  length: number | string | null;
  width: number | string | null;
  height: number | string | null;
  source: string | null;
};

const num = (value: number | string | null | undefined): number => Number(value ?? 0) || 0;

/**
 * Resolve the package-cost line a bulk box import should produce.
 *
 * Runs entirely on the caller's transaction so the decision is taken against the
 * same snapshot the write uses — a concurrent client-price edit cannot land
 * between the decision and the line it produces.
 */
export async function resolveBulkImportPackageCost(
  executor: BulkImportPackageCostExecutor,
  args: { clientId: number; packageId: number },
): Promise<BulkImportPackageCostDecision> {
  const { clientId, packageId } = args;

  const packageRows = await rows<PackageRow>(executor, sql`
    select id, name, package_code, length, width, height, source
    from packages
    where id = ${packageId}
    limit 1
  `);
  const pkgRow = packageRows[0];
  if (!pkgRow) {
    return { kind: 'unresolved', packageId, reason: 'unknown_package' };
  }

  // Every configured price for this client, not just this box: `clientHasBoxPricing`
  // is the gate decidePackageCostLine uses to decide whether this client is billed
  // for boxes AT ALL.
  //
  // Note the difference from GENERATION: there, a client with no box pricing simply
  // gets no box line. Here the operator has explicitly pasted a box, so silently
  // producing nothing would leave that stated intent unapplied and unexplained.
  // Imported box intent without an authoritative package-cost decision fails
  // closed — the route turns it into a 422 naming the package.
  const priceRows = await rows<{ package_id: number; price: string | null }>(executor, sql`
    select package_id, price
    from client_package_prices
    where client_id = ${clientId}
  `);
  const clientHasBoxPricing = priceRows.length > 0;

  const configuredRow = priceRows.find((row) => Number(row.package_id) === packageId);
  // PS-372(a): null is the single "no configured price" sentinel — never 0, which
  // is a real (free) price.
  const configuredPrice = configuredRow?.price != null ? Number(configuredRow.price) : null;

  const cfgRows = await rows<{ package_cost_markup: string | null }>(executor, sql`
    select package_cost_markup
    from billing_config
    where client_id = ${clientId}
    limit 1
  `);

  const pkg: BoxPackage = {
    id: Number(pkgRow.id),
    name: pkgRow.name,
    packageCode: pkgRow.package_code,
    length: num(pkgRow.length),
    width: num(pkgRow.width),
    height: num(pkgRow.height),
    source: pkgRow.source,
  };

  const decision = decidePackageCostLine({
    resolution: {
      status: 'resolved',
      // The operator named this box explicitly in the paste.
      source: 'operator',
      packageId,
      pkg,
      customDims: null,
      // NEVER an override. A bulk import states which box was used, not what it
      // should cost — pinning a price here is the defect PS-499 removes.
      overridePrice: null,
      note: null,
    },
    clientHasBoxPricing,
    configuredPrice,
    markupPct: num(cfgRows[0]?.package_cost_markup),
  });

  if (decision.kind === 'line') {
    return { kind: 'line', amount: decision.amount, packageId, pkgName: decision.pkgName };
  }

  // 'review' cannot occur here — the resolution above is always `resolved`. A
  // 'none' means either the client is not billed for boxes at all, or this box
  // has no positive configured price and is not a no-charge box.
  return {
    kind: 'unresolved',
    packageId,
    reason: clientHasBoxPricing ? 'no_configured_price' : 'client_has_no_box_pricing',
  };
}

export type ResolvedBulkImportPackageCostWrite = {
  clientId: number;
  orderId: number;
  orderNumber: string | null;
  shipmentId: number | null;
  shipDate: unknown;
  billingEffectiveDate: unknown;
  billingPolicyVersion: string | null;
  packageName: string;
  /** Already money-formatted by the caller, so there is only ever one formatter. */
  amount: string;
};

/**
 * Persist the package-cost line a bulk box import resolved to.
 *
 * Owned here rather than inline in the route so the PATCH handler does not grow
 * more route-local money persistence (ps-464 architecture boundary). The route
 * keeps the transaction boundary, the 422 translation and the PS-207 box
 * resolution; this owns only the update-or-insert of the single line and the
 * NOT NULL description that goes with it.
 *
 * The description written here is the INITIAL one — the row cannot be inserted
 * without it. The PS-207 block canonicalises it afterwards from the same owner
 * (resolvedPackageDisplayName), so there is one naming policy, not two.
 */
export async function writeResolvedBulkImportPackageCost(
  executor: BulkImportPackageCostExecutor,
  input: ResolvedBulkImportPackageCostWrite,
): Promise<{ inserted: number; updated: number }> {
  const description = `Box (${input.packageName})`;

  const updated = await rows<{ id: number }>(
    executor,
    sql`
      update billing_line_items
      set qty = '1.00',
          unit_cost = ${input.amount},
          total_cost = ${input.amount},
          description = ${description}
      where client_id = ${input.clientId}
        and order_id = ${input.orderId}
        and line_type = 'package_cost'
      returning id
    `,
  );
  if (updated.length > 0) return { inserted: 0, updated: updated.length };

  // No box line yet — the order was previously unpriced or sitting in review.
  await executor.execute(sql`
    insert into billing_line_items
      (client_id, order_id, order_number, shipment_id, ship_date, billing_effective_date,
       billing_policy_version, line_type, description, qty, unit_cost, total_cost)
    values
      (${input.clientId}, ${input.orderId}, ${input.orderNumber}, ${input.shipmentId},
       ${input.shipDate as never}, ${input.billingEffectiveDate as never},
       ${input.billingPolicyVersion}, 'package_cost', ${description}, '1.00',
       ${input.amount}, ${input.amount})
  `);
  return { inserted: 1, updated: 0 };
}
