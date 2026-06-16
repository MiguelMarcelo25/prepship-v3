// PS-258 (slice): the two PURE print-queue payload parsers, extracted VERBATIM
// from OrdersView.tsx. Output depends ONLY on the argument (plus the imported
// pure reader toStringValue) — no React, no hooks, no state, no fetch, no side
// effects. OrdersView imports both and calls them unchanged.
//
//  - getQueueableLabelUrl: depth-bounded recursive extractor that pulls the
//    first usable label-URL string out of a loose value (pdf/href/url/
//    download(_)Url/label(_)Url), rejecting the '[object Object]' sentinel and
//    empties. Guards queue/recovery against corrupt saved label URLs.
//  - getQueuePayloadEntries: reads the queued-orders entry array out of a loose
//    print-queue payload (queuedOrders → entries → []).
//
// Per user override unlock shipped data on 2026-05-23: queue/recovery paths must
// reject corrupt saved label URLs without weakening shipped/cancelled edit locks.
// This extraction is byte-identical refactor only — no logic, behavior, or lock
// change; the shipped/cancelled protections are untouched.
import { toStringValue } from './orders-row-display'
import type { PrintQueueEntryDto } from '../../types/api'

export function getQueueableLabelUrl(value: unknown): string | null {
  const seen = new Set<unknown>()
  const pick = (candidate: unknown, depth = 0): string | null => {
    const direct = toStringValue(candidate)?.trim()
    if (direct) return direct
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate) || depth > 3 || seen.has(candidate)) return null
    seen.add(candidate)
    const record = candidate as Record<string, unknown>
    return (
      pick(record.pdf, depth + 1) ??
      pick(record.href, depth + 1) ??
      pick(record.url, depth + 1) ??
      pick(record.downloadUrl, depth + 1) ??
      pick(record.download_url, depth + 1) ??
      pick(record.labelUrl, depth + 1) ??
      pick(record.label_url, depth + 1)
    )
  }
  const labelUrl = pick(value)
  if (!labelUrl || labelUrl === '[object Object]') return null
  return labelUrl
}

export function getQueuePayloadEntries(payload: unknown): PrintQueueEntryDto[] {
  if (payload == null || typeof payload !== 'object') return []
  const record = payload as Record<string, unknown>
  if (Array.isArray(record.queuedOrders)) return record.queuedOrders as PrintQueueEntryDto[]
  if (Array.isArray(record.entries)) return record.entries as PrintQueueEntryDto[]
  return []
}
