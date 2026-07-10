import { readFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const ordersViewPath = path.join(root, 'web/src/components/Views/OrdersView.tsx');
// PS-157: the v2Hooks shims were split into per-domain modules. The literal
// checks below target useOrders.ts (exact-total delay), useLocations.ts +
// useShippingAccounts.ts (the enabled flag + enabled, count), and
// v2Hooks-shared.ts (the SharedDataHookOptions type). We concatenate those
// files into a single `hooks` string so the SAME substrings are still asserted.
const useOrdersPath = path.join(root, 'web/src/hooks/useOrders.ts');
const useLocationsPath = path.join(root, 'web/src/hooks/useLocations.ts');
const useShippingAccountsPath = path.join(root, 'web/src/hooks/useShippingAccounts.ts');
const hooksSharedPath = path.join(root, 'web/src/hooks/v2Hooks-shared.ts');
const homePath = path.join(root, 'web/src/Home.tsx');
const ordersParityPath = path.join(root, 'web/src/components/Views/orders-parity.ts');
const v2ApiClientPath = path.join(root, 'web/src/lib/v2-apiClient.ts');
const v2ApiClientSharedPath = path.join(root, 'web/src/lib/v2-apiClient/shared.ts');
const sidebarOrdersPath = path.join(root, 'web/src/components/Sidebar/SidebarOrders.tsx');
const markupsContextPath = path.join(root, 'web/src/contexts/MarkupsContext.tsx');
const packagePath = path.join(root, 'package.json');
// PS-317: the daily-stats fetch + rollover scheduling moved into the useDailyStats hook.
const useDailyStatsPath = path.join(root, 'web/src/components/Views/orders/useDailyStats.ts');

const [
  ordersView,
  useOrdersHook,
  useLocationsHook,
  useShippingAccountsHook,
  hooksShared,
  home,
  ordersParity,
  v2ApiClient,
  v2ApiClientShared,
  sidebarOrders,
  markupsContext,
  packageJsonRaw,
  dailyStatsHook,
] = await Promise.all([
  readFile(ordersViewPath, 'utf8'),
  readFile(useOrdersPath, 'utf8'),
  readFile(useLocationsPath, 'utf8'),
  readFile(useShippingAccountsPath, 'utf8'),
  readFile(hooksSharedPath, 'utf8'),
  readFile(homePath, 'utf8'),
  readFile(ordersParityPath, 'utf8'),
  readFile(v2ApiClientPath, 'utf8'),
  readFile(v2ApiClientSharedPath, 'utf8'),
  readFile(sidebarOrdersPath, 'utf8'),
  readFile(markupsContextPath, 'utf8'),
  readFile(packagePath, 'utf8'),
  readFile(useDailyStatsPath, 'utf8'),
]);

// Concatenation of the now-split v2 hook modules so the literal substring
// checks below match regardless of which per-domain file owns each line.
const hooks = [
  useOrdersHook,
  useLocationsHook,
  useShippingAccountsHook,
  hooksShared,
].join('\n');

const packageJson = JSON.parse(packageJsonRaw);

const checks = [
  {
    name: 'Orders startup support-data gate is present',
    pass: ordersView.includes('const ordersSupportDataEnabled =') &&
      ordersView.includes('activeOrderId != null') &&
      ordersView.includes('rateBrowserOpen') &&
      ordersView.includes('newOrderOpen') &&
      ordersView.includes('queueOpen') &&
      ordersView.includes("sortState.key === 'custcarrier'"),
  },
  {
    name: 'Orders does not fetch locations before user intent',
    pass: ordersView.includes('useLocations({ enabled: ordersSupportDataEnabled })'),
  },
  {
    name: 'Orders does not fetch shipping accounts before user intent',
    pass: ordersView.includes('useShippingAccounts({ enabled: ordersSupportDataEnabled })'),
  },
  {
    name: 'Shared data hooks support an enabled flag',
    pass: hooks.includes('type SharedDataHookOptions') &&
      hooks.includes('export function useLocations(options: SharedDataHookOptions = {})') &&
      hooks.includes('export function useShippingAccounts(options: SharedDataHookOptions = {})') &&
      (hooks.match(/const enabled = options\.enabled \?\? true/g) ?? []).length >= 2 &&
      (hooks.match(/enabled,/g) ?? []).length >= 3,
  },
  {
    name: 'Global SKU list stays lazy until the SKU dropdown requests it',
    pass: ordersView.includes('const [skuOptionsRequested, setSkuOptionsRequested] = useState(false)') &&
      ordersView.includes('if (!skuOptionsRequested) return') &&
      ordersView.includes('.fetchDistinctSkus({'),
  },
  {
    name: 'Daily stats initial load remains scheduled as noncritical work',
    pass: dailyStatsHook.includes('scheduleNonCriticalOrdersWork(() =>') &&
      dailyStatsHook.includes('void loadDailyStats()') &&
      dailyStatsHook.includes('}, 3000)'),
  },
  {
    name: 'Orders exact total count is delayed until after first paint',
    pass: hooks.includes('const [exactTotalReady, setExactTotalReady] = useState(false)') &&
      hooks.includes('window.setTimeout(() => setExactTotalReady(true), 2500)') &&
      hooks.includes('const delayExactTotal =') &&
      hooks.includes('includeTotal: delayExactTotal ? false : undefined') &&
      ordersView.includes('totalApproximate ?'),
  },
  {
    name: 'New Order modal chunk is loaded only after user intent',
    pass: ordersView.includes("import type { NewOrderPayload } from '../NewOrderModal'") &&
      !ordersView.includes("import NewOrderModal, { type NewOrderPayload } from '../NewOrderModal'") &&
      ordersView.includes("const NewOrderModal = lazy(() => import('../NewOrderModal'))") &&
      ordersView.includes('{newOrderOpen ? (') &&
      ordersView.includes('<NewOrderModal'),
  },
  {
    name: 'Order detail drawer chunk is loaded only after order-number intent',
    pass: !ordersView.includes("import OrderDetailDrawer from '../OrderDetailDrawer'") &&
      ordersView.includes("const OrderDetailDrawer = lazy(() => import('../OrderDetailDrawer'))") &&
      ordersView.includes('{detailDrawerOrderId != null ? (') &&
      ordersView.includes('<OrderDetailDrawer'),
  },
  {
    name: 'Tracking modal chunk is loaded only after tracking-number intent',
    pass: !ordersView.includes("import TrackingModal from '../TrackingModal'") &&
      ordersView.includes("const TrackingModal = lazy(() => import('../TrackingModal'))") &&
      ordersView.includes('{trackingModal != null ? (') &&
      ordersView.includes('<TrackingModal'),
  },
  {
    name: 'Legacy sidebar counts do not block Orders first paint',
    pass: sidebarOrders.includes('const initialTimerId = window.setTimeout(() =>') &&
      sidebarOrders.includes('}, 2500)') &&
      sidebarOrders.includes('window.clearTimeout(initialTimerId)') &&
      !sidebarOrders.includes('    void load()\n    const id = window.setInterval'),
  },
  {
    name: 'Legacy sidebar count polling pauses while hidden and stays slow',
    pass: sidebarOrders.includes("document.visibilityState !== 'visible'") &&
      sidebarOrders.includes('}, 180_000)'),
  },
  {
    name: 'Orders sync status polling is fresh, adaptive, and hidden-tab gated',
    pass: home.includes("if (displayView !== 'orders') return") &&
      home.includes('schedulePoll(5000)') &&
      home.includes('schedulePoll(nextDelayMs)') &&
      home.includes('apiClient.fetchLegacySyncStatus({ forceRefresh: true })') &&
      home.includes("next.status === 'syncing' ? 10_000 : 120_000") &&
      home.includes('[displayView, toastContext, syncStatus.status]') &&
      home.includes("document.visibilityState !== 'visible'") &&
      !home.includes('window.setInterval(() => {\n      if (document.visibilityState !== \'visible\') return\n      void poll()\n    }, 120_000)'),
  },
  {
    name: 'Orders sync status bypasses a fresh cache entry without discarding stale fallback',
    pass: v2ApiClient.includes('fetchLegacySyncStatus(options: { forceRefresh?: boolean } = {})') &&
      v2ApiClient.includes('forceRefresh: options.forceRefresh') &&
      v2ApiClientShared.includes('forceRefresh?: boolean') &&
      v2ApiClientShared.includes('if (!options.forceRefresh && existing?.hasValue'),
  },
  {
    name: 'Unknown sync progress is not displayed as a zero page',
    pass: ordersParity.includes("text: `${sync.mode === 'full' ? 'Full sync' : 'Syncing'}…`") &&
      !ordersParity.includes("(${sync.page || 0})"),
  },
  {
    name: 'Worker status polling is delayed and hidden-tab gated',
    pass: home.includes('apiClient.fetchSyncWorkerStatus()') &&
      home.includes('}, 7000)') &&
      home.includes("document.visibilityState !== 'visible'") &&
      home.includes('}, 120_000)'),
  },
  {
    name: 'Orders route delays global markup settings hydration',
    pass: markupsContext.includes('function getInitialMarkupHydrationDelayMs') &&
      markupsContext.includes("pathname.startsWith('/orders') ? 3500 : 0") &&
      markupsContext.includes("api.get<any>('/settings/markups')"),
  },
  {
    name: 'Markup settings hydration is cancellable and hidden-tab gated',
    pass: markupsContext.includes("document.visibilityState !== 'visible'") &&
      markupsContext.includes('window.clearTimeout(timerId)') &&
      markupsContext.includes("document.removeEventListener('visibilitychange', onVisibilityChange)"),
  },
  {
    name: 'Guard is wired into package scripts',
    pass: packageJson.scripts?.['test:orders-startup-requests'] === 'node scripts/orders-startup-requests-guard.mjs',
  },
];

const failures = checks.filter((check) => !check.pass);

for (const check of checks) {
  console.log(`${check.pass ? 'PASS' : 'FAIL'} ${check.name}`);
}

if (failures.length > 0) {
  console.error(`\n${failures.length} Orders startup request guard check${failures.length === 1 ? '' : 's'} failed.`);
  process.exit(1);
}
