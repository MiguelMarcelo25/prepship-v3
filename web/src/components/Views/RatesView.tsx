// @ts-nocheck
import { useContext, useState, type FormEvent, type KeyboardEvent } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import {
  DollarSign,
  Search as SearchIcon,
  Inbox,
  AlertTriangle,
  Loader2,
  Scale,
  Ruler,
  MapPin,
  Award,
} from 'lucide-react'
import type { RateDto } from '@prepshipv2/contracts/rates/contracts'
import { apiClient } from '../../api/client'
import { ToastContext } from '../../contexts/ToastContext'
import {
  buildLiveRatesPayload,
  buildRateRows,
  buildRateSelectionToast,
  buildRatesMetaLabel,
  buildRatesSummary,
  getAvailableRates,
  getCarrierBadgeClass,
  getRatesValidationState,
  parseRatesNumber,
  type RatesEmptyState,
  type RatesFormState,
} from './rates-parity'

const DEFAULT_FORM: RatesFormState = {
  weightOz: '16',
  lengthIn: '12',
  widthIn: '9',
  heightIn: '4',
  fromZip: '90248',
  toZip: '',
  markup: '1.00',
}

type RatesResultState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'empty'; empty: RatesEmptyState }
  | { kind: 'error'; message: string }
  | { kind: 'table'; rates: RateDto[] }

function formatMoney(amount: number) {
  return `$${amount.toFixed(2)}`
}

const inputCls =
  'w-full px-3 py-2 rounded-lg border border-line bg-surface text-[13px] text-ink placeholder:text-ink-3 ' +
  'focus:border-brand/60 focus:ring-2 focus:ring-brand/15 transition-all duration-150 outline-none ' +
  'font-mono tabular-nums'

const labelCls = 'flex items-center gap-1.5 text-tiny font-bold uppercase tracking-[0.08em] text-ink-3 mb-1.5'

export default function RatesView() {
  const toastContext = useContext(ToastContext)
  const [form, setForm] = useState<RatesFormState>(DEFAULT_FORM)
  const [resultState, setResultState] = useState<RatesResultState>({ kind: 'idle' })

  const markupValue = parseRatesNumber(form.markup)
  const rows = resultState.kind === 'table' ? buildRateRows(resultState.rates, markupValue) : []

  async function fetchRates() {
    const validation = getRatesValidationState(form)
    if (validation) {
      setResultState({ kind: 'empty', empty: validation })
      return
    }

    setResultState({ kind: 'loading' })

    try {
      const allRates = await apiClient.fetchRates(buildLiveRatesPayload(form))
      if (!Array.isArray(allRates) || allRates.length === 0) {
        setResultState({ kind: 'empty', empty: { icon: '📭', message: 'No rates returned.' } })
        return
      }

      const availableRates = getAvailableRates(allRates)
      if (availableRates.length === 0) {
        setResultState({ kind: 'empty', empty: { icon: '📭', message: 'No available rates returned.' } })
        return
      }

      setResultState({ kind: 'table', rates: availableRates })
    } catch (error) {
      setResultState({ kind: 'error', message: error instanceof Error ? error.message : 'Unknown error' })
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    void fetchRates()
  }

  function handleMarkupBlur() {
    if (resultState.kind === 'table') void fetchRates()
  }

  function handleMarkupKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key !== 'Enter') return
    event.preventDefault()
    void fetchRates()
  }

  return (
    <div className="view-content !p-5 !overflow-y-auto" id="view-rates">
      <motion.form
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
        className="bg-surface rounded-2xl border border-line shadow-sm p-5 max-w-4xl"
        onSubmit={handleSubmit}
      >
        <div className="flex items-center gap-3 mb-5">
          <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-emerald-500 to-emerald-600 flex items-center justify-center shadow-md ring-1 ring-emerald-400/20">
            <DollarSign size={20} strokeWidth={2.25} className="text-white" />
          </div>
          <div>
            <h2 className="text-[16px] font-extrabold text-ink font-display tracking-tight">Rate Calculator</h2>
            <p className="text-tiny text-ink-3 mt-0.5">Compare live carrier rates by weight, dimensions and ZIP</p>
          </div>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
          <div>
            <label htmlFor="rWeight" className={labelCls}>
              <Scale size={11} strokeWidth={2.5} /> Weight (oz)
            </label>
            <input
              id="rWeight"
              type="number"
              min="1"
              value={form.weightOz}
              onChange={(event) => setForm((current) => ({ ...current, weightOz: event.target.value }))}
              className={inputCls}
            />
          </div>
          <div>
            <label htmlFor="rLength" className={labelCls}>
              <Ruler size={11} strokeWidth={2.5} /> Length (in)
            </label>
            <input
              id="rLength"
              type="number"
              min="1"
              value={form.lengthIn}
              onChange={(event) => setForm((current) => ({ ...current, lengthIn: event.target.value }))}
              className={inputCls}
            />
          </div>
          <div>
            <label htmlFor="rWidth" className={labelCls}>
              <Ruler size={11} strokeWidth={2.5} className="rotate-90" /> Width (in)
            </label>
            <input
              id="rWidth"
              type="number"
              min="1"
              value={form.widthIn}
              onChange={(event) => setForm((current) => ({ ...current, widthIn: event.target.value }))}
              className={inputCls}
            />
          </div>
          <div>
            <label htmlFor="rHeight" className={labelCls}>
              <Ruler size={11} strokeWidth={2.5} className="-rotate-45" /> Height (in)
            </label>
            <input
              id="rHeight"
              type="number"
              min="1"
              value={form.heightIn}
              onChange={(event) => setForm((current) => ({ ...current, heightIn: event.target.value }))}
              className={inputCls}
            />
          </div>
          <div>
            <label htmlFor="rFromZip" className={labelCls}>
              <MapPin size={11} strokeWidth={2.5} /> From ZIP
            </label>
            <input
              id="rFromZip"
              type="text"
              value={form.fromZip}
              onChange={(event) => setForm((current) => ({ ...current, fromZip: event.target.value }))}
              className={inputCls}
            />
          </div>
          <div>
            <label htmlFor="rToZip" className={labelCls}>
              <MapPin size={11} strokeWidth={2.5} /> To ZIP
            </label>
            <input
              id="rToZip"
              type="text"
              placeholder="e.g. 10001"
              value={form.toZip}
              onChange={(event) => setForm((current) => ({ ...current, toZip: event.target.value }))}
              className={inputCls}
            />
          </div>
        </div>

        <div className="mt-5 flex items-center gap-3 flex-wrap">
          <motion.button
            type="submit"
            whileHover={{ y: -1 }}
            whileTap={{ scale: 0.96 }}
            disabled={resultState.kind === 'loading'}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-[13px] font-semibold text-white bg-gradient-to-br from-brand to-indigo-600 shadow-md hover:shadow-lg disabled:opacity-60 disabled:cursor-not-allowed transition-all duration-150 focus-visible:ring-2 focus-visible:ring-brand/40 focus-visible:ring-offset-2 outline-none"
          >
            {resultState.kind === 'loading' ? (
              <Loader2 size={14} strokeWidth={2.5} className="animate-spinSlow" />
            ) : (
              <SearchIcon size={14} strokeWidth={2.5} />
            )}
            {resultState.kind === 'loading' ? 'Fetching…' : 'Get Live Rates'}
          </motion.button>

          <label className="inline-flex items-center gap-2 text-[12.5px] text-ink-2 font-medium">
            Markup $
            <input
              id="globalMarkup"
              type="number"
              value={form.markup}
              step="0.25"
              min="0"
              onChange={(event) => setForm((current) => ({ ...current, markup: event.target.value }))}
              onBlur={handleMarkupBlur}
              onKeyDown={handleMarkupKeyDown}
              className="w-20 px-2 py-1 rounded-md border border-line bg-page/60 text-center text-[12.5px] text-ink font-mono tabular-nums focus:border-brand/60 focus:ring-2 focus:ring-brand/15 transition-all duration-150 outline-none"
            />
          </label>
        </div>
      </motion.form>

      {/* Results */}
      <div id="ratesResult" className="mt-5 max-w-4xl">
        <AnimatePresence mode="wait">
          {resultState.kind === 'loading' ? (
            <motion.div
              key="loading"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="flex flex-col items-center justify-center gap-3 py-12 bg-surface rounded-2xl border border-line"
            >
              <Loader2 size={24} strokeWidth={2.25} className="text-brand animate-spinSlow" />
              <div className="text-tiny text-ink-3 uppercase tracking-wider font-semibold">Fetching live rates…</div>
            </motion.div>
          ) : resultState.kind === 'empty' ? (
            <motion.div
              key="empty"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              className="flex flex-col items-center justify-center gap-3 py-14 bg-surface rounded-2xl border border-line"
            >
              <motion.div
                initial={{ scale: 0.6, rotate: -8 }}
                animate={{ scale: 1, rotate: 0 }}
                transition={{ type: 'spring', stiffness: 300, damping: 16 }}
                className="w-14 h-14 rounded-2xl bg-gradient-to-br from-slate-100 to-slate-200 ring-1 ring-line flex items-center justify-center"
              >
                <Inbox size={26} strokeWidth={2} className="text-ink-3" />
              </motion.div>
              <div className="text-sm font-semibold text-ink font-display tracking-tight">{resultState.empty.message}</div>
            </motion.div>
          ) : resultState.kind === 'error' ? (
            <motion.div
              key="error"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              className="flex flex-col items-center justify-center gap-3 py-14 bg-surface rounded-2xl border border-danger/20"
            >
              <motion.div
                initial={{ scale: 0.6 }}
                animate={{ scale: 1 }}
                transition={{ type: 'spring', stiffness: 320, damping: 18 }}
                className="w-14 h-14 rounded-full bg-danger-bg ring-2 ring-danger/15 flex items-center justify-center"
              >
                <AlertTriangle size={26} strokeWidth={2.25} className="text-danger" />
              </motion.div>
              <div className="text-sm font-semibold text-danger">Unable to fetch rates</div>
              <div className="text-xs2 text-ink-3 max-w-md text-center leading-relaxed">{resultState.message}</div>
            </motion.div>
          ) : resultState.kind === 'table' ? (
            <motion.div
              key="table"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.3 }}
              className="bg-surface rounded-2xl border border-line shadow-sm overflow-hidden"
            >
              <div className="px-4 py-3 border-b border-line bg-gradient-to-b from-page to-surface-2/30 flex items-center gap-3">
                <div className="flex-1">
                  <div className="text-[13px] font-bold text-ink font-display tracking-tight">{buildRatesSummary(form, rows.length)}</div>
                  <div className="text-tiny text-ink-3 mt-0.5">{buildRatesMetaLabel(form)}</div>
                </div>
              </div>
              <div className="overflow-x-auto">
                <table className="rates-table w-full text-[12.5px]">
                  <thead>
                    <tr className="bg-page/50 text-ink-3">
                      <th className="text-left px-3 py-2 font-bold uppercase tracking-wider text-2xs">Carrier</th>
                      <th className="text-left px-3 py-2 font-bold uppercase tracking-wider text-2xs">Account</th>
                      <th className="text-left px-3 py-2 font-bold uppercase tracking-wider text-2xs">Service</th>
                      <th className="text-right px-3 py-2 font-bold uppercase tracking-wider text-2xs">Base</th>
                      <th className="text-right px-3 py-2 font-bold uppercase tracking-wider text-2xs">Your Price</th>
                      <th className="text-right px-3 py-2 font-bold uppercase tracking-wider text-2xs">Profit</th>
                      <th className="px-3 py-2" />
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row, idx) => (
                      <motion.tr
                        key={`${row.rate.carrierCode}-${row.rate.shippingProviderId ?? 'na'}-${row.rate.serviceCode}`}
                        initial={{ opacity: 0, y: 4 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: idx * 0.025, duration: 0.18 }}
                        className={`border-t border-line transition-colors hover:bg-brand-bg/30 ${row.isBest ? 'bg-emerald-50/40' : ''}`}
                      >
                        <td className="px-3 py-2.5">
                          <span className={`carrier-badge ${getCarrierBadgeClass(row.carrierCode)} !text-2xs !px-1.5 !py-0.5 !rounded-md`}>
                            {row.carrierBadgeLabel}
                          </span>
                        </td>
                        <td className={`px-3 py-2.5 ${row.carrierNickname ? 'text-ink-2 font-semibold' : 'text-ink-4'}`}>
                          {row.carrierNickname || '—'}
                        </td>
                        <td className="px-3 py-2.5 text-ink">
                          <span>{row.serviceLabel}</span>
                          {row.isBest ? (
                            <span className="ml-2 inline-flex items-center gap-1 text-2xs font-bold text-emerald-700 bg-emerald-100 px-1.5 py-0.5 rounded-md">
                              <Award size={10} strokeWidth={2.75} />
                              CHEAPEST
                            </span>
                          ) : null}
                        </td>
                        <td className="px-3 py-2.5 text-right font-mono tabular-nums font-bold text-ink">{formatMoney(row.baseCost)}</td>
                        <td className="px-3 py-2.5 text-right font-mono tabular-nums font-bold text-orange-600">{formatMoney(row.yourPrice)}</td>
                        <td className="px-3 py-2.5 text-right font-mono tabular-nums font-semibold text-emerald-600">+{formatMoney(row.profit)}</td>
                        <td className="px-3 py-2.5 text-right">
                          <motion.button
                            whileHover={{ y: -1 }}
                            whileTap={{ scale: 0.94 }}
                            type="button"
                            onClick={() => toastContext?.addToast(buildRateSelectionToast(row))}
                            className="px-2.5 py-1 rounded-md text-2xs font-semibold text-white bg-gradient-to-br from-brand to-indigo-600 shadow-sm hover:shadow-md transition-all duration-150"
                          >
                            Select
                          </motion.button>
                        </td>
                      </motion.tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </motion.div>
          ) : null}
        </AnimatePresence>
      </div>
    </div>
  )
}
