import { readFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const ordersViewPath = path.join(root, 'web/src/components/Views/OrdersView.tsx');
const hooksPath = path.join(root, 'web/src/hooks/v2Hooks.ts');
const sidebarOrdersPath = path.join(root, 'web/src/components/Sidebar/SidebarOrders.tsx');
const markupsContextPath = path.join(root, 'web/src/contexts/MarkupsContext.tsx');
const packagePath = path.join(root, 'package.json');

const [ordersView, hooks, sidebarOrders, markupsContext, packageJsonRaw] = await Promise.all([
  readFile(ordersViewPath, 'utf8'),
  readFile(hooksPath, 'utf8'),
  readFile(sidebarOrdersPath, 'utf8'),
  readFile(markupsContextPath, 'utf8'),
  readFile(packagePath, 'utf8'),
]);

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
    pass: ordersView.includes('scheduleNonCriticalOrdersWork(() =>') &&
      ordersView.includes('void loadDailyStats()') &&
      ordersView.includes('}, 3000)'),
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
    name: 'Orders route delays global markup settings hydration',
    pass: markupsContext.includes('function getInitialMarkupHydrationDelayMs') &&
      markupsContext.includes("pathname.startsWith('/orders') ? 3500 : 0") &&
      markupsContext.includes("api.get<any>('/settings')"),
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
