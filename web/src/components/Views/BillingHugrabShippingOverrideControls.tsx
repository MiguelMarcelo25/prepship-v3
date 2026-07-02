import type { BillingConfigDraft, BillingConfigDto } from './billing-parity'

type UpdateDraft = (field: keyof BillingConfigDraft, value: string | boolean) => void

export function isHugrabBillingClient(config: BillingConfigDto): boolean {
  return String(config.clientName ?? '').trim().toUpperCase() === 'HUGRAB'
}

export function BillingHugrabShippingOverrideToggle({
  config,
  draft,
  onChange,
}: {
  config: BillingConfigDto
  draft?: BillingConfigDraft
  onChange: UpdateDraft
}) {
  if (!isHugrabBillingClient(config)) return <span className="text-ink-3">-</span>
  return (
    <input
      type="checkbox"
      checked={draft?.hugrabShippingRateOverrideEnabled !== false}
      title="HUGRAB only: when C. Shipping Rate is below the configured threshold, bill the configured override amount."
      onChange={(event) => onChange('hugrabShippingRateOverrideEnabled', event.target.checked)}
    />
  )
}

export function BillingHugrabShippingOverrideAmountInput({
  config,
  draft,
  field,
  fallback,
  title,
  onChange,
}: {
  config: BillingConfigDto
  draft?: BillingConfigDraft
  field: 'hugrabShippingRateOverrideThreshold' | 'hugrabShippingRateOverrideAmount'
  fallback: string
  title: string
  onChange: UpdateDraft
}) {
  if (!isHugrabBillingClient(config)) return <span className="text-ink-3">-</span>
  return (
    <input
      type="number"
      step="0.01"
      min="0.01"
      className="markup-input-lg billing-config-input"
      style={{ width: '100%', textAlign: 'right', fontSize: 11.5 }}
      title={title}
      value={draft?.[field] ?? fallback}
      onChange={(event) => onChange(field, event.target.value)}
    />
  )
}
