import { useContext, useEffect, useMemo, useState, type FormEvent } from 'react'
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
// TODO PS-257: restore real type — @prepshipv2/contracts is erased at runtime and absent in v4.
type RateDto = any
import { apiClient } from '../../api/client'
import { api } from '../../lib/api'
import { ToastContext } from '../../contexts/ToastContext'
// Shared carrier badge — official UPS/USPS SVG logos with fallback pills.
import CarrierBadge from '../CarrierBadge'
import { Table, type TableColumn } from '../ui/Table'
import { useShippingAccounts } from '../../hooks'
import type { DirectCarrierRateError } from '../../lib/v2-apiClient'
import {
  buildLiveRatesPayload,
  buildRateRows,
  buildRateSelectionToast,
  formatRateMoney,
  buildRatesMetaLabel,
  buildRatesSummary,
  getRatesValidationState,
  type RateRowView,
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
  // PS-188: origin is backend-owned — seeded from GET /locations/default-ship-from
  // on mount (the same getDefaultShipFrom the label + rate paths quote from).
  fromZip: '',
  toZip: '',
}

type RatesResultState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'empty'; empty: RatesEmptyState; directCarrierErrors?: DirectCarrierRateError[] }
  | { kind: 'error'; message: string }
  | { kind: 'table'; rates: RateDto[]; bestRate: RateDto | null; directCarrierErrors?: DirectCarrierRateError[] }

function CustomerShippingRateCell({ row }: { row: RateRowView }) {
  // 2026-05-13 (v2): the "Cost $X.XX" subline is only shown when there is an
  // actual markup. With no markup the sub-line just repeated the figure above
  // it and the cell read like a stuttering ticket stub. Threshold 0.005 catches
  // floating-point near-zero (9.84 - 9.8399999999 ≈ 1e-10) without suppressing
  // a legitimate $0.01 markup. The "+ Markup $X.XX" suffix stays suppressed
  // when markup IS present — operators see the cost breakdown, not the
  // per-line margin disclosure.
  //
  // PS-498: the top figure is the CUSTOMER SHIPPING RATE and is now titled as
  // such. It was titled "Label Cost" while showing the customer price — and
  // when that price was missing it fell back to the internal cost, so the
  // internal number appeared under a customer-facing label.
  //
  // The markup subline needs a KNOWN margin. A null margin is not "no markup";
  // it is "unknown", so the cost line stays hidden rather than implying parity.
  const hasMarkup = row.shippingMarginAmount != null && row.shippingMarginAmount >= 0.005
  return (
    <div
      className="leading-tight"
      title={`Customer Shipping Rate ${formatRateMoney(row.customerShippingRate)}`}
    >
      <div className="font-mono tabular-nums text-[12.5px] font-extrabold text-orange-600">
        {formatRateMoney(row.customerShippingRate)}
      </div>
      {hasMarkup ? (
        <div className="mt-0.5 whitespace-nowrap text-[10.5px] font-semibold text-ink-3">
          Cost {formatRateMoney(row.selectedRateCost)}
        </div>
      ) : null}
    </div>
  )
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

  // PS-188: seed the origin ZIP from the backend's canonical default ship-from
  // (the SAME getDefaultShipFrom the label + rate paths quote from). Only fills
  // an untouched field — an operator-typed origin is never overwritten. If the
  // request fails, the field stays blank and the backend still quotes from its
  // own default.
  useEffect(() => {
    let cancelled = false
    void api.get<{ postalCode: string | null }>('/locations/default-ship-from')
      .then((res) => {
        if (cancelled || !res?.postalCode) return
        setForm((current) => (current.fromZip.trim() ? current : { ...current, fromZip: res.postalCode! }))
      })
      .catch(() => { /* no default Location configured — leave blank */ })
    return () => { cancelled = true }
  }, [])

  const rows = resultState.kind === 'table'
    ? buildRateRows(resultState.rates, resultState.bestRate)
    : []
  const rateColumns = useMemo<TableColumn<RateRowView>[]>(() => [
    {
      key: 'carrier',
      label: 'Carrier',
      width: 84,
      minWidth: 76,
      maxWidth: 110,
      sortable: true,
      // 2026-05-13: every column toggleable + draggable per operator
      // request (Awaiting-Shipment parity).
      sortValue: (row) => row.carrierCode,
      render: (row) => <CarrierBadge code={row.carrierCode} size="sm" />,
    },
    {
      key: 'account',
      label: 'Account',
      width: 140,
      minWidth: 110,
      maxWidth: 210,
      sortable: true,
      sortValue: (row) => row.carrierNickname ?? '',
      render: (row) => (
        <span className={row.carrierNickname ? 'text-ink-2 font-semibold' : 'text-ink-4'}>
          {row.carrierNickname || '-'}
        </span>
      ),
    },
    {
      key: 'source',
      label: 'Rate Source',
      width: 240,
      minWidth: 180,
      maxWidth: 300,
      sortable: true,
      sortValue: (row) => `${row.rateSourceLabel} ${row.rateSourceDetail ?? ''}`,
      render: (row) => (
        <div className="max-w-[240px]">
          <div className={`inline-flex max-w-full rounded-md px-2 py-1 text-[11.5px] font-extrabold leading-tight ring-1 ${row.rateSourceTone}`} title={row.rateSourceLabel}>
            <span className="truncate">{row.rateSourceLabel}</span>
          </div>
          {row.rateSourceDetail ? (
            <div className="mt-1 truncate text-[10.5px] font-semibold leading-tight text-ink-3" title={row.rateSourceDetail}>
              {row.rateSourceDetail}
            </div>
          ) : null}
        </div>
      ),
    },
    {
      key: 'service',
      label: 'Service',
      width: 300,
      minWidth: 220,
      maxWidth: 420,
      sortable: true,
      sortValue: (row) => row.serviceLabel,
      render: (row) => (
        <div className="min-w-0">
          <span>{row.serviceLabel}</span>
          {row.isBest ? (
            <span className="ml-2 inline-flex items-center gap-1 text-2xs font-bold text-emerald-700 bg-emerald-100 px-1.5 py-0.5 rounded-md">
              <Award size={10} strokeWidth={2.75} />
              CHEAPEST
            </span>
          ) : null}
        </div>
      ),
    },
    {
      key: 'labelCost',
      // PS-498: this column shows the CUSTOMER rate, so it says so. It was
      // labelled "Label Cost" while rendering the customer price.
      label: 'Customer Shipping Rate',
      width: 150,
      minWidth: 130,
      maxWidth: 180,
      align: 'right',
      sortable: true,
      // 2026-05-13: every column toggleable + draggable per operator
      // request (Awaiting-Shipment parity).
      //
      // PS-498: a missing customer rate sorts to one deterministic end rather
      // than borrowing the selected cost or collapsing to 0 — sorting an
      // unknown price as $0.00 would park it among the genuinely cheapest.
      // The CHEAPEST badge is unaffected: `isBest` comes from the backend's
      // selectedRateKey identity, never from this ordering.
      sortValue: (row) => row.customerShippingRate ?? Number.POSITIVE_INFINITY,
      render: (row) => <CustomerShippingRateCell row={row} />,
    },
    {
      key: 'action',
      label: '',
      width: 90,
      minWidth: 84,
      align: 'right',
      sortable: false,
      // 2026-05-13: removed pinned + hideable:false per operator
      // request — every column toggleable + draggable (Awaiting
      // Shipment parity). Reset button in the Columns ▾ picker
      // restores defaults if hidden by mistake.
      render: (row) => (
        <motion.button
          whileHover={{ y: -1 }}
          whileTap={{ scale: 0.94 }}
          type="button"
          onClick={() => toastContext?.addToast(buildRateSelectionToast(row))}
          className="px-2.5 py-1 rounded-md text-2xs font-semibold text-white bg-gradient-to-br from-brand to-indigo-600 shadow-sm hover:shadow-md transition-all duration-150"
        >
          Select
        </motion.button>
      ),
    },
  ], [toastContext])

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
      const response = await apiClient.browseRates({
        ...buildLiveRatesPayload(form),
        includeAllDirectCarriers: true,
        ...(carrierIds.length ? { carrierIds } : {}),
      })
      const allRates = Array.isArray(response?.rates) ? response.rates : []
      const directCarrierErrors = getDirectCarrierErrors(response)
      if (!Array.isArray(allRates) || allRates.length === 0) {
        setResultState({ kind: 'empty', empty: { icon: '📭', message: 'No rates returned.' }, directCarrierErrors })
        return
      }

      setResultState({
        kind: 'table',
        rates: allRates,
        bestRate: response?.bestRate ?? null,
        directCarrierErrors,
      })
    } catch (error) {
      setResultState({ kind: 'error', message: error instanceof Error ? error.message : 'Unknown error' })
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
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

        <div className="grid grid-cols-1 sm:grid-cols-3 lg:grid-cols-7 gap-3">
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

        </div>
      </motion.form>

      {/* Results */}
      <div id="ratesResult" className="mt-5 w-full max-w-4xl">
        <AnimatePresence>
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
              className="bg-surface rounded-2xl border border-line shadow-sm overflow-clip"
            >
              <div className="px-4 py-3 border-b border-line bg-gradient-to-b from-page to-surface-2/30 flex items-center gap-3">
                <div className="flex-1">
                  <div className="text-[13px] font-bold text-ink font-display tracking-tight">{buildRatesSummary(form, rows.length)}</div>
                  <div className="text-tiny text-ink-3 mt-0.5">{buildRatesMetaLabel(form)}</div>
                </div>
              </div>
              <DirectCarrierWarnings errors={resultState.directCarrierErrors} />
              <Table<RateRowView>
                data={rows}
                columns={rateColumns}
                rowKey={(row) => `${row.rate.carrierCode}-${row.rate.shippingProviderId ?? row.rate.raw?.carrier_id ?? 'na'}-${row.rate.serviceCode ?? row.serviceLabel}-${row.rate.shipmentCost}-${row.rate.otherCost}-${row.carrierNickname ?? ''}`}
                storageKey="rates-table"
                defaultSort={{ key: 'labelCost', direction: 'asc' }}
                density="compact"
                emptyMessage="No rates returned."
                showColumnControls={false}
                stickyHeader
                rowClassName={(row) => row.isBest ? 'bg-emerald-50/40' : undefined}
                className="!rounded-none !ring-0 !shadow-none"
              />
            </motion.div>
          ) : null}
        </AnimatePresence>
      </div>
    </div>
  )
}
