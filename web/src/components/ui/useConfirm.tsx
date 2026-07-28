// useConfirm — promise-based bridge from `confirm()` to <ConfirmModal />.
//
// ConfirmModal is declarative: you hold a boolean and render it. Most
// destructive handlers are imperative and read
//
//   if (!confirm("Delete this?")) return
//   ...do the work
//
// Rewriting each of those into "open a modal, stash the pending action in
// state, run it from the modal's onConfirm" splits one readable handler into
// three disconnected pieces, and every new confirm has to repeat the split.
// This hook keeps the original shape -- the only change at the call site is
// awaiting instead of calling:
//
//   if (!(await confirm({ title: "Delete this?" }))) return
//   ...do the work
//
// The native dialog is also a genuine liability beyond looking wrong: it is
// chrome-styled with the origin ("prepshipv4.vercel.app says"), it blocks the
// whole tab, and Chrome lets a user permanently suppress it with "prevent this
// page from creating additional dialogs" -- after which confirm() silently
// returns false forever and destructive actions appear to do nothing.
//
// Usage:
//   const { confirm, confirmElement } = useConfirm()
//   ...
//   return <>{confirmElement}<YourUi /></>
//
// One instance handles any number of call sites: each awaits its own promise
// and only one dialog can be open at a time.

import { useCallback, useRef, useState } from 'react'
import { ConfirmModal } from './ConfirmModal'

export interface ConfirmOptions {
  title: string
  description?: React.ReactNode
  confirmLabel?: string
  cancelLabel?: string
  tone?: 'default' | 'danger' | 'magic' | 'info'
}

export function useConfirm() {
  // `content` is deliberately separate from `pending` and is NOT cleared on
  // answer. ConfirmModal animates out through AnimatePresence, so it still
  // renders for ~180ms after open flips false -- clearing the text with it
  // would blank the dialog mid-exit. It stays until the next confirm
  // overwrites it.
  const [content, setContent] = useState<ConfirmOptions | null>(null)
  const [open, setOpen] = useState(false)
  // The resolver lives in a ref, not state: resolving is a side effect, and a
  // side effect inside a state updater runs twice under StrictMode. The
  // executor below runs synchronously inside the caller's event handler, so
  // writing the ref there is never a render-phase write.
  const resolverRef = useRef<((answer: boolean) => void) | null>(null)

  const confirm = useCallback((options: ConfirmOptions) => {
    return new Promise<boolean>((resolve) => {
      // A second confirm while one is open would otherwise strand the first
      // promise and leave its handler awaiting forever.
      resolverRef.current?.(false)
      resolverRef.current = resolve
      setContent(options)
      setOpen(true)
    })
  }, [])

  const settle = useCallback((answer: boolean) => {
    const resolve = resolverRef.current
    resolverRef.current = null
    setOpen(false)
    resolve?.(answer)
  }, [])

  const confirmElement = (
    <ConfirmModal
      open={open}
      title={content?.title ?? ''}
      description={content?.description}
      confirmLabel={content?.confirmLabel}
      cancelLabel={content?.cancelLabel}
      tone={content?.tone}
      onConfirm={() => settle(true)}
      onCancel={() => settle(false)}
    />
  )

  // Exposed so a host that owns its own document-level Escape handler can stand
  // down while the dialog is up. Both listeners sit on `document`, and
  // ConfirmModal's is registered later, so the host's handler runs FIRST on the
  // same keypress -- stopPropagation in ConfirmModal cannot retract that, and
  // stopImmediatePropagation would be too late. Escape would otherwise dismiss
  // the dialog and trigger the host's close in one press.
  return { confirm, confirmElement, isConfirmOpen: open }
}
