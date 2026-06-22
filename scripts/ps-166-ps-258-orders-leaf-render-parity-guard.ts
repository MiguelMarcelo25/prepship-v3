/**
 * PS-166 / PS-258 - OrdersView extracted leaf render parity guard.
 *
 * Server-renders already-extracted presentational leaves and pins their public
 * DOM branches without touching OrdersView.tsx. Offline only: no browser, no
 * network, no labels, no queue writes, no order/shipment mutation, and no
 * shipped/cancelled data mutation.
 */
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

(globalThis as typeof globalThis & { React: typeof React }).React = React;

const { OrdersResultsEmptyState } = await import('../web/src/components/Views/OrdersResultsEmptyState');
const { OrdersSearchBar } = await import('../web/src/components/Views/OrdersSearchBar');
const { buildEmptyPanel } = await import('../web/src/components/Views/orders-empty-panel');

let failures = 0;
function check(name: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    console.log(`ok   ${name}`);
    return;
  }
  failures += 1;
  console.error(`FAIL ${name}${detail === undefined ? '' : ` - ${String(detail)}`}`);
}

function count(text: string, pattern: RegExp): number {
  return (text.match(pattern) ?? []).length;
}

function renderSearch(searchQuery: string, dateRange: { start?: string; end?: string } = {}): string {
  return renderToStaticMarkup(React.createElement(OrdersSearchBar, {
    searchQuery,
    dateRange,
    onSearchQueryChange: () => {},
  }));
}

function renderEmptyState(props: {
  loading?: boolean;
  error?: unknown;
  ordersSearching?: boolean;
  hasNoFilteredOrders?: boolean;
  searchQuery?: string;
  isGlobalSearchActive?: boolean;
}): string {
  return renderToStaticMarkup(React.createElement(OrdersResultsEmptyState, {
    loading: props.loading ?? false,
    error: props.error ?? null,
    ordersSearching: props.ordersSearching ?? false,
    hasNoFilteredOrders: props.hasNoFilteredOrders ?? false,
    searchQuery: props.searchQuery ?? '',
    isGlobalSearchActive: props.isGlobalSearchActive ?? false,
  }));
}

const searchEmpty = renderSearch('');
const searchActive = renderSearch('HU-10', { start: '2026-06-01' });

check('OrdersSearchBar empty render keeps the input DOM anchor',
  /id="searchInput"/.test(searchEmpty) &&
    /placeholder="Search orders, SKUs, names/.test(searchEmpty));
check('OrdersSearchBar empty render hides clear button and global-search pill',
  !/id="searchClear"/.test(searchEmpty) &&
    !/Searching all statuses/.test(searchEmpty));
check('OrdersSearchBar active render shows clear button and global-search pill',
  /id="searchClear"/.test(searchActive) &&
    /Searching all statuses &amp; stores/.test(searchActive) &&
    /in date range/.test(searchActive));
check('OrdersSearchBar active render carries the typed query as the input value',
  /value="HU-10"/.test(searchActive));

const loadingState = renderEmptyState({
  loading: true,
  ordersSearching: true,
  hasNoFilteredOrders: true,
  searchQuery: 'Leeds',
});
const searchingState = renderEmptyState({
  ordersSearching: true,
  hasNoFilteredOrders: true,
  searchQuery: 'Leeds',
  isGlobalSearchActive: true,
});
const emptyState = renderEmptyState({
  ordersSearching: false,
  hasNoFilteredOrders: true,
  searchQuery: 'Leeds',
  isGlobalSearchActive: true,
});

check('OrdersResultsEmptyState loading render stays blank',
  loadingState === '');
check('OrdersResultsEmptyState searching branch renders only the searching region',
  /id="searchingState"/.test(searchingState) &&
    /data-testid="orders-searching"/.test(searchingState) &&
    /Searching for/.test(searchingState) &&
    /Leeds/.test(searchingState) &&
    /Searching all statuses &amp; stores/.test(searchingState) &&
    !/id="emptyState"/.test(searchingState) &&
    !/No orders match/.test(searchingState));
check('OrdersResultsEmptyState empty branch renders only the empty region',
  /id="emptyState"/.test(emptyState) &&
    /No orders match/.test(emptyState) &&
    /Try clearing the search/.test(emptyState) &&
    !/id="searchingState"/.test(emptyState) &&
    !/data-testid="orders-searching"/.test(emptyState));

const panelWithoutHide = renderToStaticMarkup(buildEmptyPanel());
const panelWithHide = renderToStaticMarkup(buildEmptyPanel(() => {}));

check('buildEmptyPanel render keeps the empty-panel copy and keyboard legend',
  /No order selected/.test(panelWithoutHide) &&
    /Click any row to view details/.test(panelWithoutHide) &&
    /Navigate rows/.test(panelWithoutHide) &&
    /Select \/ deselect/.test(panelWithoutHide) &&
    /Deselect &amp; close/.test(panelWithoutHide) &&
    /Copy order #/.test(panelWithoutHide));
check('buildEmptyPanel without onHide omits the close affordance',
  !/Hide this panel when no order is selected/.test(panelWithoutHide));
check('buildEmptyPanel with onHide renders exactly one close affordance button',
  count(panelWithHide, /aria-label="Hide this panel when no order is selected"/g) === 1 &&
    /title="Hide this panel when no order is selected"/.test(panelWithHide));

const packageJson = readFileSync('package.json', 'utf8');
const statusDoc = readFileSync('docs/ps-tickets/ps-166-ps-258-decomposition-status.md', 'utf8');
const certificationDoc = readFileSync('docs/ps-tickets/ps-166-ps-258-decomposition-certification.md', 'utf8');
const closeoutGuard = readFileSync('scripts/ps-166-ps-258-decomposition-closeout-guard.ts', 'utf8');

check('package wires PS-166/258 leaf render parity guard',
  packageJson.includes('"test:ps-166-ps-258-orders-leaf-render-parity"'));
check('status docs list PS-166/258 leaf render parity guard',
  statusDoc.includes('`test:ps-166-ps-258-orders-leaf-render-parity`') &&
    certificationDoc.includes('`test:ps-166-ps-258-orders-leaf-render-parity`'));
check('closeout guard tracks PS-166/258 leaf render parity guard',
  closeoutGuard.includes('test:ps-166-ps-258-orders-leaf-render-parity'));
check('status docs stay below Final Review after leaf-level render parity',
  /PS-166 75%, PS-258 81%/.test(statusDoc) &&
    /not Final Review-ready/.test(statusDoc) &&
    /PS-166 75%, PS-258 81%/.test(certificationDoc) &&
    /not Final Review-ready/.test(certificationDoc));
check('status docs preserve no-live/no-mutation safety',
  /does not change runtime UI behavior/.test(certificationDoc) &&
    /shipped\/cancelled data/.test(certificationDoc));

if (failures > 0) {
  console.error(`\nFAIL PS-166/PS-258 Orders leaf render parity guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS PS-166/PS-258 Orders leaf render parity guard');
