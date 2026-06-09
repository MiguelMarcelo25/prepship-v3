import { motion } from 'framer-motion'

// PS-156: extracted verbatim from CarrierIntegrationsCard (module-level, self-contained).
// Modern animated checkbox — used in the Assign-Clients popover. Native
// <input type="checkbox"> hidden with sr-only; the visual is a div with
// brand-blue fill + tick path animated via spring physics. Tick draws via SVG
// strokeDasharray so it has a satisfying "draw on" motion when toggling.
// Designed to match the rest of the PrepShip brand vocabulary (brand-blue fill,
// soft ring, clean geometry).
export function ModernCheckbox({
  checked,
  onChange,
  disabled,
}: {
  checked: boolean
  onChange: () => void
  disabled?: boolean
}) {
  return (
    <span
      className={`relative inline-flex items-center justify-center w-[18px] h-[18px] flex-shrink-0 cursor-pointer transition-all duration-150 ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
      role="presentation"
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={onChange}
        disabled={disabled}
        className="sr-only"
      />
      {/* Decorative fill box. aria-hidden because the real control is the
          sr-only <input> above (and the whole row is a <label>). NOTE: do NOT
          add a Framer gesture prop (whileTap/whileHover/onTap) here — Motion
          auto-injects tabindex="0" on gesture-enabled non-interactive elements,
          which made this aria-hidden span focusable and triggered Chrome's
          "aria-hidden on a focused element" a11y warning. The check/uncheck
          spring below is animation-only (no gesture), so it stays accessible. */}
      <motion.span
        aria-hidden
        animate={{
          backgroundColor: checked
            ? 'rgb(var(--brand-rgb, 42 91 215))'
            : 'rgb(var(--surface-rgb, 255 255 255))',
          borderColor: checked
            ? 'rgb(var(--brand-rgb, 42 91 215))'
            : 'rgb(var(--border-rgb, 225 228 232))',
          scale: checked ? 1.05 : 1,
        }}
        transition={{ type: 'spring', stiffness: 500, damping: 28 }}
        className="absolute inset-0 rounded-[5px] border-2"
        style={{
          boxShadow: checked
            ? '0 2px 6px -1px rgb(var(--brand-rgb, 42 91 215) / 0.4), inset 0 1px 0 0 rgba(255,255,255,0.18)'
            : 'inset 0 1px 2px rgba(15, 23, 42, 0.04)',
        }}
      />
      {/* Tick path with stroke-draw animation — pathLength=1 lets us
          animate from 0 (invisible) to 1 (fully drawn) on toggle. */}
      <svg
        aria-hidden
        viewBox="0 0 18 18"
        className="relative w-[12px] h-[12px] pointer-events-none"
        style={{ zIndex: 1 }}
      >
        <motion.path
          d="M 4 9 L 8 13 L 14 5"
          fill="none"
          stroke="#fff"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          initial={false}
          animate={{
            pathLength: checked ? 1 : 0,
            opacity: checked ? 1 : 0,
          }}
          transition={{
            pathLength: { duration: 0.2, ease: [0.65, 0, 0.35, 1] },
            opacity: { duration: 0.1 },
          }}
        />
      </svg>
    </span>
  )
}
