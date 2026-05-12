# 2026-05-12 — Refactor `/inventory` Stock Levels to use the shared `<Table>` component

## Context

The Stock Levels tab on `/inventory` currently renders a bespoke `<table>` block (~600 lines of JSX + supporting state) inside `web/src/components/Views/InventoryView.tsx`. The same codebase already ships a reusable `<Table>` primitive at `web/src/components/ui/Table.tsx` (currently consumed only by the V11 Clients variant page). The inventory bespoke implementation has accreted state for sort, column widths, column order, column visibility, and pagination — all of which the shared `<Table>` already manages internally.

This spec covers swapping the rendering to `<Table>` and extending the shared component with the one missing capability (pagination) so future tables in the codebase get the same affordance for free.

## Constraints (per operator)

- **Frontend only**: no backend routes touched, no API client changes, no business-logic function changes.
- **Behavior preserved**: action handlers, filters, popovers, focus-flash, all per-row interactions stay identical.
- **Bulk Edit mode stays bespoke**: it's an alternate 8-column dim-edit layout where reorder/hide/paginate don't apply. Untouched.
- **Other inventory tabs (Receive, Alerts, Parent SKUs, History)**: untouched.

## What `<Table>` already does (no changes needed)

| Capability | How |
|---|---|
| Sort with persistence | `defaultSort`, `storageKey:sort` |
| Column resize | drag right edge of header; `storageKey:widths` |
| Drag-to-reorder columns | HTML5 DnD on headers; `storageKey:order` |
| Visibility toggle (Columns picker) | `hideable`/`defaultHidden` per column; `storageKey:hidden` |
| Pinned columns | `pinned: true` on column def |
| Sticky thead | built-in |
| Density | `density: 'compact' | 'normal' | 'comfortable'` |
| Loading + empty states | `loading` prop, `emptyMessage` prop |
| Row click | `onRowClick` prop |
| Toolbar slot | `toolbar` prop |

## What needs to be added to `<Table>`

### 1. Pagination (client-side, opt-in)

New `TableProps` fields:
```ts
paginated?: boolean            // default false
pageSizeOptions?: number[]     // default [25, 50, 100]
defaultPageSize?: number       // default 50
```

- Page state lives inside `<Table>` when `paginated: true`.
- Persists to `${storageKey}:page` and `${storageKey}:pageSize`.
- Auto-resets to page 1 when `data.length` decreases or sort changes.
- Renders the existing `AnalysisPagination` component below `<tbody>`.

### 2. Per-row className

New `TableProps` field:
```ts
rowClassName?: (row: Row, index: number) => string | undefined
```

For Inventory's "focused SKU" flash effect (currently `style={isFocused ? { background: 'var(--ss-blue-bg)' } : undefined}` on each `<tr>`).

## What Inventory deletes (state-plumbing — not behavior)

| Removed | Replaced by |
|---|---|
| `stockSort` + `handleStockSort` + `renderStockSortHeader` | `<Table>` internal sort |
| `inventoryColumnLayout` (order + hidden) + reader/writer/handlers (~150 LoC) | `<Table>` internal order/hidden state |
| `inventoryColumnWidths` + reader/writer/handlers (~70 LoC) | `<Table>` internal widths state |
| `inventoryColumnsMenuOpen` + portal Columns popover JSX (~120 LoC) | `<Table>` Columns picker |
| `stockPage` + `stockPageSize` + persistence effects (~40 LoC) | `<Table>` `paginated` mode |
| `renderInventoryColumnHeader` + bespoke colgroup/thead/tbody (~250 LoC) | `<Table>` rendering |
| `pagedRows`, `groupedRows` | `<Table>` paginates internally; group rendering removed (going flat per Option B) |

Estimated net delete: ~600 LoC of state + JSX.

## What Inventory keeps (behavior — untouched)

- `items` state (from API)
- `filteredRows` useMemo (search/client/low-out/active filtering — uses `filterInventoryRows` from inventory-parity.ts)
- Filter UI: search input, client picker, Low/Out only, Active only toggle
- Action handlers: `openEditSku`, `openSkuDrawer`, `handleToggleRowActive`, `handleInlineParentChange`, adjust modal, etc.
- Parent-SKU popover (portal, anchored to chain-link button refs)
- `focusInvSkuId` state for SKU drawer flash navigation (passed through `rowClassName`)
- Bulk Edit mode (alternate render path, untouched)
- All other tabs

## Column schema for inventory

```ts
const columns: TableColumn<InventoryItemDto>[] = [
  { key: 'sku', label: 'SKU', width: 150, sortable: true, hideable: false,
    render: (row) => <button onClick={...}>{row.sku}</button> },
  { key: 'thumbnail', label: 'Image', width: 56, sortable: false,
    render: (row) => row.imageUrl ? <img src={row.imageUrl}/> : <NoImg/> },
  { key: 'name', label: 'Name', width: 200, sortable: true, hideable: false,
    render: (row) => <button onClick={...}>{row.name}</button> },
  { key: 'client', label: 'Client', width: 130, sortable: true,
    render: (row) => row.clientName },
  { key: 'weight', label: 'Weight', width: 90, align: 'right', sortable: true,
    render: (row) => row.weightOz > 0 ? formatWeight(row.weightOz) : '—' },
  { key: 'dims', label: 'Dims (LxWxH)', width: 100, align: 'center', sortable: true,
    render: ... },
  { key: 'cuFt', label: 'Cu Ft/Unit', width: 80, align: 'center', sortable: true,
    render: ... },
  { key: 'package', label: 'Package', width: 110, sortable: true, render: ... },
  { key: 'stock', label: 'Stock', width: 70, align: 'center', sortable: true,
    render: (row) => <span className={...}>{row.currentStock}</span> },
  { key: 'sold30', label: 'Sold 30d', width: 75, align: 'center', sortable: true,
    render: ... },
  { key: 'unitsPerPack', label: 'Units/Pack', width: 85, align: 'center', sortable: true,
    render: ... },
  { key: 'totalUnits', label: 'Total Units', width: 90, align: 'center', sortable: true,
    render: ... },
  { key: 'min', label: 'Min', width: 55, align: 'center', sortable: true,
    render: (row) => row.minStock },
  { key: 'status', label: 'Status', width: 70, align: 'center', sortable: true,
    render: (row) => <StockBadge status={row.status}/> },
  { key: 'actions', label: 'Actions', width: 200, sortable: false,
    render: (row) => <ActionsCell row={row} .../> },
]
```

The `actions` column's render produces the full pencil + chain-link + ± + active-toggle button cluster, capturing the trigger button ref for the parent-SKU popover anchor.

## Usage at the render site

```tsx
{stockLoading ? (
  <LoadingState />
) : sortedRows.length === 0 ? (
  <EmptyState />
) : (
  <Table
    data={filteredRows}            // pre-filtered; Table sorts internally
    columns={INVENTORY_COLUMNS}
    rowKey={(row) => row.id}
    storageKey="inventory-stock-levels"
    onRowClick={(row) => openSkuDrawer(row.id)}
    paginated
    pageSizeOptions={[10, 20, 50, 100, 200]}
    defaultPageSize={50}
    rowClassName={(row) => focusInvSkuId === row.id ? 'is-focused' : ''}
    loading={stockLoading}
    emptyMessage={alertOnly ? 'No low/out stock' : 'No SKUs found'}
  />
)}
```

## Risk

- **Low**. Existing `<Table>` consumer (V11 Clients page) keeps working — new props are all opt-in (defaults preserve current behavior).
- Bulk Edit mode untouched.
- Every Inventory behavior has a clear migration path in the column `render` functions.

## Out of scope

- Bulk Edit mode refactor (separate spec if ever wanted).
- Server-side pagination (Table is client-side only).
- Refactor of V11 Clients page (no operator request).
- Grouping support in `<Table>` (Option C from the brainstorm — deferred since we're going flat per Option B).

## Definition of done

- `<Table>` has the 2 new opt-in props (`paginated`/`pageSizeOptions`/`defaultPageSize` + `rowClassName`).
- `/inventory` Stock Levels tab renders via `<Table>` with all 15 columns visible by default.
- Operator can still: sort by clicking any header, resize columns, drag-reorder, hide via Columns picker, paginate, click any row to open SKU drawer, edit/parent-link/adjust/active-toggle each row.
- Parent-SKU popover still anchors correctly via portal.
- Bulk Edit mode still works (alternate render path).
- `npx tsc --noEmit` clean.
- `vite build` clean.
