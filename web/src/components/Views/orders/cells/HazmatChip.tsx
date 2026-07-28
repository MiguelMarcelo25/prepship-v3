import { AlertTriangle } from 'lucide-react'

/**
 * Dangerous-goods badge for an order row.
 *
 * Mirrors the orange Dangerous Goods badge ShipStation shows in its order
 * sidebar, so a hazmat order is identifiable while scanning the list instead of
 * only after opening it. That matters most when a rule is supposed to be
 * declaring orders automatically and the operator needs to confirm it did.
 *
 * Display only. The backend owns whether a declaration is active; this renders
 * what it reports and never infers hazmat from SKU, item name, or anything else
 * on the row.
 */
export function HazmatChip({
  status,
  decisionSource,
}: {
  /** Backend declaration state. 'clear' or null means not declared. */
  status?: 'active' | 'clear' | null
  /** Whether a rule or a person declared it, shown in the tooltip. */
  decisionSource?: 'manual' | 'automation' | null
}) {
  if (status !== 'active') return null

  const origin = decisionSource === 'automation'
    ? 'Declared by an automation rule'
    : decisionSource === 'manual'
      ? 'Declared manually by an operator'
      : 'Dangerous goods declared'

  return (
    <span
      title={`${origin}. Open the order to see the declaration.`}
      className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-amber-900 bg-amber-100 ring-1 ring-amber-300"
      data-testid="order-hazmat-chip"
    >
      <AlertTriangle size={10} className="shrink-0" />
      Hazmat
    </span>
  )
}

export default HazmatChip
