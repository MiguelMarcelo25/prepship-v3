/**
 * PS-166 / PS-258 - OrdersView selected UI render parity guard.
 *
 * Server-renders the already-extracted selection toolbar and statically pins the
 * batch panel's read-only/no-label-action branches without touching OrdersView.tsx.
 * Offline only: no browser, network, labels, queues, order mutation, shipment
 * mutation, marketplace calls, or shipped/cancelled data changes.
 */
import React from 'react';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';

(globalThis as typeof globalThis & { React: typeof React }).React = React;

const { OrdersSelectionToolbar } = await import('../web/src/components/Views/OrdersSelectionToolbar');

let failures = 0;
function check(name: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    console.log(`ok   ${name}`);
    return;
  }
  failures += 1;
  console.error(`FAIL ${name}${detail === undefined ? '' : ` - ${String(detail)}`}`);
}

const noop = () => {};
const setBool = (_value: boolean | ((open: boolean) => boolean)) => {};

function renderToolbar(overrides: Partial<React.ComponentProps<typeof OrdersSelectionToolbar>> = {}): string {
  return renderToStaticMarkup(React.createElement(OrdersSelectionToolbar, {
    selectedOrderIds: [101, 102],
    allMatchingSelection: null,
    selectionScopeKey: 'awaiting:all',
    currentStatus: 'awaiting_shipment',
    isMobileViewport: true,
    batchBusy: false,
    extShipBusy: false,
    batchExtShipMenuOpen: false,
    setBatchExtShipMenuOpen: setBool,
    batchTestMode: false,
    setBatchTestMode: noop,
    handleBatchAction: noop,
    handleBatchMarkAsShipped: noop,
    queueExistingLabels: noop,
    clearSelection: noop,
    ...overrides,
  }));
}

const toolbarEmpty = renderToolbar({ selectedOrderIds: [] });
const toolbarAwaiting = renderToolbar();
const toolbarAllMatching = renderToolbar({
  selectedOrderIds: [101, 102, 103],
  allMatchingSelection: { active: true, scopeKey: 'awaiting:all', ids: [101, 102, 103], truncated: true },
});
const toolbarShipped = renderToolbar({ currentStatus: 'shipped' });
const toolbarCancelled = renderToolbar({ currentStatus: 'cancelled' });

check('OrdersSelectionToolbar zero selection renders nothing',
  toolbarEmpty === '');
check('OrdersSelectionToolbar awaiting mobile render keeps print and queue actions',
  /orders-selection-toolbar/.test(toolbarAwaiting) &&
    /Print Label/.test(toolbarAwaiting) &&
    /Print to Queue/.test(toolbarAwaiting) &&
    /Mark Shipped/.test(toolbarAwaiting) &&
    /Test mode/.test(toolbarAwaiting) &&
    /Clear selected orders/.test(toolbarAwaiting));
check('OrdersSelectionToolbar all-matching copy branch is pinned',
  /First 3 matching orders selected across pages/.test(toolbarAllMatching));
check('OrdersSelectionToolbar shipped branch queues existing labels only',
  /Queue Existing Labels/.test(toolbarShipped) &&
    !/Print Label/.test(toolbarShipped) &&
    !/Mark Shipped/.test(toolbarShipped));
check('OrdersSelectionToolbar cancelled branch renders read-only action note',
  /Shipping actions disabled/.test(toolbarCancelled) &&
    !/Print Label/.test(toolbarCancelled) &&
    !/Mark Shipped/.test(toolbarCancelled));

const batchPanelSource = readFileSync('web/src/components/Views/OrdersBatchPanel.tsx', 'utf8');

check('OrdersBatchPanel source keeps isReadOnly null gate',
  /if \(isReadOnly\) return null/.test(batchPanelSource));
check('OrdersBatchPanel source keeps awaiting-only label actions',
  /currentStatus === 'awaiting_shipment'/.test(batchPanelSource) &&
    /Create \+ Print Label/.test(batchPanelSource) &&
    /Send to Queue/.test(batchPanelSource) &&
    /Test mode/.test(batchPanelSource));
check('OrdersBatchPanel source keeps non-awaiting read-only fallback',
  /Shipped orders/.test(batchPanelSource) &&
    /Cancelled orders/.test(batchPanelSource) &&
    /read only/.test(batchPanelSource) &&
    /cannot have labels created/.test(batchPanelSource));

const packageJson = readFileSync('package.json', 'utf8');
const statusDoc = readFileSync('docs/ps-tickets/ps-166-ps-258-decomposition-status.md', 'utf8');
const certificationDoc = readFileSync('docs/ps-tickets/ps-166-ps-258-decomposition-certification.md', 'utf8');
const closeoutGuard = readFileSync('scripts/ps-166-ps-258-decomposition-closeout-guard.ts', 'utf8');

check('package wires PS-166/258 selection render parity guard',
  packageJson.includes('"test:ps-166-ps-258-orders-selection-render-parity"'));
check('status docs list PS-166/258 selection render parity guard',
  statusDoc.includes('`test:ps-166-ps-258-orders-selection-render-parity`') &&
    certificationDoc.includes('`test:ps-166-ps-258-orders-selection-render-parity`'));
check('closeout guard tracks PS-166/258 selection render parity guard',
  closeoutGuard.includes('test:ps-166-ps-258-orders-selection-render-parity'));
check('status docs keep PS-166/258 below Final Review after selection render parity',
  /PS-166 75%, PS-258 81%/.test(statusDoc) &&
    /not Final Review-ready/.test(statusDoc) &&
    /PS-166 75%, PS-258 81%/.test(certificationDoc) &&
    /not Final Review-ready/.test(certificationDoc));
check('status docs preserve no-live/no-mutation safety',
  /does not change runtime UI behavior/.test(certificationDoc) &&
    /shipped\/cancelled data/.test(certificationDoc));

if (failures > 0) {
  console.error(`\nFAIL PS-166/PS-258 Orders selection render parity guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS PS-166/PS-258 Orders selection render parity guard');
