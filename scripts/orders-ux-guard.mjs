import { readFile } from 'node:fs/promises'
import path from 'node:path'

const root = process.cwd()
const ordersViewPath = path.join(root, 'web/src/components/Views/OrdersView.tsx')
// PS-178 (Phase 6, part 3): the Print Queue drawer JSX moved VERBATIM to its own
// render-only component — drawer-string pins read there; queue STATE pins stay
// against OrdersView, which kept all queue state/derivations/handlers.
const queueDrawerPath = path.join(root, 'web/src/components/Views/OrdersPrintQueueDrawer.tsx')
// PS-178 (Phase 6, part 4): the selected-rows toolbar JSX moved VERBATIM to its
// own render-only component (thin renderSelectionToolbar wrapper kept in
// OrdersView) — toolbar-string pins read there.
const selectionToolbarPath = path.join(root, 'web/src/components/Views/OrdersSelectionToolbar.tsx')
const orderDetailDrawerPath = path.join(root, 'web/src/components/OrderDetailDrawer.tsx')
// PS-157: useOrders split out of v2Hooks.ts into its own module; the
// server-side SKU sort param ('sort: sortBy') now lives in useOrders.ts.
const v2HooksPath = path.join(root, 'web/src/hooks/useOrders.ts')
const ordersRoutePath = path.join(root, 'src/routes/orders.ts')
const homePath = path.join(root, 'web/src/Home.tsx')
const shellCssPath = path.join(root, 'web/src/app-shell.css')
// PS-166 (Wave 2d): the batch-actions panel JSX moved VERBATIM to its own
// strict <OrdersBatchPanel> component (OrdersView passes the state/handlers
// as props) — batch-panel string pins read there; the handler DEFINITIONS
// (handleBatchAction etc.) stay in OrdersView and are pinned against it.
const batchPanelPath = path.join(root, 'web/src/components/Views/OrdersBatchPanel.tsx')

const [ordersView, queueDrawer, selectionToolbar, orderDetailDrawer, v2Hooks, ordersRoute, home, shellCss, batchPanel] = await Promise.all([
  readFile(ordersViewPath, 'utf8'),
  readFile(queueDrawerPath, 'utf8'),
  readFile(selectionToolbarPath, 'utf8'),
  readFile(orderDetailDrawerPath, 'utf8'),
  readFile(v2HooksPath, 'utf8'),
  readFile(ordersRoutePath, 'utf8'),
  readFile(homePath, 'utf8'),
  readFile(shellCssPath, 'utf8'),
  readFile(batchPanelPath, 'utf8'),
])

const normalizedOrdersView = ordersView.replace(/\r\n/g, '\n')

const checks = [
  {
    name: 'row click opens the detail drawer instead of entering bulk selection',
    pass:
      ordersView.includes('onClick={() => openOrderDetails(order.orderId)}') &&
      !ordersView.includes('onClick={() => updateSelection([order.orderId])}'),
  },
  {
    name: 'selected-row actions render next to the orders table',
    pass:
      selectionToolbar.includes('data-testid="orders-selection-toolbar"') &&
      ordersView.includes('{renderSelectionToolbar()}') &&
      shellCss.includes('.orders-selection-toolbar'),
  },
  {
    // PS-166 Wave 2d re-anchor: the batch-action onClicks + Mark-as-Shipped
    // label live in the extracted <OrdersBatchPanel>; OrdersView still owns
    // the handleBatchAction handler (pinned by ps-099/recalculate-strict) and
    // passes it as a prop.
    name: 'awaiting shipment selection has explicit shipping actions',
    pass:
      batchPanel.includes("handleBatchAction('print')") &&
      batchPanel.includes("handleBatchAction('queue')") &&
      batchPanel.includes('as Shipped') &&
      ordersView.includes('handleBatchAction={handleBatchAction}'),
  },
  {
    name: 'shipped and cancelled selections are status-appropriate',
    pass:
      selectionToolbar.includes('Queue Existing Labels') &&
      selectionToolbar.includes('Shipping actions disabled') &&
      selectionToolbar.includes('Cancelled orders can be selected for review or copy only.'),
  },
  {
    name: 'global topbar no longer owns visible selection actions',
    pass: home.includes('Orders selection actions now live next to the table') || home.includes('{false ? ('),
  },
  {
    name: 'order detail drawer status badge uses fetched order status, not the active sidebar route',
    pass: !ordersView.includes('displayStatus={currentStatus}'),
  },
  {
    name: 'order detail drawer prefers PrepShip local status over raw provider status',
    pass:
      orderDetailDrawer.includes('payload?.orderStatus') &&
      orderDetailDrawer.indexOf('payload?.orderStatus') < orderDetailDrawer.indexOf('raw.orderStatus'),
  },
  {
    name: 'SKU Sort is exact-composition server-side before pagination, not page-local only',
    pass:
      v2Hooks.includes('sort: sortBy') &&
      ordersView.includes("sortBy: skuSortActive ? 'sku' : undefined") &&
      ordersRoute.includes("sort: z.enum(['sku']).optional()") &&
      ordersRoute.includes('sku_composition_for_sort') &&
      ordersRoute.includes('string_agg(sku_qty.sku_key') &&
      ordersRoute.indexOf('sku_composition_for_sort') < ordersRoute.indexOf('.limit(q.pageSize)'),
  },
  {
    name: 'print queue badge hydrates on page load before the drawer opens',
    pass:
      !normalizedOrdersView.includes('useEffect(() => {\n    if (!queueOpen) return\n    if (queueScope') &&
      normalizedOrdersView.includes('void hydrateQueue()\n    if (!queueOpen)') &&
      ordersView.includes('if (queueOpen) setQueueLoading(true)') &&
      ordersView.includes('if (!cancelled && queueOpen)'),
  },
  {
    name: 'Confirm Printed stays disabled until queued labels are printed first',
    pass:
      ordersView.includes('queuePrintReadyEntryIds') &&
      ordersView.includes('queueConfirmPrintedReady') &&
      queueDrawer.includes('queued label{unprintedQueueCount === 1 ?') &&
      queueDrawer.includes('Click Print All first') &&
      queueDrawer.includes('disabled={queueCount === 0 || queuePrintInFlight || !queueConfirmPrintedReady}'),
  },
  {
    name: 'print queue search matches visible item names and SKU text',
    pass:
      ordersView.includes('matchesQueueGroupSearch') &&
      ordersView.includes('const label = group.label.toLowerCase()') &&
      ordersView.includes('const description = group.description.toLowerCase()') &&
      ordersView.includes('itemDescription.includes(pqSearchLower)') &&
      ordersView.includes('queueGroups.filter(matchesQueueGroupSearch)'),
  },
]

const failures = checks.filter((check) => !check.pass)

for (const check of checks) {
  console.log(`${check.pass ? 'PASS' : 'FAIL'} ${check.name}`)
}

if (failures.length > 0) {
  console.error(`\n${failures.length} Orders UX guard check${failures.length === 1 ? '' : 's'} failed.`)
  process.exit(1)
}
