import { Loader2 } from 'lucide-react'

// StateToggle — an explicit ON/OFF switch with the state word built in.
//
// Exists because a pill BUTTON labeled "ENABLED" is ambiguous: operators read
// button text as the ACTION it performs ("click to enable"), not the state.
// A switch is unambiguous — the knob's position + color IS the current state
// (green/right = on, red/left = off), and clicking flips it. The title text
// spells out what the click will do.
export function StateToggle({
  on,
  onLabel = 'ENABLED',
  offLabel = 'DISABLED',
  loading,
  disabled,
  onClick,
  title,
}: {
  on: boolean
  onLabel?: string
  offLabel?: string
  loading?: boolean
  disabled?: boolean
  onClick: () => void
  title?: string
}) {
  const green = 'rgb(4 120 87)'
  const red = 'rgb(190 18 60)'
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={onClick}
      disabled={!!(disabled || loading)}
      title={title}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 7,
        height: 30,
        padding: '0 10px 0 6px',
        borderRadius: 999,
        border: 'none',
        cursor: loading ? 'wait' : disabled ? 'not-allowed' : 'pointer',
        background: on ? 'rgb(16 185 129 / 0.10)' : 'rgb(244 63 94 / 0.08)',
        boxShadow: `inset 0 0 0 1px ${on ? 'rgb(16 185 129 / 0.35)' : 'rgb(244 63 94 / 0.3)'}`,
        transition: 'background 150ms ease-out, box-shadow 150ms ease-out',
      }}
    >
      {/* the switch track + knob — position/color IS the state */}
      <span
        aria-hidden
        style={{
          position: 'relative',
          width: 26,
          height: 15,
          borderRadius: 999,
          background: on ? 'rgb(16 185 129)' : 'rgb(244 63 94 / 0.55)',
          transition: 'background 150ms ease-out',
          flexShrink: 0,
        }}
      >
        <span
          style={{
            position: 'absolute',
            top: 2,
            left: on ? 13 : 2,
            width: 11,
            height: 11,
            borderRadius: 999,
            background: '#fff',
            boxShadow: '0 1px 2px rgba(15, 23, 42, 0.3)',
            transition: 'left 150ms ease-out',
          }}
        />
      </span>
      <span
        style={{
          fontSize: 10.5,
          fontWeight: 800,
          letterSpacing: '0.05em',
          color: on ? green : red,
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
        }}
      >
        {loading ? <Loader2 size={11} strokeWidth={2.5} className="animate-spin" /> : null}
        {loading ? (on ? 'Disabling…' : 'Enabling…') : on ? onLabel : offLabel}
      </span>
    </button>
  )
}
