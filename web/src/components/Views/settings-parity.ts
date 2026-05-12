// @ts-nocheck
import type { CarrierAccountDto, ClearAndRefetchResultDto } from '../../types/api'
import type { MarkupsMap, MarkupType } from '../../types/markups'

export interface SettingsMarkupRow {
  shippingProviderId: number
  label: string
  type: MarkupType
  value: number
  inputValue: string
  preview: string
  groupKey: string
  groupLabel: string
}

export interface SettingsMarkupGroup {
  key: string
  label: string
  rows: SettingsMarkupRow[]
}

// Phase 1: every ShipStation carrier we currently fetch lives on the main DR
// PREPPER account. When Phase 2 adds multi-account fan-out the resolver below
// inspects the source-client tag on each carrier and emits the matching key.
const MAIN_SHIPSTATION_GROUP_KEY = 'shipstation:dr-prepper'
const MAIN_SHIPSTATION_GROUP_LABEL = 'ShipStation Carriers — DR PREPPER'
const DIRECT_CARRIER_GROUP_KEY = 'direct-carrier-accounts'
const DIRECT_CARRIER_GROUP_LABEL = 'Direct Carrier Accounts'
const DIRECT_CARRIER_PROVIDER_ID_OFFSET = 10_000_000
const CLIENT_GROUP_KEY_ALIASES: Record<string, string> = {
  'kf-goods': 'kfg',
}

// Placeholder groups: ShipStation accounts whose creds exist on the backend
// but don't show up via the per-client DB iteration. We only need to hardcode
// here when there's a special env-only key (no matching client row). KFG is
// surfaced by the "KF Goods" client row in DB so it lands automatically — no
// placeholder needed.
export const PLACEHOLDER_SHIPSTATION_GROUPS: Array<{ key: string; label: string }> = [
]

function slugGroupName(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, '-')
}

function shipstationGroupKeyFromName(value: string): string {
  const slug = slugGroupName(value)
  return `shipstation:${CLIENT_GROUP_KEY_ALIASES[slug] ?? slug}`
}

export function resolveCarrierGroup(account: CarrierAccountDto): { key: string; label: string } {
  const provider = (account as any)?.provider as string | undefined
  const sourceClientName = (account as any)?.sourceClientName as string | undefined
  if (
    Number(account.shippingProviderId) >= DIRECT_CARRIER_PROVIDER_ID_OFFSET ||
    sourceClientName?.trim().toLowerCase() === 'direct carrier accounts'
  ) {
    return { key: DIRECT_CARRIER_GROUP_KEY, label: DIRECT_CARRIER_GROUP_LABEL }
  }
  if (provider && provider !== 'shipstation') {
    const label = String(provider).toUpperCase()
    return { key: `${provider}:default`, label: `${label} Carriers` }
  }
  if (sourceClientName) {
    return {
      key: shipstationGroupKeyFromName(sourceClientName),
      label: `ShipStation Carriers — ${sourceClientName}`,
    }
  }
  return { key: MAIN_SHIPSTATION_GROUP_KEY, label: MAIN_SHIPSTATION_GROUP_LABEL }
}

const V2_SETTINGS_CARRIER_ACCOUNTS: Array<{
  shippingProviderId: number
  label: string
  code: string
}> = [
  { shippingProviderId: 433542, label: 'USPS Chase x7439', code: 'stamps_com' },
  { shippingProviderId: 433543, label: 'UPS by SS - Chase x7439', code: 'ups_walleted' },
  { shippingProviderId: 565326, label: 'GG6381', code: 'ups' },
  { shippingProviderId: 565377, label: 'G19Y32', code: 'ups' },
  { shippingProviderId: 596001, label: 'ORION', code: 'ups' },
  { shippingProviderId: 604209, label: 'ROCEL', code: 'ups' },
  { shippingProviderId: 607855, label: 'ROCEL C81F70', code: 'ups' },
  { shippingProviderId: 598840, label: 'FedEx', code: 'fedex' },
  { shippingProviderId: 585004, label: 'FedEx One Balance', code: 'fedex_walleted' },
  { shippingProviderId: 442006, label: 'GREG PAYABILITY 6/17', code: 'stamps_com' },
  { shippingProviderId: 461890, label: 'ROCEL C81F70', code: 'ups' },
  { shippingProviderId: 565317, label: 'GG6381', code: 'ups' },
  { shippingProviderId: 595995, label: 'ORI Account', code: 'ups' },
  { shippingProviderId: 442007, label: 'GREG PAYABILITY 6/17', code: 'ups' },
  { shippingProviderId: 442013, label: 'FedEx', code: 'fedex' },
  { shippingProviderId: 585334, label: 'FedEx One Balance', code: 'fedex_walleted' },
  { shippingProviderId: 442017, label: 'Amazon Buy Shipping', code: 'amazon_buy_shipping' },
  { shippingProviderId: 566344, label: 'Sendle', code: 'sendle' },
  { shippingProviderId: 593739, label: 'Amazon Shipping US', code: 'amazon_shipping_us' },
]

const V2_SETTINGS_LABEL_BY_ID = new Map(
  V2_SETTINGS_CARRIER_ACCOUNTS.map((account) => [account.shippingProviderId, account.label]),
)

const SETTINGS_EXCLUDED_CARRIER_CODES = new Set(['voucher-generic', 'tusk'])

export type SettingsRefetchState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'success'; result: ClearAndRefetchResultDto }
  | { kind: 'error'; message: string }

export interface SettingsRefetchStatusView {
  visible: boolean
  text: string
  color: string
}

export function parseSettingsMarkupInput(value: string): number {
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : 0
}

export function formatSettingsMarkupPreview(type: MarkupType, value: number | string | null | undefined): string {
  const numericValue = typeof value === 'number' ? value : parseSettingsMarkupInput(value ?? '')
  return type === 'pct'
    ? `+${numericValue || 0}%`
    : `+$${numericValue.toFixed(2)}`
}

export function getSettingsAccountLabel(account: CarrierAccountDto): string {
  const providerId = Number(account.shippingProviderId)
  return V2_SETTINGS_LABEL_BY_ID.get(providerId) || account._label || account.nickname || account.code
}

export function getSettingsMarkupInputValue(value: number | null | undefined): string {
  return value == null ? '' : String(value)
}

export function getSettingsMarkupEmptyMessage(): string {
  return 'Open Rate Browser once to load accounts.'
}

export function getSettingsMarkupSavedToastMessage(): string {
  return '✅ Markup saved — rates refreshed'
}

export function buildSettingsMarkupRows(
  accounts: CarrierAccountDto[],
  markups: MarkupsMap,
  drafts: Record<number, string> = {},
): SettingsMarkupRow[] {
  const byProviderId = new Map<number, CarrierAccountDto>()
  for (const account of accounts) {
    const providerId = Number(account.shippingProviderId)
    if (!Number.isFinite(providerId)) continue
    if (SETTINGS_EXCLUDED_CARRIER_CODES.has(String(account.code ?? '').toLowerCase())) continue
    byProviderId.set(providerId, account)
  }

  const mergedAccounts: CarrierAccountDto[] = [
    ...V2_SETTINGS_CARRIER_ACCOUNTS.map((ref) => ({
      ...(byProviderId.get(ref.shippingProviderId) ?? {}),
      carrierId: byProviderId.get(ref.shippingProviderId)?.carrierId ?? `se-${ref.shippingProviderId}`,
      carrierCode: byProviderId.get(ref.shippingProviderId)?.carrierCode ?? ref.code,
      shippingProviderId: ref.shippingProviderId,
      nickname: ref.label,
      clientId: byProviderId.get(ref.shippingProviderId)?.clientId ?? null,
      code: byProviderId.get(ref.shippingProviderId)?.code ?? ref.code,
      _label: ref.label,
    })),
    ...accounts.filter((account) => {
      const providerId = Number(account.shippingProviderId)
      if (!Number.isFinite(providerId)) return false
      if (V2_SETTINGS_LABEL_BY_ID.has(providerId)) return false
      if (SETTINGS_EXCLUDED_CARRIER_CODES.has(String(account.code ?? '').toLowerCase())) return false
      return true
    }),
  ]

  return mergedAccounts
    .map((account) => {
      const markup = markups[account.shippingProviderId] ?? { type: 'flat' as const, value: 0 }
      const inputValue = Object.prototype.hasOwnProperty.call(drafts, account.shippingProviderId)
        ? drafts[account.shippingProviderId] ?? ''
        : getSettingsMarkupInputValue(markup.value)

      const group = resolveCarrierGroup(account)
      return {
        shippingProviderId: account.shippingProviderId,
        label: getSettingsAccountLabel(account),
        type: markup.type,
        value: markup.value,
        inputValue,
        preview: formatSettingsMarkupPreview(markup.type, inputValue),
        groupKey: group.key,
        groupLabel: group.label,
      }
    })
}

export interface PlaceholderClientGroup {
  name: string
}

export function groupSettingsMarkupRows(
  rows: SettingsMarkupRow[],
  clientPlaceholders: PlaceholderClientGroup[] = [],
): SettingsMarkupGroup[] {
  const byKey = new Map<string, SettingsMarkupGroup>()
  for (const row of rows) {
    const existing = byKey.get(row.groupKey)
    if (existing) {
      existing.rows.push(row)
    } else {
      byKey.set(row.groupKey, { key: row.groupKey, label: row.groupLabel, rows: [row] })
    }
  }
  // Append placeholder groups for known-but-unwired ShipStation accounts so
  // the structure is visible before backend fan-out lands.
  for (const ph of PLACEHOLDER_SHIPSTATION_GROUPS) {
    if (!byKey.has(ph.key)) {
      byKey.set(ph.key, { key: ph.key, label: ph.label, rows: [] })
    }
  }
  // Per-client placeholders: every client with its own ShipStation creds in
  // the DB gets a group. Drives "ShipStation Carriers — {ClientName}" headers
  // so admins can see exactly which clients are pending wire-up.
  for (const c of clientPlaceholders) {
    const trimmed = (c?.name ?? '').trim()
    if (!trimmed) continue
    const key = shipstationGroupKeyFromName(trimmed)
    if (byKey.has(key)) continue
    if (key === MAIN_SHIPSTATION_GROUP_KEY) continue
    byKey.set(key, { key, label: `ShipStation Carriers — ${trimmed}`, rows: [] })
  }
  return Array.from(byKey.values())
}

export function buildSettingsRefetchStatus(state: SettingsRefetchState): SettingsRefetchStatusView {
  if (state.kind === 'loading') {
    return {
      visible: true,
      text: '⏳ Clearing cache and refetching rates...',
      color: 'var(--text3)',
    }
  }

  if (state.kind === 'success') {
    return {
      visible: true,
      text: `✅ ${state.result.message} (${state.result.ordersQueued} orders queued)`,
      color: 'var(--green)',
    }
  }

  if (state.kind === 'error') {
    return {
      visible: true,
      text: `❌ Error: ${state.message}`,
      color: 'var(--red)',
    }
  }

  return {
    visible: false,
    text: '',
    color: 'var(--text3)',
  }
}
