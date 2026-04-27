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

        <div className="w-full max-w-sm">
          <div className="md:hidden text-center mb-6">
            <div className="flex items-baseline justify-center text-[26px] font-extrabold tracking-[-0.5px]">
              <span className="text-ink">PREP</span>
              <span className="text-brand">SHIP</span>
            </div>
            <div className="text-[10px] uppercase tracking-[0.4px] text-ink-3 mt-1">
              Dr Prepper Fulfillment
            </div>
          </div>

          <div className="bg-white rounded-2xl border border-line shadow-lg p-7 sm:p-8 backdrop-blur-sm">
            <div className="mb-6">
              <h2 className="text-[20px] font-bold text-ink tracking-[-0.3px]">
                {title}
              </h2>
              {subtitle ? (
                <p className="text-tiny text-ink-3 mt-1.5">{subtitle}</p>
              ) : null}
            </div>
            {children}
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
