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
}

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
  return account._label || account.nickname || account.code
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
  return accounts
    .filter((account) => account.code !== 'voucher-generic')
    .map((account) => {
      const markup = markups[account.shippingProviderId] ?? { type: 'flat' as const, value: 0 }
      const inputValue = Object.prototype.hasOwnProperty.call(drafts, account.shippingProviderId)
        ? drafts[account.shippingProviderId] ?? ''
        : getSettingsMarkupInputValue(markup.value)

      return {
        shippingProviderId: account.shippingProviderId,
        label: getSettingsAccountLabel(account),
        type: markup.type,
        value: markup.value,
        inputValue,
        preview: formatSettingsMarkupPreview(markup.type, inputValue),
      }
    })
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
