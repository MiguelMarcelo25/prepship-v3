// PS-166/PS-258 (Hook wave 3): the pure panel-UI-STATE container — owns ONLY
// the detail-side-panel section collapse map (`collapsedSections`) and its
// toggle helper (`toggleSection`).
//
// This is the genuinely-CLEAN slice of panel UI state: `setCollapsedSections`
// is written exclusively by `toggleSection` (no rate/label/apiClient/persist
// coupling), so the useState + helper move VERBATIM. The panel JSX was already
// extracted to OrdersDetailSidePanel.tsx; OrdersView just owns this state and
// passes `collapsedSections` / `toggleSection` down as props — that
// pass-through is unchanged, only re-sourced from this hook.
//
// Deliberately LEFT in the OrdersView shell (entangled with rate/label/form
// machinery, per the task):
//   - `panelForm` / `setPanelForm` and the form-init `useEffect`
//     (reads locations/packages/autoBestRate, calls rate code),
//   - `panelRatePreview` / `panelRateLoading`,
//   - the lifted `handlePanel*` handlers (Ship-Acct / Package / confirmation /
//     insurance — they touch apiClient / setOrderSelected* / refreshPanelBestRate).
import { useState } from 'react'

// Local, self-contained type alias — mirrors the one OrdersView (and the panel
// components) keep for the three collapsible detail-panel sections.
type PanelSectionKey = 'shipping' | 'items' | 'recipient'

export interface UsePanelStateResult {
  collapsedSections: Record<PanelSectionKey, boolean>
  toggleSection: (key: PanelSectionKey) => void
}

export function usePanelState(): UsePanelStateResult {
  const [collapsedSections, setCollapsedSections] = useState<Record<PanelSectionKey, boolean>>({
    shipping: false,
    items: false,
    recipient: false,
  })

  const toggleSection = (key: PanelSectionKey) => {
    setCollapsedSections((current) => ({ ...current, [key]: !current[key] }))
  }

  return {
    collapsedSections,
    toggleSection,
  }
}
