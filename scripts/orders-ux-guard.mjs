import { readFile } from 'node:fs/promises'
import path from 'node:path'

const root = process.cwd()
const ordersViewPath = path.join(root, 'web/src/components/Views/OrdersView.tsx')
const orderDetailDrawerPath = path.join(root, 'web/src/components/OrderDetailDrawer.tsx')
const v2HooksPath = path.join(root, 'web/src/hooks/v2Hooks.ts')
const ordersRoutePath = path.join(root, 'src/routes/orders.ts')
const homePath = path.join(root, 'web/src/Home.tsx')
const shellCssPath = path.join(root, 'web/src/app-shell.css')

const [ordersView, orderDetailDrawer, v2Hooks, ordersRoute, home, shellCss] = await Promise.all([
  readFile(ordersViewPath, 'utf8'),
  readFile(orderDetailDrawerPath, 'utf8'),
  readFile(v2HooksPath, 'utf8'),
  readFile(ordersRoutePath, 'utf8'),
  readFile(homePath, 'utf8'),
  readFile(shellCssPath, 'utf8'),
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
      ordersView.includes('data-testid="orders-selection-toolbar"') &&
      ordersView.includes('{renderSelectionToolbar()}') &&
      shellCss.includes('.orders-selection-toolbar'),
  },
  {
    name: 'awaiting shipment selection has explicit shipping actions',
    pass:
      ordersView.includes("handleBatchAction('print')") &&
      ordersView.includes("handleBatchAction('queue')") &&
      ordersView.includes('Mark as Shipped'),
  },
  {
    name: 'shipped and cancelled selections are status-appropriate',
    pass:
      ordersView.includes('Queue Existing Labels') &&
      ordersView.includes('Shipping actions disabled') &&
      ordersView.includes('Cancelled orders can be selected for review or copy only.'),
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
    name: 'SKU Sort is server-side before pagination, not page-local only',
    pass:
      v2Hooks.includes('sort: sortBy') &&
      ordersView.includes("sortBy: skuSortActive ? 'sku' : undefined") &&
      ordersRoute.includes("sort: z.enum(['sku']).optional()") &&
      ordersRoute.includes('primary_sku_for_sort') &&
      ordersRoute.indexOf('primary_sku_for_sort') < ordersRoute.indexOf('.limit(q.pageSize)'),
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
      ordersView.includes('queued label{unprintedQueueCount === 1 ?') &&
      ordersView.includes('Click Print All first') &&
      ordersView.includes('disabled={queueCount === 0 || queuePrintInFlight || !queueConfirmPrintedReady}'),
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
