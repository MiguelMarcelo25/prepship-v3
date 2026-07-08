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
const ordersFilterToolbarPath = path.join(root, 'web/src/components/Views/OrdersFilterToolbar.tsx')
// PS-166 (Wave 2d): the batch-actions panel JSX moved VERBATIM to its own
// strict <OrdersBatchPanel> component (OrdersView passes the state/handlers
// as props) — batch-panel string pins read there; the handler DEFINITIONS
// (handleBatchAction etc.) stay in OrdersView and are pinned against it.
const batchPanelPath = path.join(root, 'web/src/components/Views/OrdersBatchPanel.tsx')
// PS-166 (Wave 6): the orders <table> (thead + tbody, incl. the per-row
// onClick={() => openOrderDetails(order.orderId)}) moved VERBATIM to its own
// strict <OrdersTable> component (OrdersView threads state/handlers in as
// props) — the row-click pin reads there; openOrderDetails stays in OrdersView.
const ordersTablePath = path.join(root, 'web/src/components/Views/OrdersTable.tsx')
// 2026-07-08 (OrdersView perf): the per-row <tr> markup moved VERBATIM from
// OrdersTable's row map into the memoized <OrderRow> component — the row-click
// pin follows it there.
const orderRowPath = path.join(root, 'web/src/components/Views/OrderRow.tsx')

const [ordersView, queueDrawer, selectionToolbar, orderDetailDrawer, v2Hooks, ordersRoute, home, shellCss, ordersFilterToolbar, batchPanel, ordersTable, orderRow] = await Promise.all([
  readFile(ordersViewPath, 'utf8'),
  readFile(queueDrawerPath, 'utf8'),
  readFile(selectionToolbarPath, 'utf8'),
  readFile(orderDetailDrawerPath, 'utf8'),
  readFile(v2HooksPath, 'utf8'),
  readFile(ordersRoutePath, 'utf8'),
  readFile(homePath, 'utf8'),
  readFile(shellCssPath, 'utf8'),
  readFile(ordersFilterToolbarPath, 'utf8'),
  readFile(batchPanelPath, 'utf8'),
  readFile(ordersTablePath, 'utf8'),
  readFile(orderRowPath, 'utf8'),
])

const normalizedOrdersView = ordersView.replace(/\r\n/g, '\n')

const checks = [
  {
    name: 'row click opens the detail drawer instead of entering bulk selection',
    pass:
      // PS-166 Wave 6: the per-row onClick moved to the extracted <OrdersTable>;
      // 2026-07-08: it moved again, VERBATIM, into the memoized <OrderRow>
      // (openOrderDetails still lives in OrdersView and is threaded in as a
      // prop). Same pin, same intent — a row click opens the drawer and must
      // never enter bulk selection, in ANY of the three files.
      orderRow.includes('onClick={() => openOrderDetails(order.orderId)}') &&
      !orderRow.includes('onClick={() => updateSelection([order.orderId])}') &&
      !ordersTable.includes('onClick={() => updateSelection([order.orderId])}') &&
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
    name: 'batch Send to Queue clears completed selections before the next batch',
    pass: (() => {
      const handlerStart = normalizedOrdersView.indexOf("async function handleBatchAction(mode: 'print' | 'queue')")
      if (handlerStart === -1) return false
      const queueBranchStart = normalizedOrdersView.indexOf("if (mode === 'queue')", handlerStart)
      if (queueBranchStart === -1) return false
      // Re-anchored 2026-07-08: the queue-branch END used to be marked by
      // `const queueJobId` — the first statement of the LEGACY sequential
      // Create+Print loop, deleted in 58cb23ec (chain-only batch print; the one
      // surviving `const queueJobId` now lives inside sendOrdersToQueueBackend,
      // far above this handler, so the forward search returned -1). The stable
      // end-of-branch marker is the print branch itself. The protected queue
      // branch is unchanged: it still awaits sendOrdersToQueueBackend and clears
      // busy + selection in `finally`.
      const printBranchStart = normalizedOrdersView.indexOf("if (mode === 'print')", queueBranchStart)
      if (printBranchStart === -1) return false
      const queueBranch = normalizedOrdersView.slice(queueBranchStart, printBranchStart)

      return (
        queueBranch.includes('sendOrdersToQueueBackend(batchOrders') &&
        queueBranch.includes('finally {') &&
        queueBranch.includes('setBatchBusy(false)') &&
        queueBranch.includes('clearSelection()')
      )
    })(),
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
    name: 'queue progress chip cannot overlap the centered Close Queue button',
    pass:
      home.includes('translate(calc(-100% - 128px), -50%)') &&
      home.includes('Right edge anchored 128px left of center') &&
      ordersFilterToolbar.includes("textOverflow: 'ellipsis'") &&
      ordersFilterToolbar.includes("overflow: 'hidden'") &&
      ordersFilterToolbar.includes("minWidth: 0"),
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
