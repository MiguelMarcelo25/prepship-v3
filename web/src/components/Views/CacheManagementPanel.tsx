// PS-155: Cache Management panel extracted verbatim from SettingsView.tsx (behavior-preserving).
// Pure presentation — the parent owns refetchState + handleRefetchAllRates(). This file receives
// values + the onRefetch callback as props. The derived refetchStatus is recomputed here from the
// refetchState prop via buildSettingsRefetchStatus (same helper the parent used) so behavior is
// identical. Strictly typed (not @ts-nocheck).
import { motion } from 'framer-motion'
import { RefreshCcw } from 'lucide-react'
import { ButtonSpinner, StatusLine } from './settings-ui'
import { buildSettingsRefetchStatus, type SettingsRefetchState } from './settings-parity'

export function CacheManagementPanel({
  isRefetching,
  refetchState,
  onRefetch,
}: {
  isRefetching: boolean
  refetchState: SettingsRefetchState
  onRefetch: () => void
}) {
  const refetchStatus = buildSettingsRefetchStatus(refetchState)
  return (
                <div>
                  <motion.button
                    type="button"
                    onClick={() => void onRefetch()}
                    disabled={isRefetching}
                    whileHover={!isRefetching ? { y: -1 } : undefined}
                    whileTap={!isRefetching ? { scale: 0.96 } : undefined}
                    transition={{ type: 'spring', stiffness: 400, damping: 22 }}
                    className="inline-flex items-center gap-2 h-10 px-5 rounded-lg text-[13px] font-bold text-white bg-gradient-to-br from-violet-600 to-violet-700 shadow-md hover:shadow-lg disabled:opacity-60 disabled:cursor-not-allowed transition-shadow duration-150"
                  >
                    {isRefetching ? <ButtonSpinner /> : <RefreshCcw size={14} strokeWidth={2.25} />}
                    {isRefetching ? 'Refetching…' : 'Refetch All Rates & Clear Cache'}
                  </motion.button>

                  {refetchStatus.visible ? (
                    <StatusLine
                      kind={
                        refetchState.kind === 'loading' ? 'info' :
                        refetchState.kind === 'error' ? 'error' :
                        refetchState.kind === 'success' ? 'success' : 'info'
                      }
                      message={refetchStatus.text}
                    />
                  ) : null}
                </div>
  )
}
