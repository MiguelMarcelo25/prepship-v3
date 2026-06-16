// PS-155: System Status panel extracted verbatim from SettingsView.tsx (behavior-preserving).
// Pure presentation — the parent owns systemStatus state + refreshSystemStatus(). This file
// receives values + the onRefresh callback as props. Strictly typed: it only
// uses primitives + a locally-shaped ObservabilityStatus (mirrors the parent's internal type).
import { motion } from 'framer-motion'
import { RefreshCcw } from 'lucide-react'
import { ButtonSpinner, SkeletonStack, StatusLine } from './settings-ui'
import { formatCaDateTimeLabeled } from '../../lib/ca-time'

// Locally-shaped mirror of the parent's internal ObservabilityStatus type.
export type ObservabilityStatus = {
  ok: boolean
  generatedAt: string
  process?: {
    nodeEnv?: string
    uptimeSeconds?: number
    memory?: {
      rssBytes?: number
      heapTotalBytes?: number
      heapUsedBytes?: number
    }
  }
  runtime?: Record<string, boolean | string | number | null | undefined>
  database?: {
    ok: boolean
    durationMs: number
    error?: string
  }
  apiTiming?: {
    routeCount?: number
    hotRoutes?: Array<{
      method: string
      path: string
      count: number
      errorCount: number
      p95Ms: number
      p99Ms: number
      maxMs: number
      lastStatus?: number | null
      lastObservedAt?: string | null
    }>
  }
}

function formatBytes(value?: number): string {
  if (!Number.isFinite(value ?? NaN)) return 'n/a'
  const units = ['B', 'KB', 'MB', 'GB']
  let size = Number(value)
  let unitIndex = 0
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024
    unitIndex += 1
  }
  return `${size >= 10 || unitIndex === 0 ? size.toFixed(0) : size.toFixed(1)} ${units[unitIndex]}`
}

function formatDurationSeconds(value?: number): string {
  if (!Number.isFinite(value ?? NaN)) return 'n/a'
  const seconds = Math.max(0, Math.floor(Number(value)))
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  if (hours > 0) return `${hours}h ${minutes}m`
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`
  return `${seconds}s`
}

function formatFlagValue(value: unknown): string {
  if (typeof value === 'boolean') return value ? 'enabled' : 'disabled'
  if (value === null || typeof value === 'undefined') return 'n/a'
  return String(value)
}

export function SystemStatusPanel({
  systemStatus,
  systemStatusLoading,
  systemStatusError,
  onRefresh,
}: {
  systemStatus: ObservabilityStatus | null
  systemStatusLoading: boolean
  systemStatusError: string | null
  onRefresh: () => void
}) {
  return (
                <div className="space-y-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="text-[12px] text-ink-3">
                      {systemStatus?.generatedAt
                        ? `Updated ${formatCaDateTimeLabeled(systemStatus.generatedAt)}`
                        : 'Status loads when this panel opens.'}
                    </div>
                    <motion.button
                      type="button"
                      onClick={() => void onRefresh()}
                      disabled={systemStatusLoading}
                      whileHover={!systemStatusLoading ? { y: -1 } : undefined}
                      whileTap={!systemStatusLoading ? { scale: 0.96 } : undefined}
                      transition={{ type: 'spring', stiffness: 400, damping: 22 }}
                      className="inline-flex items-center gap-1.5 h-8 px-3.5 rounded-lg text-[12px] font-semibold text-ink bg-surface hover:bg-surface-2 ring-1 ring-line disabled:opacity-60 disabled:cursor-not-allowed transition-colors duration-150"
                    >
                      {systemStatusLoading ? <ButtonSpinner /> : <RefreshCcw size={13} strokeWidth={2.25} />}
                      Refresh
                    </motion.button>
                  </div>

                  {systemStatusLoading && !systemStatus ? <SkeletonStack rows={4} /> : null}
                  {systemStatusError ? <StatusLine kind="error" message={systemStatusError} /> : null}

                  {systemStatus ? (
                    <div className="space-y-4">
                      <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
                        <div className="rounded-xl bg-surface ring-1 ring-line px-4 py-3 shadow-sm">
                          <div className="text-[10.5px] uppercase tracking-wider font-bold text-ink-3">
                            API Routes
                          </div>
                          <div className="mt-1 text-2xl font-extrabold text-ink tabular-nums">
                            {systemStatus.apiTiming?.routeCount ?? 0}
                          </div>
                          <div className="mt-1 text-[11.5px] text-ink-3">
                            tracked in timing memory
                          </div>
                        </div>
                        <div className="rounded-xl bg-surface ring-1 ring-line px-4 py-3 shadow-sm">
                          <div className="text-[10.5px] uppercase tracking-wider font-bold text-ink-3">
                            Heap Used
                          </div>
                          <div className="mt-1 text-2xl font-extrabold text-ink tabular-nums">
                            {formatBytes(systemStatus.process?.memory?.heapUsedBytes)}
                          </div>
                          <div className="mt-1 text-[11.5px] text-ink-3">
                            RSS {formatBytes(systemStatus.process?.memory?.rssBytes)}
                          </div>
                        </div>
                        <div className="rounded-xl bg-surface ring-1 ring-line px-4 py-3 shadow-sm">
                          <div className="text-[10.5px] uppercase tracking-wider font-bold text-ink-3">
                            Uptime
                          </div>
                          <div className="mt-1 text-2xl font-extrabold text-ink tabular-nums">
                            {formatDurationSeconds(systemStatus.process?.uptimeSeconds)}
                          </div>
                          <div className="mt-1 text-[11.5px] text-ink-3">
                            {systemStatus.process?.nodeEnv ?? 'runtime'} environment
                          </div>
                        </div>
                        <div className="rounded-xl bg-surface ring-1 ring-line px-4 py-3 shadow-sm">
                          <div className="text-[10.5px] uppercase tracking-wider font-bold text-ink-3">
                            DB Check
                          </div>
                          <div className={`mt-1 text-2xl font-extrabold tabular-nums ${
                            systemStatus.database?.ok === true
                              ? 'text-emerald-700'
                              : systemStatus.database?.ok === false
                                ? 'text-rose-700'
                                : 'text-ink'
                          }`}>
                            {systemStatus.database?.ok === true
                              ? 'OK'
                              : systemStatus.database?.ok === false
                                ? 'Slow'
                                : 'n/a'}
                          </div>
                          <div className="mt-1 text-[11.5px] text-ink-3">
                            {systemStatus.database?.durationMs ?? 0}ms ping
                          </div>
                        </div>
                      </div>

                      <div className="rounded-xl bg-surface ring-1 ring-line shadow-sm overflow-hidden">
                        <div className="px-4 py-3 border-b border-line">
                          <div className="text-[12px] font-extrabold text-ink">Runtime Flags</div>
                          <div className="text-[11.5px] text-ink-3 mt-0.5">
                            Confirms whether schedulers, backfills, and maintenance work are enabled.
                          </div>
                        </div>
                        <div className="divide-y divide-line">
                          {Object.entries(systemStatus.runtime ?? {}).map(([key, value]) => (
                            <div key={key} className="flex items-center justify-between gap-4 px-4 py-2.5">
                              <span className="text-[12px] font-semibold text-ink truncate">{key}</span>
                              <span className="text-[12px] text-ink-2 tabular-nums">{formatFlagValue(value)}</span>
                            </div>
                          ))}
                        </div>
                      </div>

                      <div className="rounded-xl bg-surface ring-1 ring-line shadow-sm overflow-hidden">
                        <div className="px-4 py-3 border-b border-line">
                          <div className="text-[12px] font-extrabold text-ink">Hot API Routes</div>
                          <div className="text-[11.5px] text-ink-3 mt-0.5">
                            Use this to spot slow or failing endpoints during a browser lag report.
                          </div>
                        </div>
                        <div className="overflow-x-auto">
                          <table className="min-w-full text-left text-[12px]">
                            <thead className="bg-surface-2 text-[10.5px] uppercase tracking-wider text-ink-3">
                              <tr>
                                <th className="px-4 py-2 font-bold">Route</th>
                                <th className="px-3 py-2 font-bold text-right">Count</th>
                                <th className="px-3 py-2 font-bold text-right">Errors</th>
                                <th className="px-3 py-2 font-bold text-right">p95</th>
                                <th className="px-3 py-2 font-bold text-right">p99</th>
                                <th className="px-3 py-2 font-bold text-right">Max</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-line">
                              {(systemStatus.apiTiming?.hotRoutes ?? []).length === 0 ? (
                                <tr>
                                  <td colSpan={6} className="px-4 py-4 text-center text-ink-3">
                                    No API timing samples yet.
                                  </td>
                                </tr>
                              ) : (
                                (systemStatus.apiTiming?.hotRoutes ?? []).map((route) => (
                                  <tr key={`${route.method}:${route.path}`} className="hover:bg-brand-bg/30">
                                    <td className="px-4 py-2.5 font-semibold text-ink">
                                      <span className="mr-2 text-ink-3">{route.method}</span>
                                      <span className="break-all">{route.path}</span>
                                    </td>
                                    <td className="px-3 py-2.5 text-right tabular-nums text-ink-2">{route.count}</td>
                                    <td className="px-3 py-2.5 text-right tabular-nums text-ink-2">{route.errorCount}</td>
                                    <td className="px-3 py-2.5 text-right tabular-nums text-ink-2">{Math.round(route.p95Ms)}ms</td>
                                    <td className="px-3 py-2.5 text-right tabular-nums text-ink-2">{Math.round(route.p99Ms)}ms</td>
                                    <td className="px-3 py-2.5 text-right tabular-nums text-ink-2">{Math.round(route.maxMs)}ms</td>
                                  </tr>
                                ))
                              )}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    </div>
                  ) : null}
                </div>
  )
}
