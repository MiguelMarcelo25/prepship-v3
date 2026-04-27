import type { ReactNode } from 'react';
import { ShieldCheck, Truck, Boxes } from 'lucide-react';

type AuthLayoutProps = {
  title: string;
  subtitle?: string;
  children: ReactNode;
  footer?: ReactNode;
};

export default function AuthLayout({
  title,
  subtitle,
  children,
  footer,
}: AuthLayoutProps) {
  return (
    <div className="flex-1 w-full min-h-screen flex bg-page">
      {/* Brand panel — hidden below md, full-bleed on the left otherwise */}
      <div className="hidden md:flex relative md:w-[44%] lg:w-[48%] overflow-hidden">
        <div
          className="absolute inset-0"
          style={{
            background:
              'linear-gradient(135deg, #1a48c0 0%, #2a5bd7 45%, #4f7ce6 100%)',
          }}
        />
        {/* Decorative blurred shapes */}
        <div
          className="absolute -top-32 -left-32 w-[420px] h-[420px] rounded-full opacity-40 blur-3xl"
          style={{ background: 'radial-gradient(circle, #7ea7ff 0%, transparent 70%)' }}
        />
        <div
          className="absolute -bottom-40 -right-24 w-[480px] h-[480px] rounded-full opacity-30 blur-3xl"
          style={{ background: 'radial-gradient(circle, #b9cdff 0%, transparent 70%)' }}
        />
        {/* Subtle grid overlay */}
        <div
          className="absolute inset-0 opacity-[0.07]"
          style={{
            backgroundImage:
              'linear-gradient(to right, #fff 1px, transparent 1px), linear-gradient(to bottom, #fff 1px, transparent 1px)',
            backgroundSize: '40px 40px',
          }}
        />

        <div className="relative z-10 flex flex-col justify-between p-12 lg:p-16 text-white w-full">
          <div>
            <div className="flex items-baseline text-[28px] font-extrabold tracking-[-0.5px]">
              <span>PREP</span>
              <span className="text-[#ffd166]">SHIP</span>
            </div>
            <div className="mt-1 text-[11px] uppercase tracking-[0.4px] text-white/70">
              Dr Prepper Fulfillment
            </div>
          </div>

          <div className="space-y-6">
            <h1 className="text-[34px] lg:text-[40px] font-extrabold leading-[1.1] tracking-[-0.5px]">
              Ship faster.
              <br />
              <span className="text-[#ffd166]">Stay ahead.</span>
            </h1>
            <p className="text-[14px] text-white/80 leading-relaxed max-w-md">
              Centralized order, inventory, and rate-shop tooling for the
              Dr Prepper fulfillment team — built for speed.
            </p>

            <div className="space-y-3 pt-2">
              <FeatureRow
                Icon={Truck}
                label="Real-time order sync"
                desc="ShipStation orders refresh on a 15s heartbeat."
              />
              <FeatureRow
                Icon={Boxes}
                label="Inventory & locations"
                desc="Live stock counts across every bin and warehouse."
              />
              <FeatureRow
                Icon={ShieldCheck}
                label="Secure access"
                desc="Encrypted sessions with role-based permissions."
              />
            </div>
          </div>

          <div className="text-[11px] text-white/50">
            © {new Date().getFullYear()} Dr Prepper USA · Gardena, CA
          </div>
        </div>
      </div>

      {/* Form panel */}
      <div className="flex-1 flex items-center justify-center px-4 py-10 relative">
        {/* Mobile-only background — same gradient, dimmed */}
        <div
          className="md:hidden absolute inset-0 -z-10"
          style={{
            background:
              'linear-gradient(135deg, #eef2ff 0%, #f0f2f5 60%, #e0e8ff 100%)',
          }}
        />

        <div className="w-full max-w-md lg:max-w-lg">
          <div className="md:hidden text-center mb-6">
            <div className="flex items-baseline justify-center text-[30px] font-extrabold tracking-[-0.5px]">
              <span className="text-ink">PREP</span>
              <span className="text-brand">SHIP</span>
            </div>
            <div className="text-[11px] uppercase tracking-[0.4px] text-ink-3 mt-1">
              Dr Prepper Fulfillment
            </div>
          </div>

          {/* Gradient-bordered glass card with brand-tinted shadow */}
          <div className="relative group">
            {/* Outer glow — brand-tinted ambient shadow */}
            <div
              className="absolute -inset-1 rounded-[20px] opacity-60 blur-xl transition-opacity duration-500 group-hover:opacity-80 pointer-events-none"
              style={{
                background:
                  'linear-gradient(135deg, rgba(42,91,215,0.35), rgba(255,209,102,0.25) 50%, rgba(42,91,215,0.35))',
              }}
            />

            {/* Gradient border wrapper */}
            <div
              className="relative rounded-[18px] p-px"
              style={{
                background:
                  'linear-gradient(135deg, rgba(255,255,255,0.9), rgba(195,208,245,0.6) 30%, rgba(42,91,215,0.25) 70%, rgba(255,209,102,0.45))',
              }}
            >
              <div
                className="auth-card relative rounded-[17px] p-9 sm:p-10 lg:p-12 overflow-hidden"
                style={{
                  background:
                    'linear-gradient(180deg, rgba(255,255,255,0.92) 0%, rgba(255,255,255,0.78) 100%)',
                  backdropFilter: 'blur(24px) saturate(140%)',
                  WebkitBackdropFilter: 'blur(24px) saturate(140%)',
                  boxShadow:
                    '0 30px 60px -20px rgba(26,72,192,0.35), 0 12px 24px -10px rgba(26,31,46,0.18), inset 0 1px 0 rgba(255,255,255,0.9)',
                }}
              >
                {/* Subtle top sheen */}
                <div
                  className="absolute inset-x-0 top-0 h-px"
                  style={{
                    background:
                      'linear-gradient(90deg, transparent, rgba(255,255,255,0.95) 50%, transparent)',
                  }}
                />
                {/* Inner accent glow */}
                <div
                  className="absolute -top-24 -right-16 w-56 h-56 rounded-full opacity-40 blur-3xl pointer-events-none"
                  style={{
                    background:
                      'radial-gradient(circle, rgba(42,91,215,0.35), transparent 70%)',
                  }}
                />
                <div
                  className="absolute -bottom-20 -left-16 w-48 h-48 rounded-full opacity-30 blur-3xl pointer-events-none"
                  style={{
                    background:
                      'radial-gradient(circle, rgba(255,209,102,0.4), transparent 70%)',
                  }}
                />

                <div className="relative">
                  <div className="mb-7">
                    <h2 className="text-[26px] sm:text-[28px] font-bold text-ink tracking-[-0.5px] leading-tight">
                      {title}
                    </h2>
                    {subtitle ? (
                      <p className="text-[13px] text-ink-3 mt-2">{subtitle}</p>
                    ) : null}
                  </div>
                  {children}
                </div>
              </div>
            </div>
          </div>

          {footer ? (
            <div className="mt-5 text-center text-tiny text-ink-3">
              {footer}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function FeatureRow({
  Icon,
  label,
  desc,
}: {
  Icon: typeof ShieldCheck;
  label: string;
  desc: string;
}) {
  return (
    <div className="flex items-start gap-3">
      <div className="shrink-0 w-9 h-9 rounded-lg bg-white/15 backdrop-blur flex items-center justify-center border border-white/20">
        <Icon size={16} className="text-white" />
      </div>
      <div>
        <div className="text-[13px] font-semibold text-white">{label}</div>
        <div className="text-[12px] text-white/70 leading-snug">{desc}</div>
      </div>
    </div>
  );
}
