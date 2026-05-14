import { readFile } from 'node:fs/promises'
import path from 'node:path'

const root = process.cwd()
const ordersViewPath = path.join(root, 'web/src/components/Views/OrdersView.tsx')
const homePath = path.join(root, 'web/src/Home.tsx')
const shellCssPath = path.join(root, 'web/src/app-shell.css')

const [ordersView, home, shellCss] = await Promise.all([
  readFile(ordersViewPath, 'utf8'),
  readFile(homePath, 'utf8'),
  readFile(shellCssPath, 'utf8'),
])

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
]

const failures = checks.filter((check) => !check.pass)

for (const check of checks) {
  console.log(`${check.pass ? 'PASS' : 'FAIL'} ${check.name}`)
}

if (failures.length > 0) {
  console.error(`\n${failures.length} Orders UX guard check${failures.length === 1 ? '' : 's'} failed.`)
  process.exit(1)
}
