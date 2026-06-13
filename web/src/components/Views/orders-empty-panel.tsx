// PS-166 (Wave 2a3): the "no order selected" empty-panel JSX, moved VERBATIM
// out of OrdersView.tsx. Pure-on-args (the optional onHide callback is the
// only input) — no hooks, no component state, byte-identical markup. Strict
// TypeScript.
import { Inbox, X as XIcon } from 'lucide-react'

export function buildEmptyPanel(onHide?: () => void) {
  const kbdCls =
    'inline-block bg-surface-3 px-1.5 py-px rounded text-[10px] border border-line-2 font-mono tabular-nums'
  return (
    <div className="relative flex flex-col items-center justify-center h-full px-5 py-10 text-center text-ink-3 animate-[fadeIn_0.3s_ease-out]">
      {/* Drawer-style close button — top-right of the empty panel. */}
      {onHide ? (
        <button
          type="button"
          onClick={onHide}
          aria-label="Hide this panel when no order is selected"
          title="Hide this panel when no order is selected"
          className="absolute top-2 right-2 inline-flex items-center justify-center w-7 h-7 rounded-md text-ink-3 hover:text-ink hover:bg-surface-2 ring-1 ring-transparent hover:ring-line transition"
        >
          <XIcon size={14} strokeWidth={2.5} aria-hidden />
        </button>
      ) : null}

      {/* Subtle iconographic mark — quiet, framed, refined.
          Linear / Mercury idiom: small icon inside a soft tinted ring,
          rather than a giant emoji. Reads as a state indicator, not a
          mascot. */}
      <div className="mb-4 inline-flex items-center justify-center w-12 h-12 rounded-2xl bg-surface-2 ring-1 ring-line text-ink-3 animate-[bounceIn_0.5s_cubic-bezier(0.34,1.56,0.64,1)]">
        <Inbox size={20} strokeWidth={1.75} aria-hidden />
      </div>

      <div className="text-[14px] font-semibold mb-1 text-ink-2 font-display tracking-tight">
        No order selected
      </div>
      <div className="text-[11.5px] leading-relaxed mb-5 text-ink-3">
        Click any row to view details
      </div>
      <div className="text-left text-[11px] leading-loose text-ink-4 border-t border-line pt-3.5 w-full max-w-[180px] space-y-0.5">
        <div><kbd className={kbdCls}>↑↓</kbd> <span className="ml-1">Navigate rows</span></div>
        <div><kbd className={kbdCls}>Enter</kbd> <span className="ml-1">Select / deselect</span></div>
        <div><kbd className={kbdCls}>Esc</kbd> <span className="ml-1">Deselect &amp; close</span></div>
        <div><kbd className={kbdCls}>⌘C</kbd> <span className="ml-1">Copy order #</span></div>
      </div>
    </div>
  )
}
