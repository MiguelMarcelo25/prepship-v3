/**
 * PS-205 — PURE precedence policy for an order's effective package facts
 * (weight / dims / selected package).
 *
 * The business rule: for MUTABLE Awaiting Shipment rating/label package facts,
 * PrepShip-SAVED defaults beat ShipStation-imported data. Canonical precedence:
 *
 *   1. 'override'           — explicit current order override / operator edit
 *                             (order_overrides.rate_* / selected_package_id)
 *   2. 'combo_default'      — exact client-scoped SKU+qty combo default
 *                             (client_combo_package_defaults keyed by
 *                             (clientId, normalized comboKey) — covers BOTH
 *                             multi-SKU combos and single-SKU-with-qty keys)
 *   3. 'single_sku_default' — product/inventory-derived defaults, TRUE
 *                             single-SKU orders only (qty-scoped by the
 *                             existing dims-defaults rules)
 *   4. 'imported'           — orders.weight_oz + raw dimensions, FALLBACK ONLY
 *
 * Zero imports — offline-testable. IO callers (combo-package-defaults /
 * routes) load each rung and delegate the decision here; they must never
 * re-implement the ordering.
 */

export type PackageFactsSource = 'override' | 'combo_default' | 'single_sku_default' | 'imported';

export type PackageFactsDims = { length: number; width: number; height: number };

export type EffectivePackageFacts = {
  source: PackageFactsSource;
  weightOz: number | null;
  dims: PackageFactsDims | null;
  selectedPackageId: string | null;
  comboKey?: string;
  // PS-304: display-safe provenance affordances. canSaveComboDefault = the resolved
  // facts are complete enough AND scoped to a combo key, so the operator could save
  // them as the client-scoped combo default. canPropagateDefault = those facts are an
  // operator override (not already the default), so they can be propagated. Additive.
  canSaveComboDefault?: boolean;
  canPropagateDefault?: boolean;
};

export type PackageFactsRung = {
  weightOz?: number | null;
  length?: number | null;
  width?: number | null;
  height?: number | null;
  selectedPackageId?: string | null;
};

function positive(value: unknown): number | null {
  const n = typeof value === 'string' ? Number.parseFloat(value) : (value as number);
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : null;
}

function dimsOf(rung: PackageFactsRung | null | undefined): PackageFactsDims | null {
  if (!rung) return null;
  const length = positive(rung.length);
  const width = positive(rung.width);
  const height = positive(rung.height);
  return length != null && width != null && height != null ? { length, width, height } : null;
}

function packageIdOf(rung: PackageFactsRung | null | undefined): string | null {
  const raw = rung?.selectedPackageId;
  if (raw == null) return null;
  const text = String(raw).trim();
  return text ? text : null;
}

/** A rung carries facts when ANY of weight / complete dims / package is present. */
export function rungHasFacts(rung: PackageFactsRung | null | undefined): boolean {
  if (!rung) return false;
  return positive(rung.weightOz) != null || dimsOf(rung) != null || packageIdOf(rung) != null;
}

function numEq(a: number | null, b: number | null): boolean {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  return Math.abs(a - b) < 1e-9;
}

/** Do two rungs carry the SAME facts (used to label materialized combo defaults honestly)? */
export function rungsCarrySameFacts(a: PackageFactsRung | null | undefined, b: PackageFactsRung | null | undefined): boolean {
  if (!a || !b) return false;
  const da = dimsOf(a);
  const db = dimsOf(b);
  const dimsEqual =
    (da == null && db == null) ||
    (da != null && db != null && numEq(da.length, db.length) && numEq(da.width, db.width) && numEq(da.height, db.height));
  return (
    numEq(positive(a.weightOz), positive(b.weightOz)) &&
    dimsEqual &&
    packageIdOf(a) === packageIdOf(b)
  );
}

export type ResolvePackageFactsInput = {
  override: PackageFactsRung | null;
  comboDefault: PackageFactsRung | null;
  /** Only pass for TRUE single-SKU orders (the caller owns the qty-scope rule). */
  singleSkuDefault: PackageFactsRung | null;
  imported: PackageFactsRung | null;
  comboKey?: string | null;
};

/**
 * The single precedence decision. The WINNING rung supplies the facts as a
 * bundle (no cross-rung field mixing — a half-override wins as an override;
 * its missing fields stay null rather than silently inheriting imported data
 * the operator may have been correcting away from).
 *
 * Source honesty: an override whose facts EXACTLY equal the current combo
 * default is reported as 'combo_default' — that is what a sync-time/save-time
 * materialization looks like at rest, and the UI should say so instead of
 * claiming an operator edited it.
 */
export function resolvePackageFactsFromInputs(input: ResolvePackageFactsInput): EffectivePackageFacts {
  const comboKey = input.comboKey?.trim() || undefined;
  const build = (source: PackageFactsSource, rung: PackageFactsRung | null): EffectivePackageFacts => {
    const weightOz = positive(rung?.weightOz);
    const dims = dimsOf(rung);
    // PS-304: complete facts scoped to a combo key can be saved as the combo default;
    // operator overrides (not already the materialized default) can be propagated.
    const canSaveComboDefault = Boolean(comboKey) && weightOz != null && dims != null;
    const canPropagateDefault = canSaveComboDefault && source === 'override';
    return {
      source,
      weightOz,
      dims,
      selectedPackageId: packageIdOf(rung),
      canSaveComboDefault,
      canPropagateDefault,
      ...(comboKey ? { comboKey } : {}),
    };
  };

  if (rungHasFacts(input.override)) {
    const materialized = rungHasFacts(input.comboDefault) && rungsCarrySameFacts(input.override, input.comboDefault);
    return build(materialized ? 'combo_default' : 'override', input.override);
  }
  if (rungHasFacts(input.comboDefault)) return build('combo_default', input.comboDefault);
  if (rungHasFacts(input.singleSkuDefault)) return build('single_sku_default', input.singleSkuDefault);
  return build('imported', input.imported ?? null);
}
