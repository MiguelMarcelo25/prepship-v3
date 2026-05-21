import { CloudCog, RefreshCw } from 'lucide-react';

type MaintenanceModePageProps = {
  mode?: 'api' | 'frontend' | 'checking';
  detail?: string | null;
  onRetry?: () => void;
  retrying?: boolean;
};

const copy = {
  api: {
    eyebrow: 'Service update in progress',
    title: "We'll be back soon",
    body:
      'PrepShip is temporarily unavailable while the API service finishes deploying or reconnecting. This usually clears automatically in a few minutes.',
    status: 'Waiting for backend services',
  },
  frontend: {
    eyebrow: 'New version deploying',
    title: 'Updating PrepShip',
    body:
      'A new frontend build is being published. Reload once the deployment finishes to pick up the latest version.',
    status: 'Waiting for frontend assets',
  },
  checking: {
    eyebrow: 'Checking system status',
    title: 'Connecting to PrepShip',
    body:
      'We are checking the application services before loading your workspace.',
    status: 'Checking service health',
  },
} as const;

export default function MaintenanceModePage({
  mode = 'api',
  detail,
  onRetry,
  retrying = false,
}: MaintenanceModePageProps) {
  const content = copy[mode];

  return (
    <main className="min-h-screen w-full bg-page px-5 py-8 text-ink">
      <div className="mx-auto flex min-h-[calc(100vh-4rem)] max-w-5xl flex-col items-center justify-center">
        <section className="w-full overflow-hidden rounded-lg border border-line bg-surface shadow-[0_24px_80px_rgba(15,23,42,0.10)]">
          <div className="grid min-h-[520px] grid-cols-[1.05fr_0.95fr] max-md:grid-cols-1">
            <div className="flex flex-col justify-between gap-10 p-10 max-md:p-7">
              <div>
                <div className="mb-8 inline-flex items-center gap-2 rounded-full border border-brand/15 bg-brand/5 px-3 py-1.5 text-[11px] font-extrabold uppercase tracking-[0.16em] text-brand">
                  <span className="h-2 w-2 rounded-full bg-emerald-500 shadow-[0_0_0_5px_rgba(16,185,129,0.14)]" />
                  {content.eyebrow}
                </div>

                <h1 className="max-w-xl font-display text-[44px] font-black leading-[1.02] tracking-normal text-ink max-md:text-[34px]">
                  {content.title}
                </h1>
                <p className="mt-5 max-w-xl text-[15px] leading-7 text-ink-2">
                  {content.body}
                </p>

                <div className="mt-8 grid max-w-xl grid-cols-2 gap-3 max-sm:grid-cols-1">
                  <div className="rounded-lg border border-line bg-surface-2 p-4">
                    <div className="text-[11px] font-extrabold uppercase tracking-[0.12em] text-ink-3">
                      Current status
                    </div>
                    <div className="mt-2 text-[14px] font-extrabold text-ink">{content.status}</div>
                  </div>
                  <div className="rounded-lg border border-line bg-surface-2 p-4">
                    <div className="text-[11px] font-extrabold uppercase tracking-[0.12em] text-ink-3">
                      Retry policy
                    </div>
                    <div className="mt-2 text-[14px] font-extrabold text-ink">Auto-checking every 15s</div>
                  </div>
                </div>

                {detail ? (
                  <p className="mt-4 max-w-xl rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-[12px] font-semibold leading-5 text-amber-800">
                    {detail}
                  </p>
                ) : null}
              </div>

              <div className="flex flex-wrap items-center gap-3">
                {onRetry ? (
                  <button
                    type="button"
                    onClick={onRetry}
                    disabled={retrying}
                    className="inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-brand px-4 text-[13px] font-extrabold text-white shadow-sm transition hover:bg-brandDark disabled:cursor-not-allowed disabled:opacity-70"
                  >
                    <RefreshCw className={retrying ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
                    Check again
                  </button>
                ) : null}
                <a
                  href="/maintenance"
                  className="inline-flex h-10 items-center justify-center rounded-lg border border-line bg-surface px-4 text-[13px] font-extrabold text-ink-2 transition hover:bg-surface-2"
                >
                  Open status page
                </a>
              </div>
            </div>

            <div className="relative flex items-center justify-center overflow-hidden border-l border-line bg-gradient-to-br from-sky-50 via-white to-emerald-50 p-10 max-md:min-h-[300px] max-md:border-l-0 max-md:border-t">
              <div className="absolute inset-x-10 top-10 h-24 rounded-full bg-white/70 blur-3xl" />
              <div className="relative w-full max-w-[340px] rounded-lg border border-white/80 bg-white/80 p-6 shadow-[0_20px_70px_rgba(37,99,235,0.18)] backdrop-blur">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-brand/10 text-brand ring-1 ring-brand/20">
                      <CloudCog className="h-6 w-6" />
                    </div>
                    <div>
                      <div className="text-[13px] font-black text-ink">PrepShip</div>
                      <div className="text-[11px] font-bold text-ink-3">Deployment monitor</div>
                    </div>
                  </div>
                  <div className="h-2.5 w-2.5 rounded-full bg-emerald-500 shadow-[0_0_0_5px_rgba(16,185,129,0.14)]" />
                </div>

                <div className="mt-8 space-y-4">
                  {['Build received', 'Services restarting', 'Health checks running'].map((label, index) => (
                    <div key={label} className="flex items-center gap-3">
                      <div
                        className={
                          index === 2
                            ? 'h-3 w-3 rounded-full border-2 border-brand border-t-transparent animate-spin'
                            : 'h-3 w-3 rounded-full bg-emerald-500'
                        }
                      />
                      <div className="h-2 flex-1 rounded-full bg-slate-200">
                        <div
                          className="h-full rounded-full bg-brand"
                          style={{ width: index === 2 ? '62%' : '100%' }}
                        />
                      </div>
                      <div className="w-28 text-right text-[11px] font-extrabold text-ink-3">{label}</div>
                    </div>
                  ))}
                </div>

                <div className="mt-8 rounded-lg border border-line bg-surface p-4">
                  <div className="text-[11px] font-extrabold uppercase tracking-[0.12em] text-ink-3">
                    What to do
                  </div>
                  <p className="mt-2 text-[13px] leading-6 text-ink-2">
                    Keep this tab open. PrepShip will retry automatically and return to the app when services are ready.
                  </p>
                </div>
              </div>
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}
