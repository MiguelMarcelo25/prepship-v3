// PS-276 (slice 4-UI): the resi/comm tag. DISPLAY-ONLY — reads the BACKEND's resolved verdict
// (residentialClassification/source/confidence, published by buildCanonicalOrderModel) and renders
// it. It NEVER classifies. Trusted commercial = green; residential = neutral; a LOW-CONFIDENCE
// commercial (heuristic/fallback) = amber warning (the money-risk case the operator should see).
import { Box, MapPin } from 'lucide-react'

export type ResidentialTagFacts = {
  classification: 'residential' | 'commercial'
  source: string | null
  confidence: string | null
}

// Permissive shape — the FE order DTO carries the verdict top-level (slice 4) or under
// canonicalOrder.recipient; older payloads carry only the legacy residential booleans.
type ResidentialTagSource = {
  residentialClassification?: 'residential' | 'commercial' | null
  residentialSource?: string | null
  residentialConfidence?: string | null
  residential?: boolean | null
  sourceResidential?: boolean | null
  canonicalOrder?: {
    recipient?: {
      residentialClassification?: 'residential' | 'commercial' | null
      residentialSource?: string | null
      residentialConfidence?: string | null
    } | null
  } | null
} | null | undefined

/** Read the backend verdict off the order DTO (top-level, else canonicalOrder.recipient, else the
 *  legacy boolean for deploy-skew). Returns null when there is genuinely nothing to show. */
export function residentialTagFacts(order: ResidentialTagSource): ResidentialTagFacts | null {
  if (!order) return null
  const rec = order.canonicalOrder?.recipient ?? null
  const classification = order.residentialClassification ?? rec?.residentialClassification ?? null
  if (classification === 'residential' || classification === 'commercial') {
    return {
      classification,
      source: order.residentialSource ?? rec?.residentialSource ?? null,
      confidence: order.residentialConfidence ?? rec?.residentialConfidence ?? null,
    }
  }
  // Deploy-skew fallback: derive from the legacy booleans (no source/confidence available).
  const legacy = order.residential ?? order.sourceResidential
  if (typeof legacy === 'boolean') {
    return { classification: legacy ? 'residential' : 'commercial', source: null, confidence: null }
  }
  return null
}

const TRUSTED = new Set(['manual', 'source', 'validated'])

// Map the classifier source/confidence to a short operator-facing descriptor.
function sourceLabel(facts: ResidentialTagFacts): string {
  switch (facts.source) {
    case 'manual_override':
      return 'manual'
    case 'provider_marker':
      return 'carrier'
    case 'shipstation_source':
      return 'source'
    case 'address_validation':
      return 'validated'
    case 'company_heuristic':
      return 'guess'
    case 'fallback_residential':
      return 'default'
    default:
      return facts.confidence ?? '—'
  }
}

export function ResidentialTag({
  facts,
  className = '',
}: {
  facts: ResidentialTagFacts | null
  className?: string
}) {
  if (!facts) return null
  const trusted = facts.confidence != null && TRUSTED.has(facts.confidence)
  const isCommercial = facts.classification === 'commercial'

  // Trusted commercial = green; UNTRUSTED commercial (heuristic/fallback) = amber warning; residential = neutral.
  const tone = isCommercial
    ? trusted
      ? 'bg-emerald-100 text-emerald-950 ring-emerald-300 dark:bg-emerald-500/25 dark:text-emerald-950 dark:ring-emerald-400/50'
      : 'bg-amber-100/70 text-amber-700 ring-amber-200 dark:bg-amber-500/15 dark:text-amber-300 dark:ring-amber-500/30'
    : 'bg-surface-2 text-ink-2 ring-line'

  const Icon = isCommercial ? Box : MapPin
  const label = isCommercial ? 'Commercial' : 'Residential'
  const descriptor = sourceLabel(facts)

  return (
    <span
      className={`inline-flex items-center gap-1 h-5 px-1.5 rounded ring-1 text-[10px] font-bold ${tone} ${className}`}
      title={`${label} · ${descriptor}${facts.confidence ? ` (${facts.confidence})` : ''}`}
    >
      <Icon size={10} strokeWidth={2.5} />
      {label}
      {descriptor !== '—' ? <span>· {descriptor}</span> : null}
    </span>
  )
}
