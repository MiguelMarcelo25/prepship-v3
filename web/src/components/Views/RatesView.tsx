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
import { useShippingAccounts } from '../../hooks'
import type { DirectCarrierRateError } from '../../lib/v2-apiClient'
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
  // Default 1 lb 0 oz (was 16 oz — same total, just expressed in the
  // natural shipping-weight unit pair so operators don't see a number
  // shift on first paint).
  weightLb: '1',
  weightOz: '0',
  lengthIn: '12',
  widthIn: '9',
  heightIn: '4',
  fromZip: '90248',
  toZip: '',
  // Default markup is $0.00 — operators set their own per use. The
  // previous $1.00 default surprised users who didn't notice it and
  // got rates with an unexplained dollar tacked on.
  markup: '0.00',
}

type RatesResultState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'empty'; empty: RatesEmptyState; directCarrierErrors?: DirectCarrierRateError[] }
  | { kind: 'error'; message: string }
  | { kind: 'table'; rates: RateDto[]; directCarrierErrors?: DirectCarrierRateError[] }

function formatMoney(amount: number) {
  return `$${amount.toFixed(2)}`
}

const inputCls =
  'w-full px-3 py-2 rounded-lg border border-line bg-surface text-[13px] text-ink placeholder:text-ink-3 ' +
  'focus:border-brand/60 focus:ring-2 focus:ring-brand/15 transition-all duration-150 outline-none ' +
  'font-mono tabular-nums'

const labelCls = 'flex items-center gap-1.5 text-tiny font-bold uppercase tracking-[0.08em] text-ink-3 mb-1.5'

function getDirectCarrierErrors(rates: unknown): DirectCarrierRateError[] {
  const errors = (rates as { directCarrierErrors?: DirectCarrierRateError[] } | null)?.directCarrierErrors
  return Array.isArray(errors) ? errors : []
}

function DirectCarrierWarnings({ errors }: { errors?: DirectCarrierRateError[] }) {
  if (!errors?.length) return null
  return (
    <div className="mx-4 mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11.5px] text-amber-900">
      <div className="font-bold mb-1">Some direct carriers did not return rates</div>
      <ul className="space-y-1">
        {errors.map((error) => (
          <li key={`${error.accountId}-${error.provider}`}>
            <span className="font-semibold">{error.label}</span>: {error.message}
          </li>
        ))}
      </ul>
    </div>
  )
}

export default function RatesView() {
  const toastContext = useContext(ToastContext)
  const [form, setForm] = useState<RatesFormState>(DEFAULT_FORM)
  const [resultState, setResultState] = useState<RatesResultState>({ kind: 'idle' })
  const { accounts: shippingAccounts, isLoading: accountsLoading } = useShippingAccounts()

  const markupValue = parseRatesNumber(form.markup)
  const rows = resultState.kind === 'table'
    ? buildRateRows(resultState.rates, markupValue, shippingAccounts)
    : []

  async function fetchRates() {
    const validation = getRatesValidationState(form)
    if (validation) {
      setResultState({ kind: 'empty', empty: validation })
      return
    }

    setResultState({ kind: 'loading' })

    try {
      const carrierIds = shippingAccounts
        .map((account) => account.carrierId)
        .filter((carrierId): carrierId is string => Boolean(carrierId))
      const allRates = await apiClient.fetchRates({
        ...buildLiveRatesPayload(form),
        ...(carrierIds.length ? { carrierIds } : {}),
      })
      const directCarrierErrors = getDirectCarrierErrors(allRates)
      if (!Array.isArray(allRates) || allRates.length === 0) {
        setResultState({ kind: 'empty', empty: { icon: '📭', message: 'No rates returned.' }, directCarrierErrors })
        return
      }

      const availableRates = getAvailableRates(allRates)
      if (availableRates.length === 0) {
        setResultState({ kind: 'empty', empty: { icon: '📭', message: 'No available rates returned.' }, directCarrierErrors })
        return
      }

      setResultState({ kind: 'table', rates: availableRates, directCarrierErrors })
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

        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-7 gap-3">
          {/* Weight is split into two side-by-side inputs (lb + oz)
              that share TWO grid cells (col-span-2 on lg screens).
              The previous version crammed both inputs into a single
              cell which made each input ~70px wide — after the
              browser's spinner controls (~16px) and the absolute
              'lb'/'oz' suffix (~36px padding) there was almost no
              room left for the digit, and clicking landed on the
              spinner instead of giving focus to type. Doubling the
              cell width (and hiding the spinner) gives operators a
              real text-input target. */}
          <div className="lg:col-span-2">
            <label className={labelCls}>
              <Scale size={11} strokeWidth={2.5} /> Weight
            </label>
            {/* Spinner controls hidden via appearance-none on both
                webkit (Chrome/Edge/Safari) and Firefox so the entire
                input area is a typeable target — clicks always land
                on the input field, never on a spinner button. */}
            <div className="flex items-center gap-1.5">
              <div className="relative flex-1 min-w-0">
                <input
                  id="rWeightLb"
                  type="number"
                  min="0"
                  step="1"
                  inputMode="numeric"
                  value={form.weightLb}
                  onChange={(event) =>
                    setForm((current) => ({ ...current, weightLb: event.target.value }))
                  }
                  className={
                    inputCls +
                    ' pr-8 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none'
                  }
                  aria-label="Weight pounds"
                />
                <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] font-bold uppercase tracking-wider text-ink-3 pointer-events-none">
                  lb
                </span>
              </div>
              {/* OZ matches ShipStation exactly:
                    • step=0.1 — accepts decimals like '8.5 oz' for
                      sub-ounce precision (USPS rates are weight-
                      sensitive in 0.1 oz increments).
                    • no max — letting operators type 'lb=0 oz=20'
                      is valid; totalWeightOz() rolls it correctly
                      to 20 oz total. ShipStation does the same.
                    • inputMode='decimal' — surfaces the decimal
                      keyboard on mobile (vs the digits-only pad
                      that 'numeric' produces). */}
              <div className="relative flex-1 min-w-0">
                <input
                  id="rWeightOz"
                  type="number"
                  min="0"
                  step="0.1"
                  inputMode="decimal"
                  value={form.weightOz}
                  onChange={(event) =>
                    setForm((current) => ({ ...current, weightOz: event.target.value }))
                  }
                  className={
                    inputCls +
                    ' pr-8 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none'
                  }
                  aria-label="Weight ounces"
                />
                <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] font-bold uppercase tracking-wider text-ink-3 pointer-events-none">
                  oz
                </span>
              </div>
            </div>
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
            disabled={resultState.kind === 'loading' || accountsLoading}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-[13px] font-semibold text-white bg-gradient-to-br from-brand to-indigo-600 shadow-md hover:shadow-lg disabled:opacity-60 disabled:cursor-not-allowed transition-all duration-150 focus-visible:ring-2 focus-visible:ring-brand/40 focus-visible:ring-offset-2 outline-none"
          >
            {resultState.kind === 'loading' ? (
              <Loader2 size={14} strokeWidth={2.5} className="animate-spinSlow" />
            ) : (
              <SearchIcon size={14} strokeWidth={2.5} />
            )}
            {accountsLoading ? 'Loading carriers…' : resultState.kind === 'loading' ? 'Fetching…' : 'Get Live Rates'}
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
              <div className="w-full max-w-2xl">
                <DirectCarrierWarnings errors={resultState.directCarrierErrors} />
              </div>
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
              <DirectCarrierWarnings errors={resultState.directCarrierErrors} />
              <div className="overflow-x-auto">
                <table className="rates-table w-full text-[12.5px]">
                  <thead>
                    <tr className="bg-page/50 text-ink-3">
                      <th className="text-left px-3 py-2 font-bold uppercase tracking-wider text-2xs">Carrier</th>
                      <th className="text-left px-3 py-2 font-bold uppercase tracking-wider text-2xs">Account</th>
                      <th className="text-left px-3 py-2 font-bold uppercase tracking-wider text-2xs">Rate Source</th>
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
                        <td className="px-3 py-2.5 min-w-[150px]">
                          <div className="text-[11.5px] font-semibold text-ink-2">{row.rateSourceLabel}</div>
                          {row.rateSourceDetail ? (
                            <div className="mt-0.5 text-[10.5px] text-ink-3 whitespace-nowrap">
                              {row.rateSourceDetail}
                            </div>
                          ) : null}
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
