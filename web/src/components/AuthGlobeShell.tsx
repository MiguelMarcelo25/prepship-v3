/**
 * AuthGlobeShell — shared dark Network Globe layout for auth pages.
 *
 * Login already inlines this layout (so we don't refactor a file you've
 * been editing). Signup and ForgotPassword (and Reset, if you want)
 * use this shell instead of the bright `AuthLayout`, so the three auth
 * routes feel like one product.
 *
 * Props mirror AuthLayout's so swapping between layouts is a one-line
 * import change:
 *   - `title`     → big card heading
 *   - `subtitle`  → muted subhead under the heading
 *   - `children`  → the form body
 *   - `footer`    → the link line under the card
 *
 * The shell also exports `DarkField` and the palette `C` so each page
 * can render dark inputs that match the card without restyling them.
 */

import type { ReactNode } from 'react';
import { Mail, ShieldCheck, Truck, Boxes } from 'lucide-react';
import { CobeGlobe } from './CobeGlobe';

/* Calm Network Globe palette — exported so pages can match. */
export const C = {
  canvas: '#0c1118',
  surface: 'rgba(17, 22, 31, 0.72)',
  text: '#eef1f6',
  muted: '#8a93a6',
  faint: '#5a6478',
  line: 'rgba(255, 255, 255, 0.08)',
  lineBright: 'rgba(255, 255, 255, 0.14)',
  accent: '#7aa2c8',
  accentSoft: '#a4c1da',
  accentDeep: '#4f7aa1',
  danger: '#ff8a92',
  dangerBg: 'rgba(220, 50, 50, 0.08)',
  dangerBorder: 'rgba(220, 50, 50, 0.32)',
};

const FEATURES = [
  { Icon: Truck, title: 'Real-time order sync', body: 'ShipStation orders refresh on a 15s heartbeat.' },
  { Icon: Boxes, title: 'Inventory & locations', body: 'Live stock counts across every bin and warehouse.' },
  { Icon: ShieldCheck, title: 'Secure access', body: 'Encrypted sessions with role-based permissions.' },
] as const;

type AuthGlobeShellProps = {
  title: string;
  subtitle?: string;
  children: ReactNode;
  footer?: ReactNode;
};

export function AuthGlobeShell({ title, subtitle, children, footer }: AuthGlobeShellProps) {
  return (
    <main
      className="relative min-h-screen w-full overflow-hidden"
      style={{
        background:
          'radial-gradient(900px 700px at 78% 12%, rgba(122,162,200,0.06), transparent 60%), radial-gradient(1100px 800px at 12% 100%, rgba(50,70,100,0.10), transparent 65%), linear-gradient(180deg, #0c1118 0%, #0a0e15 100%)',
        color: C.text,
        fontFamily:
          '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
      }}
    >
      {/* Status pill, top-right */}
      <div
        className="pointer-events-none absolute right-6 top-6 z-20 hidden items-center gap-2.5 lg:flex"
        aria-live="polite"
      >
        <span
          className="inline-block h-1.5 w-1.5 rounded-full"
          style={{
            background: C.accent,
            boxShadow: '0 0 0 3px rgba(122, 162, 200, 0.18)',
          }}
          aria-hidden
        />
        <span
          className="text-[10px] uppercase tracking-[0.28em]"
          style={{ color: C.muted, fontFamily: 'ui-monospace, "JetBrains Mono", monospace' }}
        >
          All systems operational
        </span>
      </div>

      <div className="relative z-10 grid min-h-screen w-full grid-cols-1 lg:grid-cols-[3fr_2fr]">
        {/* LEFT — brand + globe */}
        <section className="relative flex flex-col">
          {/* Mobile-only brand + small globe */}
          <div className="flex flex-col items-center gap-6 px-6 pt-8 pb-2 lg:hidden">
            <Wordmark />
            <div className="w-full max-w-[260px]">
              <CobeGlobe />
            </div>
          </div>

          {/* Desktop logo lockup top-left */}
          <div className="absolute left-12 top-12 hidden lg:block">
            <Wordmark />
          </div>

          {/* Desktop hero panel */}
          <div className="relative hidden h-full flex-col justify-between p-12 lg:flex">
            <div aria-hidden />
            <div className="grid grid-cols-1 items-center gap-12 xl:grid-cols-[1fr_1fr]">
              <div className="max-w-md">
                <h1 className="text-[44px] font-medium leading-[1.05] tracking-[-0.02em]">
                  Ship faster.
                  <br />
                  <span style={{ color: C.accent }}>Stay ahead.</span>
                </h1>
                <p className="mt-5 max-w-sm text-sm leading-relaxed" style={{ color: C.muted }}>
                  Centralized order, inventory, and rate-shop tooling for the Dr Prepper
                  fulfillment team — built for speed.
                </p>

                <ul className="mt-8 space-y-2">
                  {FEATURES.map((f) => (
                    <li
                      key={f.title}
                      className="group relative flex items-start gap-3.5 rounded-lg border border-transparent px-3 py-2.5 transition-all duration-300"
                      onMouseEnter={(e) => {
                        e.currentTarget.style.borderColor = C.line;
                        e.currentTarget.style.background = 'rgba(255,255,255,0.02)';
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.borderColor = 'transparent';
                        e.currentTarget.style.background = 'transparent';
                      }}
                    >
                      <span
                        className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-md"
                        style={{
                          border: `1px solid ${C.line}`,
                          background: 'rgba(255,255,255,0.02)',
                          color: C.accent,
                        }}
                        aria-hidden
                      >
                        <f.Icon size={18} strokeWidth={1.6} />
                      </span>
                      <div>
                        <div className="text-[14px] font-medium" style={{ color: C.text }}>
                          {f.title}
                        </div>
                        <div className="mt-0.5 text-[13px] leading-relaxed" style={{ color: C.muted }}>
                          {f.body}
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              </div>

              <div className="mx-auto w-full max-w-[440px]">
                <CobeGlobe />
              </div>
            </div>
            <div aria-hidden />
          </div>
        </section>

        {/* RIGHT — auth card */}
        <section className="relative flex items-center justify-center p-6 sm:p-10 lg:p-12">
          <div className="w-full max-w-[420px]">
            <div
              className="card-enter relative w-full rounded-2xl px-8 py-10"
              style={{
                background:
                  'linear-gradient(180deg, rgba(255,255,255,0.025), rgba(255,255,255,0.005)), ' + C.surface,
                border: `1px solid ${C.line}`,
                backdropFilter: 'blur(10px) saturate(120%)',
                WebkitBackdropFilter: 'blur(10px) saturate(120%)',
              }}
            >
              {/* Soft top-edge glow */}
              <div
                aria-hidden
                className="pointer-events-none absolute inset-x-0 -top-px h-24 rounded-t-2xl"
                style={{
                  background: 'radial-gradient(60% 80% at 50% 0%, rgba(122, 162, 200, 0.18), transparent 70%)',
                }}
              />

              <h2
                className="relative text-[26px] font-medium leading-[1.15] tracking-[-0.015em]"
                style={{ color: C.text }}
              >
                {title}
              </h2>
              {subtitle ? (
                <p className="relative mt-2 text-sm leading-relaxed" style={{ color: C.muted }}>
                  {subtitle}
                </p>
              ) : null}

              <div className="relative mt-7">{children}</div>
            </div>

            {footer ? (
              <div className="mt-6 text-center text-[13px]" style={{ color: C.muted }}>
                {footer}
              </div>
            ) : null}
          </div>
        </section>
      </div>

      {/* Bottom legal strip */}
      <div className="pointer-events-none absolute inset-x-0 bottom-3 z-20 flex items-center justify-center gap-4 px-6 lg:justify-between lg:px-12">
        <span
          className="text-[10px] tracking-[0.18em]"
          style={{ color: C.faint, fontFamily: 'ui-monospace, "JetBrains Mono", monospace' }}
        >
          © {new Date().getFullYear()} Dr Prepper USA · Gardena, CA
        </span>
      </div>

      {/* Card entrance keyframe — scoped via inline <style> so we don't
          touch any global CSS files. */}
      <style>{`
        @keyframes card-enter {
          from { opacity: 0; transform: translateY(8px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        .card-enter {
          animation: card-enter 450ms cubic-bezier(0.22, 1, 0.36, 1) both;
        }
        @media (prefers-reduced-motion: reduce) {
          .card-enter { animation: none; }
        }
      `}</style>
    </main>
  );
}

/* ────────────────────────────────────────────────────────────── */

export function Wordmark() {
  return (
    <div className="flex items-center gap-3">
      <svg width="34" height="34" viewBox="0 0 40 40" fill="none" aria-hidden>
        <path
          d="M20 3 L34 11 L34 29 L20 37 L6 29 L6 11 Z"
          stroke="rgba(255,255,255,0.42)"
          strokeWidth="1.2"
        />
        <path
          d="M14 16 L20 13 L26 16 L26 24 L20 27 L14 24 Z M20 13 V27 M14 16 L26 16"
          stroke={C.accent}
          strokeWidth="1.4"
          strokeLinejoin="round"
        />
      </svg>
      <div className="leading-none">
        <div className="text-2xl font-medium tracking-[-0.015em]" style={{ color: C.text }}>
          PrepShip
        </div>
        <div
          className="mt-1 text-[10px] uppercase tracking-[0.3em]"
          style={{ color: C.muted, fontFamily: 'ui-monospace, "JetBrains Mono", monospace' }}
        >
          Dr Prepper Fulfillment
        </div>
      </div>
    </div>
  );
}

type DarkFieldProps = React.InputHTMLAttributes<HTMLInputElement> & {
  label: string;
  Icon: typeof Mail;
  trailing?: React.ReactNode;
};

export function DarkField({ label, Icon, trailing, ...rest }: DarkFieldProps) {
  return (
    <label className="block">
      <span className="text-[12px] font-medium" style={{ color: C.muted }}>
        {label}
      </span>
      <div
        className="mt-1.5 flex items-center rounded-lg px-3 transition-colors focus-within:!border-[#7aa2c8]"
        style={{
          background: 'rgba(0, 0, 0, 0.25)',
          border: `1px solid ${C.line}`,
        }}
      >
        <span style={{ color: C.muted }}>
          <Icon size={15} strokeWidth={1.8} aria-hidden />
        </span>
        <input
          {...rest}
          className="ml-2 h-11 flex-1 bg-transparent text-[15px] outline-none placeholder:opacity-40"
          style={{ color: C.text }}
        />
        {trailing}
      </div>
    </label>
  );
}

/* Convenience — the calm primary submit button used across pages. */
type SubmitButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  loading?: boolean;
  loadingLabel?: string;
};

export function PrimarySubmit({
  loading,
  loadingLabel = 'Working…',
  disabled,
  children,
  ...rest
}: SubmitButtonProps) {
  return (
    <button
      {...rest}
      type="submit"
      disabled={disabled || loading}
      className="h-11 w-full rounded-lg text-[13px] font-medium uppercase tracking-[0.22em] transition-all duration-200 disabled:opacity-60"
      style={{
        background: C.accent,
        border: `1px solid ${C.accent}`,
        color: C.canvas,
        fontFamily: 'ui-monospace, "JetBrains Mono", monospace',
      }}
      onMouseEnter={(e) => {
        if (!e.currentTarget.disabled) {
          e.currentTarget.style.background = C.accentSoft;
          e.currentTarget.style.boxShadow = '0 8px 28px -12px rgba(122,162,200,0.6)';
        }
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = C.accent;
        e.currentTarget.style.boxShadow = 'none';
      }}
    >
      <span className="flex items-center justify-center gap-2.5">
        {loading ? (
          <>
            <span
              className="h-3 w-3 animate-spin rounded-full border-2"
              style={{ borderColor: 'rgba(12,17,24,0.3)', borderTopColor: C.canvas }}
              aria-hidden
            />
            <span>{loadingLabel}</span>
          </>
        ) : (
          <span>{children}</span>
        )}
      </span>
    </button>
  );
}

/* Calm error banner shared across pages. */
export function ErrorBanner({ message }: { message: string }) {
  return (
    <div
      className="rounded-lg border px-3 py-2 text-[13px]"
      style={{
        background: C.dangerBg,
        borderColor: C.dangerBorder,
        color: C.danger,
      }}
      role="alert"
    >
      {message}
    </div>
  );
}

/* Calm link used in card body / footer — accent on rest, soft on hover. */
export function AccentLink({ to, children }: { to: string; children: ReactNode }) {
  // Lazy import the router Link so this file has no react-router dep
  // when used as just types — avoids circular deps in some setups.
  // Pages import their own Link separately; this is just for the
  // common "link in muted footer text" case.
  return (
    <a
      href={to}
      className="font-medium transition-colors"
      style={{ color: C.accent }}
      onMouseEnter={(e) => (e.currentTarget.style.color = C.accentSoft)}
      onMouseLeave={(e) => (e.currentTarget.style.color = C.accent)}
    >
      {children}
    </a>
  );
}
