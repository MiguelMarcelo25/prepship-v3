// @ts-nocheck
import type {
  PackageAdjustmentInput,
  PackageDto,
  SavePackageInput,
  SetDefaultBillingPackagePriceResult,
} from '../../types/api'
import { formatCaDateLong } from '../../lib/ca-time'

export interface PackageFormState {
  packageId: string
  name: string
  type: string
  tareWeightOz: string
  length: string
  width: string
  height: string
  unitCost: string
}

export interface PackageQuantityFormState {
  qty: string
  note: string
  costPerUnit: string
}

export type PackagesContentState = 'loading' | 'error' | 'empty' | 'list'

export function createPackageFormState(pkg?: PackageDto | null): PackageFormState {
  return {
    packageId: pkg ? String(pkg.packageId) : '',
    name: pkg?.name ?? '',
    type: pkg?.type ?? 'box',
    tareWeightOz: String(pkg?.tareWeightOz ?? 0),
    length: String(pkg?.length ?? 0),
    width: String(pkg?.width ?? 0),
    height: String(pkg?.height ?? 0),
    unitCost: pkg?.unitCost != null ? String(pkg.unitCost) : '',
  }
}

export function createPackageQuantityFormState(costPerUnit = ''): PackageQuantityFormState {
  return {
    qty: '1',
    note: '',
    costPerUnit,
  }
}

export function getPackagesContentState(input: {
  loading: boolean
  error: string | null
  packages: PackageDto[]
}): PackagesContentState {
  if (input.loading) return 'loading'
  if (input.error) return 'error'
  if (input.packages.length === 0) return 'empty'
  return 'list'
}

export function splitPackagesBySource(packages: PackageDto[]) {
  return {
    custom: packages.filter((pkg) => pkg.source !== 'ss_carrier'),
    carrier: packages.filter((pkg) => pkg.source === 'ss_carrier'),
  }
}

export function buildPackageSaveInput(form: PackageFormState): SavePackageInput {
  const unitCost = form.unitCost.trim()

  return {
    name: form.name.trim(),
    type: form.type,
    tareWeightOz: Number.parseFloat(form.tareWeightOz) || 0,
    length: Number.parseFloat(form.length) || 0,
    width: Number.parseFloat(form.width) || 0,
    height: Number.parseFloat(form.height) || 0,
    unitCost: unitCost !== '' ? Number.parseFloat(unitCost) : null,
  }
}

export function buildPackageReceiveInput(form: PackageQuantityFormState): PackageAdjustmentInput {
  const costPerUnit = form.costPerUnit.trim()

  return {
    qty: Number.parseInt(form.qty, 10) || 0,
    note: form.note.trim(),
    costPerUnit: costPerUnit !== '' ? Number.parseFloat(costPerUnit) : null,
  }
}

export function buildPackageAdjustInput(form: PackageQuantityFormState, sign: 1 | -1): PackageAdjustmentInput {
  const qty = (Number.parseInt(form.qty, 10) || 0) * sign
  const note = form.note.trim()

  return {
    qty,
    note: note || (qty > 0 ? 'Manual add' : 'Manual remove'),
  }
}

export function buildLowStockBannerText(packages: PackageDto[]) {
  if (packages.length === 0) return ''
  return `Low stock: ${packages.map((pkg) => `${pkg.name} (${pkg.stockQty ?? 0} left)`).join(', ')}`
}

export function formatPackageDimensionsText(pkg: PackageDto) {
  const dims = pkg.length > 0 && pkg.width > 0 && pkg.height > 0
    ? `${pkg.length}×${pkg.width}×${pkg.height}"`
    : '—'
  const tare = pkg.tareWeightOz > 0 ? `${pkg.tareWeightOz} oz` : ''
  return tare ? `${dims} · ${tare}` : dims
}

export function formatPackageUnitCost(unitCost: number | null | undefined) {
  if (unitCost == null || Number.isNaN(unitCost)) return '—'
  return `$${Number(unitCost).toFixed(3)}`
}

export function getPackageStockColor(pkg: PackageDto) {
  const qty = pkg.stockQty ?? 0
  const reorderLevel = pkg.reorderLevel ?? 10
  if (qty <= 0) return 'var(--red)'
  if (qty <= reorderLevel) return 'var(--yellow,#f59e0b)'
  return 'var(--green)'
}

export function formatPackageLedgerDate(createdAt: number) {
  return formatCaDateLong(createdAt)
}

export function buildSetDefaultPackagePriceToast(result: SetDefaultBillingPackagePriceResult) {
  return `✅ Default set for ${result.updated} client${result.updated === 1 ? '' : 's'}${result.skipped ? ` · ${result.skipped} skipped (custom override)` : ''}`
}
