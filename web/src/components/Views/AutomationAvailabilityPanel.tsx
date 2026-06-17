// PS-155: Automation availability panel extracted verbatim from SettingsView.tsx
// (behavior-preserving). The automation rows carry loose union types
// (carrierId/carrier_id, serviceCode/code) not pinned to a single DTO; the local
// type aliases below mirror the parent module's shapes (PS-257 type-only restore).
//
// PURE PRESENTATION ONLY. The parent (SettingsView) keeps ALL state, every handler
// (toggleAutomationCarrier / toggleAutomationService / toggleAutomationStoreCarriers /
// refreshAutomationAvailability), every derived useMemo (automationClientGroups /
// automationFilteredGroups / automationDisabledCount), and — critically — the PS-057
// HUGRAB carrier-disable protection decision logic. isHugrabCarrierDisableProtected is
// passed in as a prop callback so this file never owns that decision. The stateless
// label/code/service formatters below are byte-identical copies of the parent's pure
// module-level helpers (no state, same input → same output).
import { motion } from 'framer-motion'
import {
  Loader2,
  RefreshCcw,
  Truck,
  Lock,
  Search,
} from 'lucide-react'
import { AutomationSwitch, ButtonSpinner, SkeletonStack, StatusLine } from './settings-ui'
import { formatCaDateTimeLabeled } from '../../lib/ca-time'
// PS-057 display reason strings (pure copy — not decision logic). The protection PREDICATE
// (isHugrabCarrierDisableProtected) stays in SettingsView and arrives as a prop callback.
import {
  HUGRAB_CARRIER_DISABLE_PROTECTED_REASON,
  HUGRAB_GROUND_SAVER_BLOCK_REASON,
} from '../../../../src/lib/shipping-service-eligibility'

// PS-257: local type aliases mirroring the parent SettingsView's loose automation
// shapes (those types are module-private there). Type-only — erased at emit.
type AutomationStoreRow = {
  storeId: number
  clientId: number
  clientName: string
  active: boolean
}

type AutomationServiceEligibilityRow = {
  code?: string | null
  serviceCode?: string | null
  name: string
  allowed: boolean
  disabled?: boolean
  locked?: boolean
  ruleId?: string | null
  reason?: string
}

type AutomationCarrierRow = {
  carrierId?: string | null
  carrierCode?: string | null
  nickname?: string | null
  friendlyName?: string | null
  sourceClientId?: number | null
  sourceClientName?: string | null
  disabled?: boolean
  disabledReason?: string | null
  services?: AutomationServiceEligibilityRow[]
  carrier_id?: string | null
  carrier_code?: string | null
  friendly_name?: string | null
  source_client_id?: number | null
  source_client_name?: string | null
}

type AutomationCarrierService = {
  serviceCode?: string | null
  name?: string | null
  domestic?: boolean | null
  international?: boolean | null
}

type AutomationStoreAvailability = {
  store: AutomationStoreRow
  loading: boolean
  error: string | null
  carriers: AutomationCarrierRow[]
}

type AutomationClientGroup = {
  clientId: number
  clientName: string
  stores: AutomationStoreAvailability[]
  carrierCount: number
  loadingCount: number
  errorCount: number
}

type HugrabClientContext = {
  clientId: number
  clientName: string
  storeId: number
}

type HugrabCarrierContext = {
  carrierId: string | null | undefined
  carrierCode: string
  carrierName: string
}

type AutomationAvailabilityPanelProps = {
  automationUpdatedAt: string | null
  automationLoading: boolean
  automationError: string | null
  automationRows: AutomationStoreAvailability[]
  automationServiceCatalog: Record<string, AutomationCarrierService[]>
  automationSavingKey: string | null
  automationQuery: string
  automationStatusFilter: 'all' | 'disabled' | 'enabled'
  automationClientGroups: AutomationClientGroup[]
  automationDisabledCount: number
  automationFilteredGroups: AutomationClientGroup[]
  setAutomationQuery: (value: string) => void
  setAutomationStatusFilter: (value: 'all' | 'disabled' | 'enabled') => void
  refreshAutomationAvailability: () => void | Promise<void>
  toggleAutomationCarrier: (
    row: AutomationStoreAvailability,
    carrier: AutomationCarrierRow,
    enabled: boolean,
  ) => void | Promise<void>
  toggleAutomationService: (
    row: AutomationStoreAvailability,
    carrier: AutomationCarrierRow,
    service: AutomationServiceEligibilityRow,
    enabled: boolean,
  ) => void | Promise<void>
  toggleAutomationStoreCarriers: (
    row: AutomationStoreAvailability,
    enabled: boolean,
  ) => void | Promise<void>
  isHugrabCarrierDisableProtected: (
    client: HugrabClientContext,
    carrier: HugrabCarrierContext,
  ) => boolean
}

const AUTOMATION_UPS_FALLBACK_SERVICES = [
  { serviceCode: 'ups_ground', name: 'UPS Ground' },
  { serviceCode: 'ups_2nd_day_air', name: 'UPS 2nd Day Air' },
  { serviceCode: 'ups_3_day_select', name: 'UPS 3 Day Select' },
  { serviceCode: 'ups_ground_saver', name: 'UPS Ground Saver' },
  { serviceCode: 'ups_surepost_1_lb_or_greater', name: 'UPS Ground Saver (1 lb+)' },
  { serviceCode: 'ups_surepost_less_than_1_lb', name: 'UPS Ground Saver (<1 lb)' },
]

function automationCarrierLabel(carrier: AutomationCarrierRow) {
  return (
    carrier.friendlyName ??
    carrier.friendly_name ??
    carrier.nickname ??
    carrier.carrierCode ??
    carrier.carrier_code ??
    carrier.carrierId ??
    carrier.carrier_id ??
    'Carrier account'
  )
}

function automationCarrierCode(carrier: AutomationCarrierRow) {
  return (
    carrier.carrierCode ??
    carrier.carrier_code ??
    carrier.carrierId ??
    carrier.carrier_id ??
    ''
  )
}

function isHugrabClient(name: string) {
  return name.trim().toLowerCase() === 'hugrab'
}

function automationCatalogKey(value: string | null | undefined) {
  return String(value ?? '').trim().toLowerCase()
}

function automationServicesForCarrier(
  carrier: AutomationCarrierRow,
  catalog: Record<string, AutomationCarrierService[]>,
) {
  const keys = [
    carrier.carrierCode,
    carrier.carrier_code,
    carrier.carrierId,
    carrier.carrier_id,
  ].map(automationCatalogKey).filter(Boolean)
  for (const key of keys) {
    const services = catalog[key]
    if (services?.length) return services
  }
  const identity = keys.join(' ')
  if (identity.includes('ups')) return AUTOMATION_UPS_FALLBACK_SERVICES
  return []
}

function automationServiceCode(service: AutomationServiceEligibilityRow) {
  return String(service.serviceCode ?? service.serviceCode ?? service.code ?? '').trim()
}

export function AutomationAvailabilityPanel({
  automationUpdatedAt,
  automationLoading,
  automationError,
  automationRows,
  automationServiceCatalog,
  automationSavingKey,
  automationQuery,
  automationStatusFilter,
  automationClientGroups,
  automationDisabledCount,
  automationFilteredGroups,
  setAutomationQuery,
  setAutomationStatusFilter,
  refreshAutomationAvailability,
  toggleAutomationCarrier,
  toggleAutomationService,
  toggleAutomationStoreCarriers,
  // PS-057 protection predicate — decision logic stays in SettingsView, passed in here.
  isHugrabCarrierDisableProtected,
}: AutomationAvailabilityPanelProps) {
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="text-[12px] text-ink-3">
          {automationUpdatedAt
            ? `Updated ${formatCaDateTimeLabeled(automationUpdatedAt)}`
            : 'Carrier map loads when this panel opens.'}
        </div>
        <motion.button
          type="button"
          onClick={() => void refreshAutomationAvailability()}
          disabled={automationLoading}
          whileHover={!automationLoading ? { y: -1 } : undefined}
          whileTap={!automationLoading ? { scale: 0.96 } : undefined}
          transition={{ type: 'spring', stiffness: 400, damping: 22 }}
          className="inline-flex items-center gap-1.5 h-8 px-3.5 rounded-lg text-[12px] font-semibold text-ink bg-surface hover:bg-surface-2 ring-1 ring-line disabled:opacity-60 disabled:cursor-not-allowed transition-colors duration-150"
        >
          {automationLoading ? <ButtonSpinner /> : <RefreshCcw size={13} strokeWidth={2.25} />}
          Refresh
        </motion.button>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="rounded-xl bg-surface ring-1 ring-line px-4 py-3 shadow-sm">
          <div className="text-[10.5px] uppercase tracking-wider font-bold text-ink-3">Clients</div>
          <div className="mt-1 text-2xl font-extrabold text-ink tabular-nums">{automationClientGroups.length}</div>
        </div>
        <div className="rounded-xl bg-surface ring-1 ring-line px-4 py-3 shadow-sm">
          <div className="text-[10.5px] uppercase tracking-wider font-bold text-ink-3">Stores</div>
          <div className="mt-1 text-2xl font-extrabold text-ink tabular-nums">{automationRows.length}</div>
        </div>
        <div className="rounded-xl bg-surface ring-1 ring-line px-4 py-3 shadow-sm">
          <div className="text-[10.5px] uppercase tracking-wider font-bold text-ink-3">Carrier Accounts</div>
          <div className="mt-1 text-2xl font-extrabold text-ink tabular-nums">
            {automationRows.reduce((sum, row) => sum + row.carriers.length, 0)}
          </div>
        </div>
        <div className="rounded-xl bg-surface ring-1 ring-line px-4 py-3 shadow-sm">
          <div className="text-[10.5px] uppercase tracking-wider font-bold text-ink-3">Disabled Rules</div>
          <div className={`mt-1 text-2xl font-extrabold tabular-nums ${automationDisabledCount > 0 ? 'text-rose-600' : 'text-emerald-700'}`}>
            {automationDisabledCount}
          </div>
        </div>
      </div>

      {automationRows.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative flex-1 min-w-[200px]">
            <Search size={14} strokeWidth={2.25} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-3" />
            <input
              type="text"
              value={automationQuery}
              onChange={(event) => setAutomationQuery(event.target.value)}
              placeholder="Search client name or store ID…"
              className="w-full h-9 pl-9 pr-3 rounded-lg text-[12.5px] text-ink bg-surface ring-1 ring-line focus:ring-2 focus:ring-brand focus:outline-none transition-shadow"
            />
          </div>
          <div className="inline-flex items-center rounded-lg bg-surface-2 ring-1 ring-line p-0.5">
            {([
              { id: 'all', label: 'All' },
              { id: 'disabled', label: 'Has disabled' },
              { id: 'enabled', label: 'Fully enabled' },
            ] as const).map((option) => (
              <button
                key={option.id}
                type="button"
                onClick={() => setAutomationStatusFilter(option.id)}
                className={`h-8 px-3 rounded-md text-[11.5px] font-semibold transition-colors ${
                  automationStatusFilter === option.id
                    ? 'bg-surface text-ink ring-1 ring-line shadow-sm'
                    : 'text-ink-3 hover:text-ink'
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {automationLoading && automationRows.length === 0 ? <SkeletonStack rows={6} /> : null}
      {automationError ? <StatusLine kind="error" message={automationError} /> : null}

      {!automationLoading && !automationError && automationRows.length === 0 ? (
        <div className="rounded-xl bg-surface ring-1 ring-line px-4 py-5 text-center text-[13px] text-ink-3">
          No active stores found.
        </div>
      ) : null}

      {!automationLoading && automationRows.length > 0 && automationFilteredGroups.length === 0 ? (
        <div className="rounded-xl bg-surface ring-1 ring-line px-4 py-5 text-center text-[13px] text-ink-3">
          No stores match your search or filter.
        </div>
      ) : null}

      <div className="space-y-3">
        {automationFilteredGroups.map((group, groupIndex) => {
          const hasHugrabRule = isHugrabClient(group.clientName)
          return (
            <motion.div
              key={group.clientId}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.18, delay: Math.min(groupIndex * 0.03, 0.18) }}
              className="rounded-xl bg-surface ring-1 ring-line shadow-sm overflow-hidden"
            >
              <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 bg-surface-2 border-b border-line">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-[13px] font-extrabold text-ink truncate">{group.clientName}</span>
                    {hasHugrabRule ? (
                      <span className="inline-flex items-center rounded-full bg-emerald-50 px-2 py-0.5 text-[10.5px] font-bold text-emerald-700 ring-1 ring-emerald-200">
                        Ground Saver/SurePost blocked
                      </span>
                    ) : null}
                  </div>
                  <div className="text-[11.5px] text-ink-3 mt-0.5">
                    {group.stores.length} store{group.stores.length === 1 ? '' : 's'} - {group.carrierCount} carrier account{group.carrierCount === 1 ? '' : 's'}
                  </div>
                </div>
                <div className="flex items-center gap-2 text-[11px] text-ink-3">
                  {group.loadingCount > 0 ? (
                    <span className="inline-flex items-center gap-1 rounded-full bg-brand-bg px-2 py-1 font-semibold text-brand ring-1 ring-brand/20">
                      <Loader2 size={11} className="animate-spin" />
                      {group.loadingCount} loading
                    </span>
                  ) : null}
                  {group.errorCount > 0 ? (
                    <span className="rounded-full bg-rose-50 px-2 py-1 font-semibold text-rose-700 ring-1 ring-rose-200">
                      {group.errorCount} error{group.errorCount === 1 ? '' : 's'}
                    </span>
                  ) : null}
                </div>
              </div>

              <div className="divide-y divide-line">
                {group.stores.map((row) => {
                  // Master-toggle state: a store counts as "on" when every
                  // toggleable (non-protected) carrier is enabled. Protected
                  // HUGRAB UPS carriers are excluded from the calculation.
                  const toggleableCarriers = row.carriers.filter(
                    (carrier) =>
                      !isHugrabCarrierDisableProtected(
                        { clientId: row.store.clientId, clientName: row.store.clientName, storeId: row.store.storeId },
                        {
                          carrierId: carrier.carrierId ?? carrier.carrier_id,
                          carrierCode: automationCarrierCode(carrier),
                          carrierName: automationCarrierLabel(carrier),
                        },
                      ),
                  )
                  const enabledCount = toggleableCarriers.filter((carrier) => !carrier.disabled).length
                  const protectedCount = row.carriers.length - toggleableCarriers.length
                  const allEnabled = toggleableCarriers.length > 0 && enabledCount === toggleableCarriers.length
                  const someEnabled = enabledCount > 0 && enabledCount < toggleableCarriers.length
                  const storeSavingKey = `store:${row.store.storeId}`
                  const isStoreSaving = automationSavingKey === storeSavingKey
                  return (
                  <div key={row.store.storeId} className="px-4 py-3">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-[160px]">
                        <div className="text-[12.5px] font-bold text-ink">Store {row.store.storeId}</div>
                        <div className="text-[11px] text-ink-3 tabular-nums">Client ID {row.store.clientId}</div>
                        {!row.loading && !row.error && toggleableCarriers.length > 0 ? (
                          <div className="mt-2">
                            <AutomationSwitch
                              checked={allEnabled}
                              indeterminate={someEnabled}
                              saving={isStoreSaving}
                              size="sm"
                              label={allEnabled ? 'All carriers on' : someEnabled ? 'Some carriers on' : 'All carriers off'}
                              ariaLabel={`Toggle all carriers for store ${row.store.storeId}`}
                              title="Enable or disable every carrier account for this store"
                              onChange={(next) => void toggleAutomationStoreCarriers(row, next)}
                            />
                            {protectedCount > 0 ? (
                              <div className="mt-1 inline-flex items-center gap-1 text-[10px] font-semibold text-brand">
                                <Lock size={9} strokeWidth={2.5} />
                                {protectedCount} protected
                              </div>
                            ) : null}
                          </div>
                        ) : null}
                      </div>
                      <div className="flex-1 min-w-[240px]">
                        {row.loading ? (
                          <div className="inline-flex items-center gap-2 text-[12px] font-semibold text-brand">
                            <Loader2 size={13} className="animate-spin" />
                            Loading carriers
                          </div>
                        ) : row.error ? (
                          <div className="text-[12px] font-semibold text-rose-700">{row.error}</div>
                        ) : row.carriers.length === 0 ? (
                          <div className="text-[12px] text-ink-3 italic">No carrier accounts available.</div>
                        ) : (
                          <div className="space-y-2">
                            {row.carriers.map((carrier, index) => {
                              const label = automationCarrierLabel(carrier)
                              const code = automationCarrierCode(carrier)
                              const carrierId = carrier.carrierId ?? carrier.carrier_id ?? ''
                              const sourceName =
                                carrier.sourceClientName ??
                                carrier.source_client_name ??
                                null
                              const services = carrier.services?.length
                                ? carrier.services
                                : automationServicesForCarrier(carrier, automationServiceCatalog).map((service) => ({
                                    code: service.serviceCode ?? '',
                                    serviceCode: service.serviceCode ?? '',
                                    name: service.name ?? service.serviceCode ?? 'Service',
                                    allowed: true,
                                    disabled: false,
                                  })) as AutomationServiceEligibilityRow[]
                              const serviceEligibility = services
                              const allowedServices = serviceEligibility.filter((service) => service.allowed)
                              const disabledServices = serviceEligibility.filter((service) => !service.allowed)
                              const carrierEnabled = !carrier.disabled
                              const carrierSavingKey = `carrier:${row.store.storeId}:${carrierId || code}`
                              const isCarrierSaving = automationSavingKey === carrierSavingKey
                              const carrierDisableProtected = isHugrabCarrierDisableProtected(
                                {
                                  clientId: row.store.clientId,
                                  clientName: row.store.clientName,
                                  storeId: row.store.storeId,
                                },
                                {
                                  carrierId,
                                  carrierCode: code,
                                  carrierName: label,
                                },
                              )
                              return (
                                <div
                                  key={`${row.store.storeId}:${code}:${label}:${index}`}
                                  className={`rounded-lg bg-surface ring-1 px-3 py-2 ${carrierEnabled ? 'ring-line' : 'ring-rose-200 bg-rose-50/40'}`}
                                >
                                  <div className="flex flex-wrap items-center gap-2">
                                    <AutomationSwitch
                                      checked={carrierDisableProtected ? true : carrierEnabled}
                                      locked={carrierDisableProtected}
                                      saving={isCarrierSaving}
                                      disabled={!carrierId && !code}
                                      label={carrierDisableProtected ? 'Protected' : carrierEnabled ? 'Enabled' : 'Disabled'}
                                      ariaLabel={`Toggle ${label} for store ${row.store.storeId}`}
                                      title={carrierDisableProtected ? HUGRAB_CARRIER_DISABLE_PROTECTED_REASON : `Enable or disable ${label}`}
                                      onChange={(next) => void toggleAutomationCarrier(row, carrier, next)}
                                    />
                                    <span
                                      className="inline-flex max-w-full items-center gap-1 rounded-full bg-surface-2 px-2.5 py-1 text-[11.5px] font-bold text-ink ring-1 ring-line"
                                      title={sourceName ? `${label} - ${sourceName}` : label}
                                    >
                                      <Truck size={11} strokeWidth={2.25} className="text-ink-3 flex-shrink-0" />
                                      <span className="truncate">{label}</span>
                                      {code ? <span className="text-ink-3 uppercase">{code}</span> : null}
                                    </span>
                                    <span className="text-[10.5px] text-ink-3">
                                      {allowedServices.length} available
                                      {disabledServices.length > 0 ? ` - ${disabledServices.length} disabled` : ''}
                                    </span>
                                    {carrier.disabledReason ? (
                                      <span className="rounded-full bg-rose-50 px-2 py-0.5 text-[10.5px] font-semibold text-rose-800 ring-1 ring-rose-200">
                                        {carrier.disabledReason}
                                      </span>
                                    ) : null}
                                    {carrierDisableProtected ? (
                                      <span
                                        className="rounded-full bg-brand-bg px-2 py-0.5 text-[10.5px] font-semibold text-brand ring-1 ring-brand/20"
                                        title={HUGRAB_CARRIER_DISABLE_PROTECTED_REASON}
                                      >
                                        PS-057 carrier protected
                                      </span>
                                    ) : null}
                                  </div>

                                  {services.length === 0 ? (
                                    <div className="mt-2 text-[11.5px] text-ink-3 italic">
                                      Carrier account is available. Service catalog is not published by the connector yet.
                                    </div>
                                  ) : (
                                    <div className="mt-2 grid gap-2 md:grid-cols-2">
                                      <div>
                                        <div className="mb-1 text-[10px] uppercase tracking-wider font-bold text-emerald-700">
                                          Available services
                                        </div>
                                        <div className="flex flex-wrap gap-1">
                                            {allowedServices.slice(0, 8).map((service) => {
                                              const serviceCode = automationServiceCode(service)
                                              const serviceSavingKey = `service:${row.store.storeId}:${carrierId || code}:${serviceCode || service.name}`
                                              const isSaving = automationSavingKey === serviceSavingKey
                                              return (
                                                <span
                                                  key={`${code}:allowed:${serviceCode}:${service.name}`}
                                                  className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-2 py-0.5 text-[10.5px] font-semibold text-emerald-800 ring-1 ring-emerald-200"
                                                >
                                                  <AutomationSwitch
                                                    size="sm"
                                                    checked
                                                    saving={isSaving}
                                                    ariaLabel={`Disable ${service.name}`}
                                                    title={`Disable ${service.name}`}
                                                    onChange={(next) => void toggleAutomationService(row, carrier, service, next)}
                                                  />
                                                  <span>{service.name}</span>
                                                </span>
                                              )
                                            })}
                                          {allowedServices.length > 8 ? (
                                            <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[10.5px] font-semibold text-emerald-800 ring-1 ring-emerald-200">
                                              +{allowedServices.length - 8} more
                                            </span>
                                          ) : null}
                                        </div>
                                      </div>
                                      <div>
                                        <div className="mb-1 text-[10px] uppercase tracking-wider font-bold text-rose-700">
                                          Disabled services
                                        </div>
                                        {disabledServices.length === 0 ? (
                                          <div className="text-[11.5px] text-ink-3">None</div>
                                        ) : (
                                          <div className="flex flex-wrap gap-1">
                                            {disabledServices.map((service) => {
                                              const serviceCode = automationServiceCode(service)
                                              const serviceSavingKey = `service:${row.store.storeId}:${carrierId || code}:${serviceCode || service.name}`
                                              const isSaving = automationSavingKey === serviceSavingKey
                                              const locked = Boolean(service.locked)
                                              return (
                                                <span
                                                  key={`${code}:disabled:${serviceCode}:${service.name}`}
                                                  className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10.5px] font-semibold ring-1 ${
                                                    locked
                                                      ? 'bg-brand-bg text-brand ring-brand/20'
                                                      : 'bg-rose-50 text-rose-800 ring-rose-200'
                                                  }`}
                                                  title={locked ? `PS-057 locked - ${service.reason ?? HUGRAB_GROUND_SAVER_BLOCK_REASON}` : service.reason ?? 'Disabled by Automation settings'}
                                                >
                                                  <AutomationSwitch
                                                    size="sm"
                                                    checked={false}
                                                    locked={locked}
                                                    saving={isSaving}
                                                    ariaLabel={`Enable ${service.name}`}
                                                    title={locked ? `PS-057 locked - ${service.reason ?? HUGRAB_GROUND_SAVER_BLOCK_REASON}` : `Enable ${service.name}`}
                                                    onChange={locked ? undefined : (next) => void toggleAutomationService(row, carrier, service, next)}
                                                  />
                                                  <span>{service.name}</span>
                                                  {locked ? <span className="text-brand">(PS-057 locked)</span> : null}
                                                </span>
                                              )
                                            })}
                                          </div>
                                        )}
                                      </div>
                                    </div>
                                  )}
                                </div>
                              )
                            })}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                  )
                })}
              </div>
            </motion.div>
          )
        })}
      </div>
    </div>
  )
}
