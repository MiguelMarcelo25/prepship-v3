// PS-166 (this slice): the pure panel/package dimension + shipment-key helpers,
// moved VERBATIM out of OrdersView.tsx into the orders/ package directory (DJ
// preference: new functions live in their own small file). These are PURE —
// every output depends only on the arguments. No React, no component state, no
// refs, no fetch, no side effects.
//
// They derive shipment weight/dimensions from a panel form, build the
// shipment-details cache key + dims key (string identity used by the panel's
// auto-save/equality refs), and read a package's identifier/dimensions. The
// ShipmentDims shape is owned here now and re-imported by OrdersView so there
// is a single source of truth for the type.

import type { PanelFormState } from '../orders-panel-state'
import type { PackageDto } from '../../../types/api'

export type ShipmentDims = { length: number; width: number; height: number }

export function getPanelWeightOzFromForm(form: PanelFormState) {
  const lb = Number.parseFloat(form.weightLb) || 0
  const oz = Number.parseFloat(form.weightOz) || 0
  return (lb * 16) + oz
}

export function getPanelDimsFromForm(form: PanelFormState) {
  const length = Number.parseFloat(form.length) || 0
  const width = Number.parseFloat(form.width) || 0
  const height = Number.parseFloat(form.height) || 0
  return { length, width, height }
}

export function getShipmentDetailsKey(orderId: number | null | undefined, form: PanelFormState) {
  if (orderId == null) return ''
  const dims = getPanelDimsFromForm(form)
  return [
    orderId,
    getPanelWeightOzFromForm(form).toFixed(3),
    dims.length.toFixed(3),
    dims.width.toFixed(3),
    dims.height.toFixed(3),
    form.packageId || '',
  ].join(':')
}

export function hasCompleteDims(dims: ShipmentDims | null | undefined): dims is ShipmentDims {
  if (!dims) return false
  return dims.length > 0 && dims.width > 0 && dims.height > 0
}

export function getDimsKey(dims: ShipmentDims) {
  return [dims.length, dims.width, dims.height]
    .map((value) => Number(value).toFixed(3))
    .join('x')
}

export function getPackageIdentifier(pkg: PackageDto | null | undefined) {
  const raw = pkg?.packageId ?? (pkg as any)?.id
  const numeric = typeof raw === 'number' ? raw : Number.parseInt(String(raw ?? ''), 10)
  return Number.isFinite(numeric) ? String(numeric) : ''
}

export function getPackageDims(pkg: PackageDto | null | undefined) {
  if (!pkg) return null
  const dims = {
    length: Number.parseFloat(String(pkg.length ?? '')) || 0,
    width: Number.parseFloat(String(pkg.width ?? '')) || 0,
    height: Number.parseFloat(String(pkg.height ?? '')) || 0,
  }
  return hasCompleteDims(dims) ? dims : null
}
