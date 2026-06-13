// PS-166 (Wave 4, JSX-safe): leaf presentational rows extracted from the
// OrdersView side-panel SHIPPING section (id="sec-shipping"). These components
// own NO state — the dims→rate→label interactive core, every handler, and the
// dimsUserEditedRef all stay in the OrdersView shell and are passed down as
// props, so the React execution model is UNCHANGED and the offline cert fully
// verifies these slices (the same proven pattern already shipped in
// OrdersPanelSections.tsx for the Items/Recipient sections). Markup is moved
// BYTE-IDENTICAL. These leaves are STRICT (no @ts-nocheck) on purpose: an
// explicit props interface makes the compiler refuse any closure dependency
// that is not declared as a prop — the structural antidote to the @ts-nocheck
// silent-missing-dep crash class.
import { Save as SaveIcon } from 'lucide-react'

// W4a — the "Save weights & dims as SKU defaults" quiet text-link. The
// saveSkuDefaults HANDLER stays in OrdersView (it owns the recalcGroup logic
// pinned by ps-121); only the link markup moves here.
export function OrdersPanelSaveSkuDefaultsLink({
  shipped,
  saveSkuDefaults,
}: {
  shipped: boolean
  saveSkuDefaults: () => void | Promise<void>
}) {
  return shipped ? null : (
    <button
      type="button"
      onClick={() => void saveSkuDefaults()}
      className="mt-1 inline-flex items-center gap-1.5 text-[10.5px] font-medium text-ink-3 hover:text-brand transition group"
      title="Apply current weights and dims as defaults for this SKU"
    >
      <SaveIcon size={10} strokeWidth={2.25} className="text-ink-4 group-hover:text-brand transition" />
      Save weights & dims as SKU defaults
    </button>
  )
}
