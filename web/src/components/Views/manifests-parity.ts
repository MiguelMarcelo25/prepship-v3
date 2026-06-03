// @ts-nocheck
import type { GenerateManifestInput } from '@prepshipv2/contracts/manifests/contracts'

export interface ManifestFormState {
  startDate: string
  endDate: string
  carrierId: string
}

export function formatManifestDateInput(date: Date) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export function getManifestDefaultForm(now = new Date()): ManifestFormState {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0)
  const start = new Date(today.getTime() - (30 * 24 * 60 * 60 * 1000))

  return {
    startDate: formatManifestDateInput(start),
    endDate: formatManifestDateInput(now),
    carrierId: '',
  }
}

export function validateManifestForm(form: ManifestFormState) {
  if (!form.startDate || !form.endDate) {
    return '⚠️ Select start and end dates'
  }

  return null
}

export function buildManifestPayload(form: ManifestFormState): GenerateManifestInput {
  return {
    startDate: form.startDate,
    endDate: form.endDate,
    ...(form.carrierId ? { carrierId: form.carrierId } : {}),
  }
}

export function buildManifestFilename(startDate: string, endDate: string) {
  return `manifest_${startDate}_${endDate}.csv`
}

export function getManifestGenerateButtonLabel(isLoading: boolean) {
  return isLoading ? 'Generating…' : '⬇️ Download CSV'
}

export function getManifestStatusText(isLoading: boolean) {
  return isLoading ? 'Generating manifest…' : ''
}

// ── Manifest CSV ──────────────────────────────────────────────────────────────
// /manifests/generate returns JSON ({ data: [...] }); the Manifest Export saved
// that JSON straight to a .csv file, so Excel dumped the whole blob into one
// cell. Build a real, column-laid-out CSV from the shipment rows instead.
export interface ManifestRow {
  id?: number | null
  orderId?: number | null
  orderNumber?: string | null
  clientId?: number | null
  carrierCode?: string | null
  serviceCode?: string | null
  trackingNumber?: string | null
  shipDate?: string | null
  weightOz?: number | null
  labelCost?: number | string | null
}

function manifestCell(value: unknown): string {
  if (value === null || value === undefined) return ''
  return String(value)
}

function manifestShipDate(value: unknown): string {
  const raw = manifestCell(value)
  // ISO timestamps -> sortable YYYY-MM-DD; leave anything else as-is.
  return /^\d{4}-\d{2}-\d{2}T/.test(raw) ? raw.slice(0, 10) : raw
}

function manifestMoney(value: unknown): string {
  if (value === null || value === undefined || value === '') return ''
  const n = Number(value)
  return Number.isFinite(n) ? n.toFixed(2) : ''
}

const MANIFEST_CSV_COLUMNS: Array<{ header: string; get: (row: ManifestRow) => string }> = [
  { header: 'Ship Date', get: (r) => manifestShipDate(r.shipDate) },
  { header: 'Order #', get: (r) => manifestCell(r.orderNumber ?? r.orderId) },
  { header: 'Client ID', get: (r) => manifestCell(r.clientId) },
  { header: 'Carrier', get: (r) => manifestCell(r.carrierCode) },
  { header: 'Service', get: (r) => manifestCell(r.serviceCode) },
  { header: 'Tracking #', get: (r) => manifestCell(r.trackingNumber) },
  { header: 'Weight (oz)', get: (r) => manifestCell(r.weightOz) },
  { header: 'Label Cost', get: (r) => manifestMoney(r.labelCost) },
]

// RFC-4180 escaping: wrap in quotes (and double internal quotes) when the value
// contains a comma, quote, newline, or leading/trailing whitespace.
export function escapeManifestCsvCell(value: string): string {
  return /[",\r\n]/.test(value) || /^\s|\s$/.test(value)
    ? `"${value.replace(/"/g, '""')}"`
    : value
}

export function buildManifestCsv(rows: ManifestRow[]): string {
  const list = Array.isArray(rows) ? rows : []
  const header = MANIFEST_CSV_COLUMNS.map((c) => escapeManifestCsvCell(c.header)).join(',')
  const body = list
    .map((row) => MANIFEST_CSV_COLUMNS.map((c) => escapeManifestCsvCell(c.get(row ?? {}))).join(','))
    .join('\r\n')
  return list.length ? `${header}\r\n${body}` : header
}

export function manifestRowsFromResponse(res: unknown): ManifestRow[] {
  if (Array.isArray(res)) return res as ManifestRow[]
  const data = (res as { data?: unknown } | null)?.data
  return Array.isArray(data) ? (data as ManifestRow[]) : []
}
