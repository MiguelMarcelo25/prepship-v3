/**
 * PS-207 — the canonical owner of shipped-box billing resolution.
 *
 * DJ-decided policy (2026-06-12, Heritage Kids Press billing audit — do not
 * relitigate): the package_cost billing line is priced from the SHIPMENT'S
 * RECORDED BOX ONLY. Billing must never infer a box from SKU defaults,
 * inventory package defaults, SKU/qty combo defaults, rounded dims, rate
 * dims, or best-rate request dims. When the shipped box cannot be resolved
 * to a known package — or the selected box and the shipment dims disagree —
 * billing emits an explicit $0.00 review line; it never guesses.
 *
 * This module is PURE (zero imports, no db) so the PS-207 guard can exercise
 * the full resolution matrix offline. The generator (services/billing.ts)
 * builds the lookup maps and delegates here; billingDetails and the FE render
 * the outcome — neither re-implements the policy.
 *
 * Resolution order:
 *  1. Operator resolution from billing_box_resolutions — an explicit
 *     directive, not a fallback. Wins over everything.
 *  2. shipments.selected_package_id → packages.id (numeric string) or
 *     packages.package_code — the channel v4 label flows actually write the
 *     chosen box into (only when coherent with dims).
 *  3. shipments.selected_pid → packages.id where applicable (only when
 *     coherent with dims). Checked AFTER selected_package_id because
 *     selected_pid is provider-account-contaminated in practice — inventory/
 *     analysis key carrier markup off `coalesce(provider_account_id,
 *     label_provider, selected_pid)`, so a legacy provider id here can
 *     collide with a package id. The dims-coherence gate turns such a
 *     collision into MISMATCH review instead of a silent wrong-box bill.
 *  4. Exact shipment-dims match (L×W×H exactly identifies one package).
 *  MISMATCH — a selected package resolved AND complete shipment dims are
 *     present AND they identify different boxes (the dims map to a different
 *     package, or match no package while differing from the selected box's
 *     own dims). SP6754: selected 12x10x3, shipped Custom 12x10x1.
 *  UNRESOLVED — anything else (custom dims with no package row, or no box
 *     evidence at all).
 *
 * Coherence notes:
 *  - A selected package with no positive dims on its package row cannot be
 *    dims-compared; selection alone resolves it (documented exception).
 *  - A selected identifier that maps to NO known package is noise (stale
 *    ShipStation codes like "package") — it does not veto a dims match, and
 *    alone it is UNRESOLVED, never silently dropped.
 *  - Partial dims (missing/non-positive L, W, or H) are treated as no dims.
 */

export type BoxPackage = {
  id: number;
  name: string | null;
  packageCode: string | null;
  length: number;
  width: number;
  height: number;
};

export type BoxLookups = {
  byId: ReadonlyMap<number, BoxPackage>;
  byCode: ReadonlyMap<string, BoxPackage>;
  /** Keyed by boxDimsKey(l, w, h). */
  byDims: ReadonlyMap<string, BoxPackage>;
};

export type OperatorBoxResolution = {
  packageId: number | null;
  /** FINAL line amount in dollars — bypasses configured price AND markup
   * (matches the Edit Billing Detail modal's immediate set-amount behavior,
   * so a regeneration reproduces exactly what the operator saw). */
  overridePrice: number | null;
  note: string | null;
};

export type ShippedBoxDims = { l: number; w: number; h: number };

export type ShippedBoxInput = {
  /** Row from billing_box_resolutions for this order, if any. */
  operator: OperatorBoxResolution | null;
  selectedPid: number | null;
  selectedPackageId: string | null;
  dimsL: number | null | undefined;
  dimsW: number | null | undefined;
  dimsH: number | null | undefined;
  lookups: BoxLookups;
};

export type ShippedBoxResolution =
  | {
      status: 'resolved';
      source: 'operator' | 'selected_pid' | 'selected_package_code' | 'dims';
      /** null only for operator override-price-only resolutions. */
      packageId: number | null;
      pkg: BoxPackage | null;
      overridePrice: number | null;
      note: string | null;
    }
  | {
      status: 'mismatch';
      selectedPkg: BoxPackage;
      dims: ShippedBoxDims;
      /** The package the dims identify, when they identify one. */
      dimsPkg: BoxPackage | null;
    }
  | {
      status: 'unresolved';
      reason: 'custom_dims' | 'no_box_evidence' | 'unknown_selected_package';
      dims: ShippedBoxDims | null;
      selectedRaw: string | null;
    };

function finitePositive(value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Canonical dims identity key. Trims float noise (12.0 === 12) without
 * rounding distinct sizes together — `12.5x9x3` stays distinct from
 * `13x9x3` (rounded-dims matching is exactly the banned behavior). */
export function boxDimsKey(
  l: number | null | undefined,
  w: number | null | undefined,
  h: number | null | undefined
): string | null {
  const fl = finitePositive(l);
  const fw = finitePositive(w);
  const fh = finitePositive(h);
  if (fl === null || fw === null || fh === null) return null;
  const fmt = (n: number) => String(n);
  return `${fmt(fl)}x${fmt(fw)}x${fmt(fh)}`;
}

export function formatBoxDims(dims: ShippedBoxDims): string {
  return `${dims.l}x${dims.w}x${dims.h}`;
}

function shipmentDims(input: ShippedBoxInput): ShippedBoxDims | null {
  const l = finitePositive(input.dimsL);
  const w = finitePositive(input.dimsW);
  const h = finitePositive(input.dimsH);
  if (l === null || w === null || h === null) return null;
  return { l, w, h };
}

/** The selected package the shipment row claims. selected_package_id (the
 * channel v4 label flows write the chosen box into — numeric string id or
 * package_code) is checked FIRST; selected_pid second, because legacy rows
 * carry provider-account ids there (see header). null when neither identifier
 * maps to a known package. */
function selectedPackageOf(input: ShippedBoxInput): BoxPackage | null {
  const raw = input.selectedPackageId?.trim();
  if (raw) {
    const asInt = Number.parseInt(raw, 10);
    if (Number.isFinite(asInt) && String(asInt) === raw) {
      const pkg = input.lookups.byId.get(asInt);
      if (pkg) return pkg;
    }
    const byCode = input.lookups.byCode.get(raw);
    if (byCode) return byCode;
  }
  if (input.selectedPid !== null && input.selectedPid !== undefined) {
    const pkg = input.lookups.byId.get(input.selectedPid);
    if (pkg) return pkg;
  }
  return null;
}

function selectionSource(input: ShippedBoxInput, pkg: BoxPackage): 'selected_pid' | 'selected_package_code' {
  const raw = input.selectedPackageId?.trim();
  if (raw) {
    const asInt = Number.parseInt(raw, 10);
    if ((Number.isFinite(asInt) && String(asInt) === raw && input.lookups.byId.get(asInt)?.id === pkg.id) ||
        input.lookups.byCode.get(raw)?.id === pkg.id) {
      return 'selected_package_code';
    }
  }
  return 'selected_pid';
}

export function resolveShippedPackageId(input: ShippedBoxInput): ShippedBoxResolution {
  // 1. Operator directive — explicit, wins over all shipment evidence. A row
  //    carrying neither a package nor an override price is a note, not a
  //    directive, and does not resolve anything.
  if (input.operator && (input.operator.packageId !== null || input.operator.overridePrice !== null)) {
    const pkg =
      input.operator.packageId !== null
        ? input.lookups.byId.get(input.operator.packageId) ?? null
        : null;
    return {
      status: 'resolved',
      source: 'operator',
      packageId: input.operator.packageId,
      pkg,
      overridePrice: input.operator.overridePrice,
      note: input.operator.note,
    };
  }

  const dims = shipmentDims(input);
  const dimsKey = dims ? boxDimsKey(dims.l, dims.w, dims.h) : null;
  const dimsPkg = dimsKey ? input.lookups.byDims.get(dimsKey) ?? null : null;
  const selectedPkg = selectedPackageOf(input);

  // 2./3. Selected package — only when coherent with the shipment dims.
  if (selectedPkg) {
    if (dims) {
      const pkgKey = boxDimsKey(selectedPkg.length, selectedPkg.width, selectedPkg.height);
      if (pkgKey === null) {
        // Package row has no usable dims to compare — selection stands.
        return {
          status: 'resolved',
          source: selectionSource(input, selectedPkg),
          packageId: selectedPkg.id,
          pkg: selectedPkg,
          overridePrice: null,
          note: null,
        };
      }
      if (dimsPkg && dimsPkg.id !== selectedPkg.id) {
        // Dims identify a DIFFERENT package — never precedence-pick.
        return { status: 'mismatch', selectedPkg, dims, dimsPkg };
      }
      if (!dimsPkg && pkgKey !== dimsKey) {
        // Custom dims that are not the selected box — SP6754 class.
        return { status: 'mismatch', selectedPkg, dims, dimsPkg: null };
      }
    }
    return {
      status: 'resolved',
      source: selectionSource(input, selectedPkg),
      packageId: selectedPkg.id,
      pkg: selectedPkg,
      overridePrice: null,
      note: null,
    };
  }

  // 4. Exact dims identity (no selection in play).
  if (dimsPkg) {
    return {
      status: 'resolved',
      source: 'dims',
      packageId: dimsPkg.id,
      pkg: dimsPkg,
      overridePrice: null,
      note: null,
    };
  }

  if (dims) {
    return { status: 'unresolved', reason: 'custom_dims', dims, selectedRaw: input.selectedPackageId ?? null };
  }
  const selectedRaw = input.selectedPackageId?.trim() || (input.selectedPid !== null && input.selectedPid !== undefined ? `pid:${input.selectedPid}` : null);
  return {
    status: 'unresolved',
    reason: selectedRaw ? 'unknown_selected_package' : 'no_box_evidence',
    dims: null,
    selectedRaw,
  };
}

/** What the generator should emit for an order's package cost. Pure — the
 * generator supplies the resolution, the client's box-pricing facts, and the
 * markup; the DECISION lives here so the guard can exercise the whole matrix
 * offline:
 *   no box pricing configured        → none (no line, no review)
 *   resolved + override price        → line at the override VERBATIM (no markup)
 *   resolved + configured price > 0  → line at configured × (1 + markup%)
 *   resolved + no/zero price         → none (visible zero config = free)
 *   mismatch / unresolved            → $0.00 package_cost_missing review line
 */
export type PackageCostDecision =
  | { kind: 'line'; amount: number; packageId: number | null; pkgName: string }
  | { kind: 'review'; description: string }
  | { kind: 'none' };

export function decidePackageCostLine(args: {
  resolution: ShippedBoxResolution;
  clientHasBoxPricing: boolean;
  /** Raw client_package_prices price for resolution.packageId (no markup). */
  configuredPrice: number | null | undefined;
  markupPct: number;
}): PackageCostDecision {
  if (!args.clientHasBoxPricing) return { kind: 'none' };
  const r = args.resolution;
  if (r.status !== 'resolved') {
    return { kind: 'review', description: describeBoxReview(r) };
  }
  const effective =
    r.overridePrice != null
      ? r.overridePrice
      : args.configuredPrice != null && args.configuredPrice > 0
        ? args.configuredPrice * (1 + args.markupPct / 100)
        : null;
  if (effective == null || effective <= 0) return { kind: 'none' };
  return {
    kind: 'line',
    amount: effective,
    packageId: r.packageId,
    pkgName:
      r.pkg?.name ??
      (r.packageId != null ? `Box #${r.packageId}` : 'operator-resolved'),
  };
}

/** Review-line description for unresolved/mismatch outcomes. Stable text —
 * it participates in the billing_line_items (order_id, line_type,
 * description) unique key, so regeneration stays idempotent. */
export function describeBoxReview(
  resolution: Extract<ShippedBoxResolution, { status: 'mismatch' | 'unresolved' }>
): string {
  if (resolution.status === 'mismatch') {
    const sel = boxDimsKey(resolution.selectedPkg.length, resolution.selectedPkg.width, resolution.selectedPkg.height)
      ?? resolution.selectedPkg.name
      ?? `#${resolution.selectedPkg.id}`;
    return `Box mismatch — selected box (${sel}) disagrees with shipment dims (${formatBoxDims(resolution.dims)})`;
  }
  if (resolution.reason === 'custom_dims' && resolution.dims) {
    return `Unmatched box (Custom ${formatBoxDims(resolution.dims)}) — no package matches the shipment box`;
  }
  if (resolution.reason === 'unknown_selected_package') {
    return `Unmatched box (${resolution.selectedRaw}) — selected box is not a known package`;
  }
  return 'Unmatched box — shipment recorded no box or dims';
}
