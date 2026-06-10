// @ts-nocheck
// PS-155: Sandbox — Test Orders panel extracted verbatim from SettingsView.tsx (behavior-preserving).
// Pure presentation — the parent owns all seed/purge handlers + confirm dialogs + the sandboxState
// union. This file receives values + callbacks as props. @ts-nocheck because the sandboxState union
// type is declared inline in the parent (phantom DTO type from the parent's perspective). The derived
// sandboxBusy/isSeeding/isPurging flags are recomputed here from the sandboxState prop so the JSX
// stays verbatim and behavior is identical.
import { motion } from 'framer-motion'
import { AlertTriangle, Plus, Trash2 } from 'lucide-react'
import { ButtonSpinner, SkeletonStack, StatusLine } from './settings-ui'

export function SandboxTestOrdersPanel({
  testClients,
  testClientsLoading,
  seedCount,
  sandboxState,
  onSeedCountChange,
  onSeed,
  onPurge,
  onRefreshClients,
}) {
  const sandboxBusy = sandboxState.kind === 'loading'
  const isSeeding = sandboxBusy && sandboxState.op === 'seed'
  const isPurging = sandboxBusy && sandboxState.op === 'purge'
  return (
                <div>
                  {testClientsLoading ? (
                    <SkeletonStack rows={3} />
                  ) : testClients.length === 0 ? (
                    <div className="flex items-start gap-2 px-3 py-2.5 rounded-lg bg-amber-50 ring-1 ring-amber-200 mb-4">
                      <AlertTriangle size={14} strokeWidth={2.5} className="text-amber-600 flex-shrink-0 mt-0.5" />
                      <div className="text-[11.5px] text-amber-900 leading-relaxed">
                        <strong>No test clients found.</strong> Run the purge SQL in the Supabase editor first — see{' '}
                        <code className="px-1 py-0.5 rounded bg-amber-100/70 ring-1 ring-amber-200 text-[10.5px] font-mono text-amber-800">
                          drizzle/apply-test-client-purge.sql
                        </code>
                        .
                      </div>
                    </div>
                  ) : (
                    <div className="mb-4">
                      <div className="text-[11px] uppercase tracking-wider font-bold text-ink-3 mb-2">
                        Active test clients
                      </div>
                      <ul className="space-y-1">
                        {testClients.map((c) => (
                          <li
                            key={c.id}
                            className="flex items-center justify-between px-3 py-2 rounded-lg bg-surface ring-1 ring-line shadow-sm"
                          >
                            <span className="text-[13px] font-semibold text-ink">{c.name}</span>
                            <span className="text-[11px] text-ink-3 tabular-nums">
                              {c.order_count} order{c.order_count === 1 ? '' : 's'}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {/* Action row */}
                  <div className="flex flex-wrap items-center gap-2 pt-3 border-t border-line">
                    <label className="inline-flex items-center gap-1.5 text-[12px] text-ink-2 font-medium">
                      Count:
                      <input
                        type="number"
                        min="1"
                        max="200"
                        value={seedCount}
                        onChange={(e) => onSeedCountChange(e.target.value)}
                        className="w-[70px] h-8 px-2 rounded-md ring-1 ring-line bg-surface text-[12.5px] tabular-nums text-ink focus:ring-brand/40 focus:ring-2 outline-none transition"
                      />
                    </label>

                    <motion.button
                      type="button"
                      onClick={() => void onSeed()}
                      disabled={sandboxBusy || testClients.length === 0}
                      whileHover={!sandboxBusy && testClients.length > 0 ? { y: -1 } : undefined}
                      whileTap={!sandboxBusy && testClients.length > 0 ? { scale: 0.96 } : undefined}
                      transition={{ type: 'spring', stiffness: 400, damping: 22 }}
                      className="inline-flex items-center gap-1.5 h-8 px-3.5 rounded-lg text-[12px] font-semibold text-white bg-gradient-to-br from-amber-500 to-amber-600 shadow-sm hover:shadow-md disabled:opacity-50 disabled:cursor-not-allowed transition-shadow duration-150"
                    >
                      {isSeeding ? <ButtonSpinner /> : <Plus size={13} strokeWidth={2.5} />}
                      {isSeeding ? 'Seeding…' : 'Seed Test Orders'}
                    </motion.button>

                    <motion.button
                      type="button"
                      onClick={() => void onPurge()}
                      disabled={sandboxBusy || testClients.length === 0}
                      whileHover={!sandboxBusy && testClients.length > 0 ? { y: -1 } : undefined}
                      whileTap={!sandboxBusy && testClients.length > 0 ? { scale: 0.96 } : undefined}
                      transition={{ type: 'spring', stiffness: 400, damping: 22 }}
                      className="inline-flex items-center gap-1.5 h-8 px-3.5 rounded-lg text-[12px] font-semibold text-rose-700 bg-rose-50 hover:bg-rose-100 ring-1 ring-rose-200 disabled:opacity-50 disabled:cursor-not-allowed transition-colors duration-150"
                    >
                      {isPurging ? <ButtonSpinner /> : <Trash2 size={13} strokeWidth={2.25} />}
                      {isPurging ? 'Purging…' : 'Purge Test Orders'}
                    </motion.button>
                  </div>

                  {sandboxState.kind === 'loading' ? (
                    <StatusLine kind="info" message={
                      sandboxState.op === 'seed' ? 'Seeding test orders…'
                      : sandboxState.op === 'purge' ? 'Purging test orders…'
                      : 'Working…'
                    } />
                  ) : sandboxState.kind === 'success' ? (
                    <StatusLine kind="success" message={sandboxState.message} />
                  ) : sandboxState.kind === 'error' ? (
                    <StatusLine kind="error" message={sandboxState.message} />
                  ) : null}
                </div>
  )
}
