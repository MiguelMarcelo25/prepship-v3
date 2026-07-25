/**
 * SettingsView — refined "Calm Command Center" aesthetic.
 *
 * Five sections, each a card with a 4px vertical gradient accent strip
 * on the left edge color-coded by section type:
 *   Markup Settings   — brand blue   (primary configuration)
 *   Carrier Accounts  — emerald      (managed via separate card)
 *   Pending Clients   — amber        (managed via separate card)
 *   Sandbox / Test    — red/rose     (destructive actions, danger zone)
 *   Cache Management  — violet       (system-level operations)
 *
 * UX contract
 *   - Staggered fade-in on mount (each card .08s after the previous)
 *   - Loading: skeleton shimmer rows while lists fetch
 *   - Buttons: in-button spinner (lucide Loader2 + animate-spin) while
 *     async ops run, NOT just the previous "disabled+50% opacity"
 *   - Status lines under destructive actions show the last-op result
 *     for ~5s then auto-clear
 *
 * All styling is Tailwind — drops the legacy `.markup-card` CSS class
 * pattern and the long inline-style blocks. Responsive: stacked on
 * mobile, max-width cap on desktop so settings pages don't sprawl
 * across ultra-wide displays.
 */

import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useLocation, useNavigate } from 'react-router-dom'
import { AnimatePresence, motion } from 'framer-motion'
// PS-155: presentational helpers + section accent tokens extracted to ./settings-ui (behavior-preserving).
import {
  ACCENT_GRADIENT,
  ACCENT_ICON_BG,
  ACCENT_ICON_COLOR,
  AutomationSwitch,
  ButtonSpinner,
  SectionCard,
  SkeletonRow,
  SkeletonStack,
  StatusLine,
  type AccentTone,
} from './settings-ui'
// PS-155: the Markups panel extracted to ./MarkupsSection (behavior-preserving; props owned by the view).
import { MarkupsSection } from './MarkupsSection'
// PS-239: Marketplace Fees config panel (self-contained CRUD over the
// marketplace_fee_rules settings KV).
import { MarketplaceFeesSection } from './MarketplaceFeesSection'
import {
  Settings as SettingsIcon,
  ChevronDown,
  Loader2,
  Sparkles,
  AlertTriangle,
  RefreshCcw,
  Beaker,
  Database,
  CheckCircle2,
  XCircle,
  Trash2,
  Plus,
  Store,
  Truck,
  Clock,
  MapPin,
  Activity,
  Bot,
  Lock,
  Search,
  Percent,
} from 'lucide-react'
// 2026-05-13: Ship-From Locations now lives as a Settings tab instead
// of a top-level sidebar destination. Mounting <LocationsView embedded />
// here re-uses every behavior (CRUD, default-toggle, validation) while
// suppressing its page-level title so the Settings shell owns the
// chrome.
import LocationsView from './LocationsView'
import { apiClient } from '../../api/client'
import { api } from '../../lib/api'
import { formatCaDateTimeLabeled } from '../../lib/ca-time'
import { useShippingAccounts, useClients } from '../../hooks'
import { ToastContext } from '../../contexts/ToastContext'
import { useMarkups } from '../../contexts/MarkupsContext'
import type { MarkupType, MarkupsMap as SettingsMarkupsMap } from '../../types/markups'
import {
  HUGRAB_CARRIER_DISABLE_PROTECTED_REASON,
  HUGRAB_GROUND_SAVER_BLOCK_REASON,
  isHugrabCarrierDisableProtected,
} from '../../../../src/lib/shipping-service-eligibility'
import {
  buildSettingsMarkupRows,
  buildSettingsRefetchStatus,
  getSettingsMarkupEmptyMessage,
  getSettingsMarkupSavedToastMessage,
  groupSettingsMarkupRows,
  type SettingsRefetchState,
  parseSettingsMarkupInput,
} from './settings-parity'
import { CarrierIntegrationsCard } from '../Settings/CarrierIntegrationsCard'
import { CarrierEligibilityPolicyCard } from '../Settings/CarrierEligibilityPolicyCard'
import { HugrabInsurancePolicyCard } from '../Settings/HugrabInsurancePolicyCard'
import { PendingClientIntegrationsCard } from '../Settings/PendingClientIntegrationsCard'
// PS-155: SystemStatus / Cache / Sandbox panels extracted to sibling files (behavior-preserving;
// all state + async handlers stay in this view and are passed as props).
import { SystemStatusPanel, type ObservabilityStatus } from './SystemStatusPanel'
import { CacheManagementPanel } from './CacheManagementPanel'
import { SandboxTestOrdersPanel } from './SandboxTestOrdersPanel'
// PS-155: Automation availability panel extracted (pure presentation; state + handlers + PS-057
// protection predicate stay here and are passed in as props).
import { AutomationAvailabilityPanel } from './AutomationAvailabilityPanel'

// Drawer sections — each represents one icon on the rail and one
// content panel. Order here = rendering order on the rail.
type DrawerSectionId = 'markups' | 'marketplaceFees' | 'locations' | 'stores' | 'carriers' | 'pending' | 'sandbox' | 'cache' | 'system' | 'automation'

const DRAWER_SECTION_KEY = 'settings:active-drawer-section'

function sectionFromPath(pathname: string): DrawerSectionId | null {
  const slug = pathname.replace(/^\/settings\/?/, '').split('/')[0]?.toLowerCase().trim()
  if (!slug) return null
  const aliases: Record<string, DrawerSectionId> = {
    markup: 'markups',
    markups: 'markups',
    location: 'locations',
    locations: 'locations',
    store: 'stores',
    stores: 'stores',
    carrier: 'carriers',
    carriers: 'carriers',
    pending: 'pending',
    sandbox: 'sandbox',
    cache: 'cache',
    system: 'system',
    observability: 'system',
    automation: 'automation',
  }
  return aliases[slug] ?? null
}

const SECTION_PATH: Record<DrawerSectionId, string> = {
  markups: '/settings/markups',
  marketplaceFees: '/settings/marketplace-fees',
  locations: '/settings/locations',
  stores: '/settings/stores',
  carriers: '/settings/carriers',
  pending: '/settings/pending',
  sandbox: '/settings/sandbox',
  cache: '/settings/cache',
  system: '/settings/system',
  automation: '/settings/automation',
}

function scheduleSettingsQueries(callback: () => void) {
  if (typeof window === 'undefined') {
    const timeoutId = setTimeout(callback, 0)
    return () => clearTimeout(timeoutId)
  }

  if ('requestIdleCallback' in window) {
    const idleId = window.requestIdleCallback(callback, { timeout: 1200 })
    return () => window.cancelIdleCallback?.(idleId)
  }

  const timeoutId = (window as Window).setTimeout(callback, 0)
  return () => (window as Window).clearTimeout(timeoutId)
}

const COLLAPSE_STORAGE_KEY = 'settings:carrier-groups:collapsed'

function readCollapsedGroups(): Record<string, boolean> {
  if (typeof window === 'undefined') return {}
  try {
    const raw = window.localStorage.getItem(COLLAPSE_STORAGE_KEY)
    return raw ? (JSON.parse(raw) as Record<string, boolean>) : {}
  } catch {
    return {}
  }
}

function writeCollapsedGroups(state: Record<string, boolean>): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(COLLAPSE_STORAGE_KEY, JSON.stringify(state))
  } catch {
    /* localStorage full or blocked — non-fatal */
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

type AutomationStoreRow = {
  storeId: number
  clientId: number
  clientName: string
  active: boolean
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

type AutomationCarrierCatalogRow = {
  carrierId?: string | null
  carrierCode?: string | null
  nickname?: string | null
  services?: AutomationCarrierService[]
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

type AutomationStoreAvailability = {
  store: AutomationStoreRow
  loading: boolean
  error: string | null
  carriers: AutomationCarrierRow[]
}

interface SettingsAutomationQueryData {
  rows: AutomationStoreAvailability[]
  updatedAt: string
}

type SettingsTestClient = { id: number; name: string; order_count: number }

const EMPTY_AUTOMATION_ROWS: AutomationStoreAvailability[] = []
const EMPTY_AUTOMATION_SERVICE_CATALOG: Record<string, AutomationCarrierService[]> = {}
const HIDDEN_TEST_CLIENT_NAMES = new Set(['Manual Orders'])

const AUTOMATION_CARRIER_FETCH_CONCURRENCY = 4
const AUTOMATION_UPS_FALLBACK_SERVICES: AutomationCarrierService[] = [
  { serviceCode: 'ups_ground', name: 'UPS Ground' },
  { serviceCode: 'ups_2nd_day_air', name: 'UPS 2nd Day Air' },
  { serviceCode: 'ups_3_day_select', name: 'UPS 3 Day Select' },
  { serviceCode: 'ups_ground_saver', name: 'UPS Ground Saver' },
  { serviceCode: 'ups_surepost_1_lb_or_greater', name: 'UPS Ground Saver (1 lb+)' },
  { serviceCode: 'ups_surepost_less_than_1_lb', name: 'UPS Ground Saver (<1 lb)' },
]

function automationCarrierLabel(carrier: AutomationCarrierRow): string {
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

function automationCarrierCode(carrier: AutomationCarrierRow): string {
  return (
    carrier.carrierCode ??
    carrier.carrier_code ??
    carrier.carrierId ??
    carrier.carrier_id ??
    ''
  )
}

function isHugrabClient(name: string): boolean {
  return name.trim().toLowerCase() === 'hugrab'
}

function automationCatalogKey(value: string | null | undefined): string {
  return String(value ?? '').trim().toLowerCase()
}

function automationServicesForCarrier(
  carrier: AutomationCarrierRow,
  catalog: Record<string, AutomationCarrierService[]>,
): AutomationCarrierService[] {
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

function automationServiceCode(service: AutomationServiceEligibilityRow | AutomationCarrierService): string {
  return String((service as AutomationServiceEligibilityRow).serviceCode ?? service.serviceCode ?? (service as AutomationServiceEligibilityRow).code ?? '').trim()
}

export default function SettingsView() {
  const toastContext = useContext(ToastContext)
  const queryClient = useQueryClient()
  const location = useLocation()
  const navigate = useNavigate()
  const [activeSection, setActiveSection] = useState<DrawerSectionId>(() => {
    if (typeof window === 'undefined') return 'markups'
    const fromUrl = sectionFromPath(window.location.pathname)
    if (fromUrl) return fromUrl
    try {
      const stored = window.localStorage.getItem(DRAWER_SECTION_KEY) as DrawerSectionId | null
      if (stored && ['markups', 'locations', 'stores', 'carriers', 'pending', 'sandbox', 'cache', 'system', 'automation'].includes(stored)) {
        return stored
      }
    } catch {
      /* localStorage blocked — use default */
    }
    return 'markups'
  })
  const [settingsQueriesReady, setSettingsQueriesReady] = useState(false)
  const { accounts, isLoading: accountsLoading, error: accountsError } = useShippingAccounts()
  const { clients } = useClients()
  const { markups, loading: markupsLoading, saveMarkup } = useMarkups()
  const [drafts, setDrafts] = useState<Record<number, string>>({})
  const [refetchState, setRefetchState] = useState<SettingsRefetchState>({ kind: 'idle' })
  // 2026-05-13: DOM ref for the section header's right-side action
  // slot. Captured via callback ref (useState, not useRef) so the
  // value changes trigger re-render — needed for embedded panels
  // (LocationsView) that portal a CTA button into this slot once
  // the DOM node mounts. Sections without a CTA simply leave the
  // anchor unused; the empty <span> takes no visible space.
  const [headerActionEl, setHeaderActionEl] = useState<HTMLElement | null>(null)
  const saveToastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const refetchResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const latestSaveRequestRef = useRef(0)

  // FE-2 (audit 2.2 slice 4): Settings keeps the shell paint cheap, then
  // arms the active panel's cached GETs during browser idle time.
  useEffect(() => {
    if (settingsQueriesReady) return
    return scheduleSettingsQueries(() => setSettingsQueriesReady(true))
  }, [settingsQueriesReady])

  const markupRows = useMemo(
    // PS-257: MarkupsContext.MarkupsMap carries a wider MarkupType union
    // ('amount' | 'percent' | 'pct' | 'flat') than the settings-parity
    // MarkupsMap ('pct' | 'flat'); cast at the boundary (runtime values are
    // already 'pct' | 'flat').
    () => buildSettingsMarkupRows(accounts, markups as SettingsMarkupsMap, drafts),
    [accounts, markups, drafts],
  )
  const clientPlaceholders = useMemo(
    () => clients.filter((c) => c.hasOwnAccount && c.active).map((c) => ({ name: c.name })),
    [clients],
  )
  const markupGroups = useMemo(
    () => groupSettingsMarkupRows(markupRows, clientPlaceholders),
    [markupRows, clientPlaceholders],
  )
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>(() => readCollapsedGroups())
  const toggleGroup = useCallback((key: string) => {
    setCollapsedGroups((prev) => {
      const next = { ...prev, [key]: !prev[key] }
      writeCollapsedGroups(next)
      return next
    })
  }, [])

  const refetchStatus = buildSettingsRefetchStatus(refetchState)

  useEffect(() => () => {
    if (saveToastTimerRef.current) clearTimeout(saveToastTimerRef.current)
    if (refetchResetTimerRef.current) clearTimeout(refetchResetTimerRef.current)
  }, [])

  useEffect(() => {
    if (refetchState.kind !== 'success') return

    if (refetchResetTimerRef.current) clearTimeout(refetchResetTimerRef.current)
    refetchResetTimerRef.current = setTimeout(() => {
      setRefetchState({ kind: 'idle' })
    }, 5000)

    return () => {
      if (refetchResetTimerRef.current) clearTimeout(refetchResetTimerRef.current)
    }
  }, [refetchState])

  function queueMarkupSavedToast() {
    if (saveToastTimerRef.current) clearTimeout(saveToastTimerRef.current)
    saveToastTimerRef.current = setTimeout(() => {
      toastContext?.addToast(getSettingsMarkupSavedToastMessage(), 'success')
    }, 600)
  }

  function handleMarkupChange(shippingProviderId: number, nextType: MarkupType, nextValue: string) {
    setDrafts((current) => ({
      ...current,
      [shippingProviderId]: nextValue,
    }))

    latestSaveRequestRef.current += 1
    const requestId = latestSaveRequestRef.current
    queueMarkupSavedToast()

    void saveMarkup(shippingProviderId, nextType, parseSettingsMarkupInput(nextValue)).catch((error) => {
      if (requestId !== latestSaveRequestRef.current) return
      if (saveToastTimerRef.current) clearTimeout(saveToastTimerRef.current)
      toastContext?.addToast(error instanceof Error ? error.message : 'Failed to save markup', 'error')
    })
  }

  // ─── Sandbox / test orders ────────────────────────────────────────────────
  const [sandboxState, setSandboxState] = useState<
    | { kind: 'idle' }
    | { kind: 'loading'; op: 'seed' | 'purge' | 'refresh' }
    | { kind: 'success'; message: string }
    | { kind: 'error'; message: string }
  >({ kind: 'idle' })
  const [seedCount, setSeedCount] = useState<string>('25')
  const [automationSavingKey, setAutomationSavingKey] = useState<string | null>(null)
  const [automationQuery, setAutomationQuery] = useState('')
  const [automationStatusFilter, setAutomationStatusFilter] = useState<'all' | 'disabled' | 'enabled'>('all')

  // Keep every GET literal inline with its stable key: repository guards use
  // these call sites to pin the backend owner for each Settings panel.
  const testClientsQuery = useQuery<SettingsTestClient[]>({
    queryKey: ['settings', 'test-clients'],
    enabled: settingsQueriesReady && activeSection === 'sandbox',
    queryFn: async () => {
      const response = await api.get<{ data: SettingsTestClient[] }>('/admin/test-clients')
      return (response.data ?? []).filter(
        (client) => !HIDDEN_TEST_CLIENT_NAMES.has(client.name?.trim() ?? ''),
      )
    },
  })
  const testClients = testClientsQuery.data ?? []
  const testClientsLoading = (
    testClientsQuery.data == null && (!settingsQueriesReady || testClientsQuery.isPending)
  ) || testClientsQuery.isFetching
  const sandboxPanelState = sandboxState.kind === 'idle' && testClientsQuery.isError
    ? {
        kind: 'error' as const,
        message: testClientsQuery.error instanceof Error
          ? testClientsQuery.error.message
          : 'Failed to load test clients',
      }
    : sandboxState
  const refreshTestClients = async () => {
    const result = await testClientsQuery.refetch()
    if (result.isError) {
      setSandboxState({
        kind: 'error',
        message: result.error instanceof Error ? result.error.message : 'Failed to load test clients',
      })
    }
  }

  const systemStatusQuery = useQuery<ObservabilityStatus>({
    queryKey: ['settings', 'observability-status'],
    enabled: settingsQueriesReady && activeSection === 'system',
    queryFn: () => api.get<ObservabilityStatus>('/observability/status', {
      timeoutMs: 6_000,
    }),
  })
  const systemStatus = systemStatusQuery.data ?? null
  const systemStatusLoading = (
    systemStatusQuery.data == null && (!settingsQueriesReady || systemStatusQuery.isPending)
  ) || systemStatusQuery.isFetching
  const systemStatusError = systemStatusQuery.isError
    ? (systemStatusQuery.error instanceof Error ? systemStatusQuery.error.message : 'Failed to load system status')
    : null
  const refreshSystemStatus = () => systemStatusQuery.refetch()

  const automationAvailabilityQuery = useQuery<SettingsAutomationQueryData>({
    queryKey: ['settings', 'automation-availability'],
    enabled: settingsQueriesReady && activeSection === 'automation',
    queryFn: async () => {
      const payload = await api.get<{
        data: Array<{
          store: AutomationStoreRow
          carriers: AutomationCarrierRow[]
        }>
        updatedAt?: string
      }>('/automation/availability', { timeoutMs: 20_000 })
      return {
        rows: (payload.data ?? []).map((row) => ({
          store: row.store,
          loading: false,
          error: null,
          carriers: row.carriers ?? [],
        })),
        updatedAt: payload.updatedAt ?? new Date().toISOString(),
      }
    },
  })
  const automationRows = automationAvailabilityQuery.data?.rows ?? EMPTY_AUTOMATION_ROWS
  const automationServiceCatalog = EMPTY_AUTOMATION_SERVICE_CATALOG
  const automationUpdatedAt = automationAvailabilityQuery.data?.updatedAt ?? null
  const automationLoading = (
    automationAvailabilityQuery.data == null
    && (!settingsQueriesReady || automationAvailabilityQuery.isPending)
  ) || automationAvailabilityQuery.isFetching
  const automationError = automationAvailabilityQuery.isError
    ? (automationAvailabilityQuery.error instanceof Error
        ? automationAvailabilityQuery.error.message
        : 'Failed to load automation carrier map')
    : null
  const refreshAutomationAvailability = async () => {
    await automationAvailabilityQuery.refetch()
  }

  // Immutably patch carriers for a single store row. Used for optimistic
  // updates while React Query remains the sole owner of server response data.
  const patchAutomationStore = useCallback(
    (storeId: number, updateCarriers: (carriers: AutomationCarrierRow[]) => AutomationCarrierRow[]) => {
      queryClient.setQueryData<SettingsAutomationQueryData>(
        ['settings', 'automation-availability'],
        (current) => current
          ? {
              ...current,
              rows: current.rows.map((row) =>
                row.store.storeId === storeId ? { ...row, carriers: updateCarriers(row.carriers) } : row,
              ),
            }
          : current,
      )
    },
    [queryClient],
  )

  function carrierMatches(carrier: AutomationCarrierRow, carrierId: string | null, carrierCode: string): boolean {
    const id = carrier.carrierId ?? carrier.carrier_id ?? null
    if (carrierId && id && carrierId === id) return true
    return Boolean(carrierCode) && automationCarrierCode(carrier).toLowerCase() === carrierCode.toLowerCase()
  }

  async function toggleAutomationCarrier(row: AutomationStoreAvailability, carrier: AutomationCarrierRow, enabled: boolean) {
    const carrierId = carrier.carrierId ?? carrier.carrier_id ?? null
    const carrierCode = automationCarrierCode(carrier)
    if (!carrierId && !carrierCode) return
    const key = `carrier:${row.store.storeId}:${carrierId ?? carrierCode}`
    const prevDisabled = carrier.disabled
    setAutomationSavingKey(key)
    // Optimistic: flip just this carrier.
    patchAutomationStore(row.store.storeId, (carriers) =>
      carriers.map((c) => (carrierMatches(c, carrierId, carrierCode) ? { ...c, disabled: !enabled } : c)),
    )
    try {
      await api.patch('/automation/carrier', {
        clientId: row.store.clientId,
        storeId: row.store.storeId,
        carrierId,
        carrierCode: carrierCode || null,
        disabled: !enabled,
        reason: enabled ? null : 'Carrier disabled by Automation settings.',
      })
      toastContext?.addToast(enabled ? 'Carrier enabled' : 'Carrier disabled', 'success')
    } catch (err) {
      // Revert on failure (e.g. 409 PS-057 carrier protection).
      patchAutomationStore(row.store.storeId, (carriers) =>
        carriers.map((c) => (carrierMatches(c, carrierId, carrierCode) ? { ...c, disabled: prevDisabled } : c)),
      )
      toastContext?.addToast(err instanceof Error ? err.message : 'Failed to save carrier automation', 'error')
    } finally {
      setAutomationSavingKey(null)
    }
  }

  async function toggleAutomationService(row: AutomationStoreAvailability, carrier: AutomationCarrierRow, service: AutomationServiceEligibilityRow, enabled: boolean) {
    if (service.locked) return
    const code = automationServiceCode(service)
    if (!code && !service.name) return
    const carrierId = carrier.carrierId ?? carrier.carrier_id ?? null
    const carrierCode = automationCarrierCode(carrier)
    const key = `service:${row.store.storeId}:${carrierId ?? carrierCode}:${code || service.name}`
    const serviceMatches = (svc: AutomationServiceEligibilityRow) =>
      (Boolean(code) && automationServiceCode(svc) === code) ||
      (!code && svc.name === service.name)
    setAutomationSavingKey(key)
    // Optimistic: flip this service's eligibility (moves it between the
    // Available and Disabled columns).
    patchAutomationStore(row.store.storeId, (carriers) =>
      carriers.map((c) =>
        carrierMatches(c, carrierId, carrierCode)
          ? {
              ...c,
              services: (c.services ?? []).map((svc) =>
                serviceMatches(svc) ? { ...svc, allowed: enabled, disabled: !enabled } : svc,
              ),
            }
          : c,
      ),
    )
    try {
      await api.patch('/automation/service', {
        clientId: row.store.clientId,
        storeId: row.store.storeId,
        carrierId,
        carrierCode: carrierCode || null,
        serviceCode: code || null,
        serviceName: service.name ?? null,
        disabled: !enabled,
        reason: enabled ? null : 'Service disabled by Automation settings.',
      })
      toastContext?.addToast(enabled ? 'Service enabled' : 'Service disabled', 'success')
    } catch (err) {
      // Revert on failure (e.g. 409 HUGRAB Ground Saver/SurePost lock).
      patchAutomationStore(row.store.storeId, (carriers) =>
        carriers.map((c) =>
          carrierMatches(c, carrierId, carrierCode)
            ? {
                ...c,
                services: (c.services ?? []).map((svc) =>
                  serviceMatches(svc) ? { ...svc, allowed: !enabled, disabled: enabled } : svc,
                ),
              }
            : c,
        ),
      )
      toastContext?.addToast(err instanceof Error ? err.message : 'Failed to save service automation', 'error')
    } finally {
      setAutomationSavingKey(null)
    }
  }

  // Per-store master toggle: enable/disable every carrier account for a store
  // in one call. HUGRAB-protected UPS carriers are skipped server-side and in
  // the optimistic update so PS-057 is never violated.
  async function toggleAutomationStoreCarriers(row: AutomationStoreAvailability, enabled: boolean) {
    const key = `store:${row.store.storeId}`
    const prevCarriers = row.carriers
    const isProtected = (carrier: AutomationCarrierRow) =>
      isHugrabCarrierDisableProtected(
        { clientId: row.store.clientId, clientName: row.store.clientName, storeId: row.store.storeId },
        {
          carrierId: carrier.carrierId ?? carrier.carrier_id,
          carrierCode: automationCarrierCode(carrier),
          carrierName: automationCarrierLabel(carrier),
        },
      )
    setAutomationSavingKey(key)
    // Optimistic: flip every non-protected carrier.
    patchAutomationStore(row.store.storeId, (carriers) =>
      carriers.map((c) => (!enabled && isProtected(c) ? c : { ...c, disabled: !enabled })),
    )
    try {
      const res = await api.patch<{ data?: { applied?: number; skipped?: unknown[] } }>(
        '/automation/store-carriers',
        {
          clientId: row.store.clientId,
          storeId: row.store.storeId,
          disabled: !enabled,
          reason: enabled ? null : 'All carriers disabled by Automation settings.',
        },
      )
      const skipped = Array.isArray(res?.data?.skipped) ? res.data.skipped.length : 0
      toastContext?.addToast(
        enabled ? 'All carriers enabled' : 'All carriers disabled',
        'success',
      )
      if (!enabled && skipped > 0) {
        toastContext?.addToast(
          `${skipped} protected carrier${skipped === 1 ? '' : 's'} kept enabled (PS-057)`,
          'info',
        )
      }
    } catch (err) {
      patchAutomationStore(row.store.storeId, () => prevCarriers)
      toastContext?.addToast(err instanceof Error ? err.message : 'Failed to update store carriers', 'error')
    } finally {
      setAutomationSavingKey(null)
    }
  }

  async function handleSeedTestOrders() {
    const count = Number.parseInt(seedCount, 10)
    if (!Number.isFinite(count) || count <= 0) {
      toastContext?.addToast('Enter a positive seed count', 'error')
      return
    }
    setSandboxState({ kind: 'loading', op: 'seed' })
    try {
      const res = await api.post<{ seeded: number; clientName: string }>(
        '/admin/seed-test-orders',
        { count }
      )
      setSandboxState({
        kind: 'success',
        message: `Seeded ${res.seeded} test order(s) under "${res.clientName}"`,
      })
      toastContext?.addToast(`✅ Seeded ${res.seeded} test orders`, 'success')
      await refreshTestClients()
    } catch (err) {
      setSandboxState({
        kind: 'error',
        message: err instanceof Error ? err.message : 'Seed failed',
      })
    }
  }

  async function handlePurgeTestOrders() {
    if (
      !window.confirm(
        'Delete every order under every test-flagged client?\n\n' +
          'This also deletes their shipments, billing lines, and inventory ledger entries. ' +
          'This cannot be undone.'
      )
    ) {
      return
    }
    setSandboxState({ kind: 'loading', op: 'purge' })
    try {
      const res = await api.post<{
        deleted: {
          orders: number
          shipments: number
          ledger: number
          billing: number
        }
      }>('/admin/purge-test-orders', {})
      const d = res.deleted
      setSandboxState({
        kind: 'success',
        message: `Deleted ${d.orders} order(s), ${d.shipments} shipment(s), ${d.ledger} ledger entries, ${d.billing} billing line(s)`,
      })
      toastContext?.addToast(`🧹 Purged ${d.orders} test orders`, 'success')
      await refreshTestClients()
    } catch (err) {
      setSandboxState({
        kind: 'error',
        message: err instanceof Error ? err.message : 'Purge failed',
      })
    }
  }

  async function handleRefetchAllRates() {
    setRefetchState({ kind: 'loading' })

    try {
      const result = await apiClient.clearAndRefetchAllRates()
      setRefetchState({ kind: 'success', result })
    } catch (error) {
      setRefetchState({
        kind: 'error',
        message: error instanceof Error ? error.message : 'Unknown error',
      })
    }
  }

  const sandboxBusy = sandboxState.kind === 'loading'
  const isSeeding = sandboxBusy && sandboxState.op === 'seed'
  const isPurging = sandboxBusy && sandboxState.op === 'purge'

  // URL ↔ activeSection two-way binding.
  //
  // INCOMING (URL → section, mounted below as a useEffect on
  // location.pathname): /settings (bare) falls through to
  // localStorage default. Deep links like /settings/store or
  // /settings/markups jump directly to that section, so an operator
  // who's sent a link goes to the right panel on first paint.
  // The trailing pluralization is forgiving — /settings/store and
  // /settings/stores both resolve to 'stores'.
  //
  // OUTGOING (section → URL, mounted below as a useEffect on
  // activeSection): clicking a rail icon updates the URL so the
  // address bar always reflects "what am I looking at?" — copy/paste
  // the URL and a colleague lands on the same section. We use
  // navigate(..., { replace: true }) so changing sections doesn't
  // pollute history — Back still takes you to wherever you came
  // from before Settings, not through every section you clicked.
  // Keep activeSection in sync when the URL changes mid-session
  // (e.g. the operator clicks a link that does
  // `navigate('/settings/store')`). Without this effect the initial
  // state above would fire once on mount and never react to
  // subsequent path changes.
  useEffect(() => {
    const fromUrl = sectionFromPath(location.pathname)
    if (fromUrl && fromUrl !== activeSection) {
      setActiveSection(fromUrl)
    }
    // activeSection is intentionally NOT a dep — including it would
    // re-fire this effect every time the user clicks a rail icon and
    // bounce them back to the URL-derived section. We only want this
    // to fire on pathname change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname])

  // Outgoing sync: when the operator clicks a rail icon (which
  // changes activeSection), update the URL so the address bar
  // reflects what they're looking at. `replace: true` avoids
  // polluting history with one entry per click. We compare against
  // the current path FIRST so we don't navigate to a path that's
  // already current — that would be a no-op router call but also
  // creates extra React Router internal work.
  useEffect(() => {
    const targetPath = SECTION_PATH[activeSection]
    // Skip if URL already matches canonical OR matches an alias for
    // this section (e.g. /settings/store is alias for stores). The
    // alias check uses sectionFromPath so we don't fight an incoming
    // URL like /settings/store with an immediate replace to
    // /settings/stores — both resolve to the same section.
    const currentSection = sectionFromPath(location.pathname)
    if (currentSection === activeSection) return
    // Bare /settings is also acceptable for any section — only
    // upgrade to a canonical path if we're either on bare /settings
    // OR on a path that resolves to a DIFFERENT section.
    if (location.pathname !== targetPath) {
      navigate(targetPath, { replace: true })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSection])
  useEffect(() => {
    try {
      window.localStorage.setItem(DRAWER_SECTION_KEY, activeSection)
    } catch {
      /* non-fatal */
    }
  }, [activeSection])

  const isRefetching = refetchState.kind === 'loading'

  // ─── Drawer manifest ──────────────────────────────────────────────
  // Single source of truth for the rail. Each entry maps an id to a
  // visual identity (icon + tone) plus the descriptive copy that
  // becomes the panel header. Adding a new drawer section is a
  // one-line entry here + a case in the renderActiveSection switch.
  const DRAWER_SECTIONS: Array<{
    id: DrawerSectionId
    label: string
    short: string
    description: string
    icon: typeof SettingsIcon
    tone: AccentTone
  }> = [
    {
      id: 'markups',
      label: 'Rate Browser — Account Markups',
      short: 'Markups',
      description:
        '$ or % markup added per carrier account. Applied to displayed rates in the Rate Browser; useful for billing clients above cost.',
      icon: Sparkles,
      tone: 'brand',
    },
    {
      // PS-239: per-store/client marketplace commission → Marketplace Fee + Profit columns.
      id: 'marketplaceFees',
      label: 'Marketplace Fees & Profit',
      short: 'Mkt Fees',
      description:
        'Per-store/client commission on the product subtotal (flat % or tiered). Drives the Marketplace Fee + Profit columns on Awaiting/Shipped. A store rule overrides a client rule.',
      icon: Percent,
      tone: 'violet',
    },
    {
      // 2026-05-13: First tab after Markups per operator request —
      // Ship-From Locations moved out of the sidebar so the left rail
      // stays focused on order-processing destinations.
      id: 'locations',
      label: 'Ship-From Locations',
      short: 'Locations',
      description:
        'Warehouses, 3PL centers, or drop-ship addresses. The ★ default is used for new labels.',
      icon: MapPin,
      tone: 'rose',
    },
    {
      id: 'stores',
      label: 'Your Stores',
      short: 'Stores',
      description:
        'Marketplace order sources (Walmart, Amazon, eBay, Shopify…). Use these to pull orders into PrepShip and push tracking back. Stores do not return shipping rates.',
      icon: Store,
      tone: 'emerald',
    },
    {
      id: 'carriers',
      label: 'Your Carriers',
      short: 'Carriers',
      description:
        'Direct shipping carriers (UPS, USPS, FedEx, DHL, EasyPost…). Used for rate shopping and label purchase. These appear in the Rate Browser sidebar.',
      icon: Truck,
      tone: 'brand',
    },
    {
      id: 'pending',
      label: 'Pending Client Integrations',
      short: 'Pending',
      description:
        'Carrier credentials submitted by clients via the client portal that haven\'t been reviewed yet. Approve or reject from this panel.',
      icon: Clock,
      tone: 'amber',
    },
    {
      id: 'automation',
      label: 'Automations workspace',
      short: 'Automations',
      description:
        'Carrier/service controls and versioned workflow rules now live in the top-level Automations workspace.',
      icon: Bot,
      tone: 'emerald',
    },
    {
      id: 'sandbox',
      label: 'Sandbox — Test Orders',
      short: 'Sandbox',
      description:
        'Clients flagged is_test=true are isolated: their orders never sync from ShipStation, never create real postage, never bill, and never touch inventory.',
      icon: Beaker,
      tone: 'rose',
    },
    {
      id: 'cache',
      label: 'Cache Management',
      short: 'Cache',
      description:
        'Clear the rate cache and refetch all rates for awaiting_shipment orders. Used after carrier credential changes or markup-rule updates.',
      icon: Database,
      tone: 'violet',
    },
    {
      id: 'system',
      label: 'System Status',
      short: 'System',
      description:
        'Live API timing, memory, and runtime flags for production troubleshooting.',
      icon: Activity,
      tone: 'violet',
    },
  ]

  const activeMeta = DRAWER_SECTIONS.find((s) => s.id === activeSection) ?? DRAWER_SECTIONS[0]!
  const ActiveIcon = activeMeta.icon
  const automationClientGroups = useMemo(() => {
    const groups = new Map<number, {
      clientId: number
      clientName: string
      stores: AutomationStoreAvailability[]
      carrierCount: number
      loadingCount: number
      errorCount: number
    }>()
    for (const row of automationRows) {
      const current = groups.get(row.store.clientId) ?? {
        clientId: row.store.clientId,
        clientName: row.store.clientName,
        stores: [],
        carrierCount: 0,
        loadingCount: 0,
        errorCount: 0,
      }
      current.stores.push(row)
      current.carrierCount += row.carriers.length
      if (row.loading) current.loadingCount += 1
      if (row.error) current.errorCount += 1
      groups.set(row.store.clientId, current)
    }
    return [...groups.values()].sort((a, b) => a.clientName.localeCompare(b.clientName))
  }, [automationRows])

  // Total count of disabled rules (carriers + services) across all stores —
  // drives the "Disabled" stat card and gives an at-a-glance health number.
  const automationDisabledCount = useMemo(
    () =>
      automationRows.reduce(
        (sum, row) =>
          sum +
          row.carriers.reduce(
            (acc, carrier) =>
              acc +
              (carrier.disabled ? 1 : 0) +
              (carrier.services ?? []).filter((service) => service.allowed === false).length,
            0,
          ),
        0,
      ),
    [automationRows],
  )

  // Apply the search query + status filter to the grouped rows.
  const automationFilteredGroups = useMemo(() => {
    const query = automationQuery.trim().toLowerCase()
    const storeHasDisabled = (row: AutomationStoreAvailability) =>
      row.carriers.some(
        (carrier) => carrier.disabled || (carrier.services ?? []).some((service) => service.allowed === false),
      )
    return automationClientGroups
      .map((group) => {
        const stores = group.stores.filter((row) => {
          if (
            query &&
            !group.clientName.toLowerCase().includes(query) &&
            !String(row.store.storeId).includes(query)
          ) {
            return false
          }
          if (automationStatusFilter === 'disabled') return storeHasDisabled(row)
          if (automationStatusFilter === 'enabled') return !storeHasDisabled(row)
          return true
        })
        return { ...group, stores }
      })
      .filter((group) => group.stores.length > 0)
  }, [automationClientGroups, automationQuery, automationStatusFilter])

  return (
    <div
      id="view-settings"
      className="view-content !p-0 !overflow-y-auto relative"
      style={{
        // Subtle brand-tinted gradient mesh for the page background.
        // Gives the settings surface a "command-deck" feel without
        // shouting. Two soft radial pools (top-left + bottom-right)
        // hint at the brand color without saturating the page.
        background:
          'radial-gradient(900px 500px at 8% 0%, rgb(var(--brand-rgb, 42 91 215) / 0.05), transparent 60%), radial-gradient(700px 400px at 100% 100%, rgb(var(--brand-rgb, 42 91 215) / 0.04), transparent 65%), rgb(var(--bg-rgb, 240 242 245))',
      }}
    >
      {/* ─────────────────────────────────────────────────────────────
          REFINED OPERATOR CONSOLE — horizontal drawer-rail layout

          Single column, top-to-bottom:
            • TOP: full-width sticky horizontal icon rail
            • BELOW: animated content panel with the active section

          The rail is a horizontal pill-strip with the brand mark on
          the left and the section icons spread to the right. On
          narrow viewports the icons can scroll horizontally inside
          the rail without wrapping the whole page.
          ───────────────────────────────────────────────────────────── */}
      <div className="flex flex-col min-h-full w-full">

        {/* ─── HORIZONTAL ICON RAIL ──────────────────────────────────
            Sticky strip across the top of the panel. Brand mark on
            the left, then a horizontally-laid-out tab list of section
            icons. The active indicator bar sits on the BOTTOM edge of
            the active icon and morphs between positions via Framer's
            layoutId — same Linear-style "you-are-here" marker as
            before, just rotated 90° to fit the horizontal orientation. */}
        <aside
          className="
            flex-shrink-0
            w-full
            border-b border-line
            bg-gradient-to-b from-surface-2 to-surface
            sticky top-0
            z-10
          "
          aria-label="Settings sections"
        >
          <div
            className="
              flex flex-row items-center gap-2
              px-3 sm:px-5 py-3
              overflow-x-auto
            "
            role="tablist"
          >
            {/* Brand mark — leads the rail, doubles as a "back to
                default section" affordance (clicks reset to Markups). */}
            <motion.button
              type="button"
              initial={{ rotate: -90, scale: 0.5, opacity: 0 }}
              animate={{ rotate: 0, scale: 1, opacity: 1 }}
              transition={{ type: 'spring', stiffness: 240, damping: 20, delay: 0.05 }}
              whileHover={{ scale: 1.04 }}
              whileTap={{ scale: 0.94 }}
              onClick={() => setActiveSection('markups')}
              className="flex w-10 h-10 sm:w-11 sm:h-11 mr-2 rounded-xl bg-gradient-to-br from-brand to-indigo-600 items-center justify-center shadow-md ring-1 ring-brand/30 flex-shrink-0"
              title="Settings — back to start"
              aria-label="Reset to default section"
            >
              <SettingsIcon size={18} strokeWidth={2.25} className="text-white" />
            </motion.button>

            {/* Hairline divider between brand mark and tab list */}
            <div className="hidden sm:block w-px h-7 bg-line/80 mr-1 flex-shrink-0" aria-hidden />

            {DRAWER_SECTIONS.map((section, idx) => {
              const Icon = section.icon
              const isActive = activeSection === section.id
              const accentText = ACCENT_ICON_COLOR[section.tone]
              const accentBg = ACCENT_ICON_BG[section.tone]
              return (
                <motion.button
                  key={section.id}
                  type="button"
                  role="tab"
                  aria-selected={isActive}
                  aria-controls={`settings-panel-${section.id}`}
                  id={`settings-tab-${section.id}`}
                  onClick={() => setActiveSection(section.id)}
                  initial={{ opacity: 0, y: -6 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{
                    duration: 0.32,
                    delay: 0.08 + idx * 0.04,
                    ease: [0.22, 1, 0.36, 1],
                  }}
                  whileHover={{ scale: isActive ? 1.0 : 1.06 }}
                  whileTap={{ scale: 0.94 }}
                  title={section.label}
                  className={`
                    relative group
                    inline-flex items-center justify-center gap-2
                    h-11 px-3 sm:px-3.5
                    rounded-xl flex-shrink-0
                    transition-colors duration-200
                    focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/50
                    ${isActive
                      ? `bg-gradient-to-br ${accentBg} ring-1`
                      : 'hover:bg-surface-2 ring-1 ring-transparent hover:ring-line'}
                  `}
                >
                  {/* Active indicator bar — sits on the BOTTOM edge of
                      the active icon and morphs between positions via
                      Framer's layoutId. Reads as a "currently selected
                      tab" underline, same idiom as macOS / iOS tab bars. */}
                  {isActive ? (
                    <motion.span
                      layoutId="settings-active-indicator"
                      transition={{ type: 'spring', stiffness: 380, damping: 30 }}
                      className={`
                        absolute bottom-[-9px] left-3 right-3
                        h-[3px] rounded-full
                        bg-gradient-to-r ${ACCENT_GRADIENT[section.tone]}
                      `}
                      aria-hidden
                    />
                  ) : null}
                  <Icon
                    size={18}
                    strokeWidth={isActive ? 2.5 : 2.0}
                    className={`transition-colors duration-200 ${isActive ? accentText : 'text-ink-3 group-hover:text-ink-2'}`}
                  />
                  {/* Inline section label — hidden on very narrow
                      viewports to keep the rail scannable, visible on
                      sm+ where there's room. Active section always
                      shows the label so the operator gets a written
                      confirmation of where they are. */}
                  <span
                    className={`
                      hidden sm:inline text-[12.5px] font-bold tracking-tight whitespace-nowrap
                      transition-colors duration-200
                      ${isActive ? accentText : 'text-ink-3 group-hover:text-ink-2'}
                    `}
                  >
                    {section.short}
                  </span>
                </motion.button>
              )
            })}
          </div>
        </aside>

        {/* ─── CONTENT PANEL ─────────────────────────────────────────
            Animated header (icon + title + description) + a content
            area that swaps between sections via AnimatePresence with
            a horizontal-slide cross-fade. The wait mode ensures the
            outgoing section finishes before the new one arrives so
            there's no visual clobber. */}
        <main className="flex-1 min-w-0 px-4 sm:px-8 py-5 sm:py-7">

          {/* Section header — animates per active section change.
              Key on activeSection so AnimatePresence treats every
              switch as a fresh enter/exit sequence. */}
          <AnimatePresence>
            <motion.header
              key={activeMeta.id}
              initial={{ opacity: 0, y: -6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
              className="flex items-start gap-4 mb-6 sm:mb-7"
            >
              <motion.div
                initial={{ scale: 0.6, rotate: -8, opacity: 0 }}
                animate={{ scale: 1, rotate: 0, opacity: 1 }}
                transition={{ type: 'spring', stiffness: 280, damping: 18, delay: 0.05 }}
                className={`
                  w-12 h-12 sm:w-14 sm:h-14 rounded-2xl flex-shrink-0
                  bg-gradient-to-br ${ACCENT_ICON_BG[activeMeta.tone]} ring-1
                  flex items-center justify-center
                  shadow-sm
                `}
              >
                <ActiveIcon
                  size={22}
                  strokeWidth={2.25}
                  className={ACCENT_ICON_COLOR[activeMeta.tone]}
                />
              </motion.div>
              <div className="flex-1 min-w-0 pt-0.5">
                <h2 className="text-[22px] sm:text-[26px] font-extrabold text-ink font-display tracking-[-0.022em] leading-tight m-0">
                  {activeMeta.label}
                </h2>
                <p className="text-[12.5px] sm:text-[13px] text-ink-3 mt-1.5 leading-relaxed max-w-3xl">
                  {activeMeta.description}
                </p>
              </div>
              {/* 2026-05-13: Portal target for section-level header
                  actions. Embedded panels (e.g. LocationsView's
                  "+ Add Location") render their primary CTA into
                  this slot via createPortal so the action sits in
                  the natural place — next to the section title —
                  instead of floating in a blank row inside the
                  panel content. Stays empty for sections that
                  don't need an action button. */}
              <span
                ref={setHeaderActionEl}
                className="shrink-0 pt-1"
                data-settings-header-action-anchor
              />
            </motion.header>
          </AnimatePresence>

          {/* Section content — AnimatePresence handles the swap.
              Each section is wrapped in a motion.div with its own
              key so React unmounts the old one and mounts the new
              one cleanly (preserves component lifecycle for stateful
              children like CarrierIntegrationsCard). */}
          <AnimatePresence>
            <motion.div
              key={activeMeta.id}
              id={`settings-panel-${activeMeta.id}`}
              role="tabpanel"
              aria-labelledby={`settings-tab-${activeMeta.id}`}
              initial={{ opacity: 0, x: 12 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -8 }}
              transition={{ duration: 0.32, ease: [0.22, 1, 0.36, 1] }}
              className="max-w-5xl"
            >

              {/* ─── MARKUPS panel ─────────────────────────────── */}
              {activeSection === 'markups' ? (
                <MarkupsSection
                  accountsLoading={accountsLoading}
                  markupsLoading={markupsLoading}
                  markupGroups={markupGroups}
                  collapsedGroups={collapsedGroups}
                  accountsError={accountsError}
                  toggleGroup={toggleGroup}
                  handleMarkupChange={handleMarkupChange}
                />
              ) : null}

              {/* ─── MARKETPLACE FEES panel (PS-239) ───────────── */}
              {activeSection === 'marketplaceFees' ? (
                <MarketplaceFeesSection queriesEnabled={settingsQueriesReady} />
              ) : null}

              {/* ─── LOCATIONS panel ───────────────────────────── */}
              {/* 2026-05-13: Ship-From Locations moved here from a
                  top-level sidebar destination. <LocationsView /> is
                  self-contained — it owns its own data fetch, form
                  state, and CRUD calls. We pass `embedded` so its
                  built-in title bar is suppressed (the Settings
                  shell renders one already). */}
              {activeSection === 'locations' ? (
                <LocationsView
                  embedded
                  headerActionAnchor={headerActionEl}
                  queriesEnabled={settingsQueriesReady}
                />
              ) : null}

              {/* ─── STORES panel ──────────────────────────────── */}
              {activeSection === 'stores' ? (
                <div className="flex flex-col gap-4">
                  <HugrabInsurancePolicyCard queriesEnabled={settingsQueriesReady} />
                  <CarrierIntegrationsCard view="stores" queriesEnabled={settingsQueriesReady} />
                </div>
              ) : null}

              {/* ─── CARRIERS panel ────────────────────────────── */}
              {activeSection === 'carriers' ? (
                <div className="flex flex-col gap-4">
                  {/* PS-106: direct-store vs ShipStation carrier policy control. */}
                  <CarrierEligibilityPolicyCard queriesEnabled={settingsQueriesReady} />
                  <CarrierIntegrationsCard view="carriers" queriesEnabled={settingsQueriesReady} />
                </div>
              ) : null}

              {/* ─── PENDING panel ─────────────────────────────── */}
              {activeSection === 'pending' ? (
                <PendingClientIntegrationsCard queriesEnabled={settingsQueriesReady} />
              ) : null}

              {/* ─── AUTOMATION panel ──────────────────────────── */}
              {/* PS-155: JSX extracted to <AutomationAvailabilityPanel /> (pure presentation).
                  This view keeps ALL state, every handler, every derived useMemo, and the PS-057
                  HUGRAB carrier-disable protection — isHugrabCarrierDisableProtected is passed in
                  as a prop callback so the decision logic never leaves SettingsView. */}
              {activeSection === 'automation' ? (
                <SectionCard
                  tone="emerald"
                  icon={<Bot size={18} />}
                  title="Automations moved"
                  subtitle="Rules, simulations, history, and carrier/service controls now share one workspace."
                >
                  <div className="rounded-lg bg-brand-bg p-4 text-small text-ink-2 ring-1 ring-brand-border">
                    The legacy <code>/settings/automation</code> URL is retained as a compatibility landing only.
                    HUGRAB carrier/service protections remain backend-owned and unchanged.
                  </div>
                  <button
                    type="button"
                    onClick={() => navigate('/automations')}
                    className="mt-4 inline-flex h-9 items-center gap-2 rounded-lg bg-brand px-4 text-small font-bold text-white hover:bg-brand-dark"
                  >
                    Open Automations workspace
                    <Sparkles size={14} />
                  </button>
                </SectionCard>
              ) : null}

              {activeSection === 'sandbox' ? (
                <SandboxTestOrdersPanel
                  testClients={testClients}
                  testClientsLoading={testClientsLoading}
                  seedCount={seedCount}
                  sandboxState={sandboxPanelState}
                  onSeedCountChange={setSeedCount}
                  onSeed={handleSeedTestOrders}
                  onPurge={handlePurgeTestOrders}
                  onRefreshClients={refreshTestClients}
                />
              ) : null}

              {/* ─── CACHE panel ───────────────────────────────── */}
              {activeSection === 'cache' ? (
                <CacheManagementPanel
                  isRefetching={isRefetching}
                  refetchState={refetchState}
                  onRefetch={handleRefetchAllRates}
                />
              ) : null}

              {/* SYSTEM STATUS panel */}
              {activeSection === 'system' ? (
                <SystemStatusPanel
                  systemStatus={systemStatus}
                  systemStatusLoading={systemStatusLoading}
                  systemStatusError={systemStatusError}
                  onRefresh={refreshSystemStatus}
                />
              ) : null}

              {/* Bottom breathing room */}
              <div className="h-12" />
            </motion.div>
          </AnimatePresence>
        </main>
      </div>
    </div>
  )
}
