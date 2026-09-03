import { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Printer } from 'lucide-react';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Input';
import { Select } from '../components/ui/Select';
import { api, qs } from '../lib/api';
import { activeClientRowsQueryOptions } from '../lib/client-query';
import {
  californiaDateInputValue,
  californiaDayEndIso,
  californiaDayStartIso,
  formatCaDateLong,
} from '../lib/ca-time';
import {
  SortableHeader,
  nextSortState,
  sortRows,
  type SortState,
} from '../components/SortableTable';
import { formatBillingShipDate } from '../components/Views/billing-parity';
import { buildInvoiceSummaryCategories } from './invoice-summary-categories';

type LineItem = {
  id: number;
  clientId: number;
  orderId: number | null;
  orderNumber: string | null;
  shipmentId: number | null;
  shipDate: string | null;
  actualActivityDate?: string | null;
  billingEffectiveDate?: string | null;
  rolledFromWeekend?: boolean;
  lineType: string;
  description: string | null;
  qty: string | null;
  unitCost: string | null;
  totalCost: string;
  // PS-488 M3 — the canonical fields /billing/details already emits. This page was
  // typed against the RAW line-item shape it was written for years ago, so it read
  // lineType (always 'billing_order' after aggregation) and totalCost (always 0 on an
  // aggregate, because the money lives in grandTotal). The columns were therefore
  // structurally wrong for EVERY row, not only returns; returns simply made it visible.
  displayReference?: string | null;
  rowType?: 'Outbound' | 'Return';
  grandTotal?: number;
  returnId?: number | null;
  displayQty?: string;
  /** PS-488 M3 — whether the fee EXISTS, distinct from its amount being 0. */
  hasReturnPostageLine?: boolean;
  hasReturnProcessingLine?: boolean;
};

type Client = {
  id: number;
  name: string;
  email: string | null;
  phone: string | null;
};

type InvoiceTotals = {
  orderCount: number;
  pickPackTotal: number;
  additionalTotal: number;
  pickPackFeeTotal: number;
  packageTotal: number;
  shippingTotal: number;
  storageTotal: number;
  // PS-514: Adjustment + Return categories the summary now renders (grandTotal already sums both;
  // returns are live today). Optional so a stale API response reads 0, not NaN.
  adjustmentTotal?: number;
  returnTotal?: number;
  // PS-513: replacement re-ship money, its own categories (billing-invoice-totals.ts, PS-502
  // AC-18). Optional so a stale API response reconciles to a $0 Replacement rather than NaN.
  replacePostageTotal?: number;
  replacePickPackTotal?: number;
  grandTotal: number;
  fulfillmentFeeTotal: number;
};

type InvoiceSummarySortKey = 'category' | 'amount';
type InvoiceLineSortKey =
  | 'date'
  | 'order'
  | 'type'
  | 'description'
  | 'qty'
  | 'unit'
  | 'total';

function fmtMoney(s: string | number) {
  const n = Number(s);
  return Number.isFinite(n) ? `$${n.toFixed(2)}` : '—';
}

/**
 * PS-488 M3 — the money for a /billing/details row.
 *
 * These rows are AGGREGATES: toBillingDetailOrderRows collapses every component line
 * of a business row into one row and puts the summed money in `grandTotal`, stamping
 * the component field `totalCost` to a literal 0. This page read `totalCost`, so the
 * per-line Amount column rendered $0.00 for every row while the summary block above
 * it (fed by billingInvoiceHeaderTotals) showed the real money. grandTotal is the
 * only correct source; totalCost survives solely as a fallback for any caller still
 * handing this component a pre-aggregation row.
 */
function invoiceRowTotal(line: LineItem): number {
  const grand = Number(line.grandTotal);
  if (Number.isFinite(grand)) return grand;
  const legacy = Number(line.totalCost);
  return Number.isFinite(legacy) ? legacy : 0;
}

/**
 * PS-488 M3 — a stable React/sort key.
 *
 * `id` belongs to one COMPONENT line of the aggregate, so it is not a durable identity
 * for the business row. A Return keys on its relational returnId: two returns raised on
 * one order share an orderId and an orderNumber and would otherwise collide.
 */
function invoiceRowKey(line: LineItem): string | number {
  return line.returnId != null ? `return:${line.returnId}` : line.id;
}

function startOfMonthIso(d = new Date()) {
  const today = californiaDateInputValue(d);
  return californiaDayStartIso(`${today.slice(0, 8)}01`);
}
function endOfMonthIso(d = new Date()) {
  const today = californiaDateInputValue(d);
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7));
  const last = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
  return californiaDayEndIso(last);
}
function toDateInput(iso: string) {
  return iso.slice(0, 10);
}
function fromDateInputStart(ymd: string) {
  return californiaDayStartIso(ymd);
}
function fromDateInputEnd(ymd: string) {
  return californiaDayEndIso(ymd);
}

export default function Invoice() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const clientId = Number(searchParams.get('clientId') ?? '');
  const dateFrom =
    searchParams.get('dateFrom') ?? toDateInput(startOfMonthIso());
  const dateTo = searchParams.get('dateTo') ?? toDateInput(endOfMonthIso());

  const [issuedAt] = useState(() => new Date());
  const [summarySort, setSummarySort] = useState<SortState<InvoiceSummarySortKey>>(null);
  const [lineSort, setLineSort] = useState<SortState<InvoiceLineSortKey>>(null);

  const update = (k: string, v: string) => {
    const next = new URLSearchParams(searchParams);
    if (v) next.set(k, v);
    else next.delete(k);
    setSearchParams(next);
  };

  // 2026-05-12: explicit activeOnly=true — invoices for disabled
  // clients are accessible via the admin Clients tab, not this view.
  const clients = useQuery(activeClientRowsQueryOptions());
  const client = clients.data?.find((c) => c.id === clientId) ?? null;

  const detailsQs = useMemo(
    () =>
      qs({
        clientId: Number.isFinite(clientId) ? clientId : undefined,
        dateFrom: fromDateInputStart(dateFrom),
        dateTo: fromDateInputEnd(dateTo),
        // PS-488 M3 — `limit` removed. GET /billing/details never forwarded it to
        // billingDetails() (the handler passes only clientId/dateFrom/dateTo), so it
        // capped nothing; it only forked this page's React Query cache key away from
        // every other consumer of the same range. Dropping it removes a parameter that
        // read as a safety bound while providing none. A real cap has to be enforced
        // server-side, and would have to be applied AFTER aggregation or it would
        // truncate a business row mid-collapse.
      }),
    [clientId, dateFrom, dateTo]
  );

  const details = useQuery({
    queryKey: ['billing-details-invoice', detailsQs],
    queryFn: () => api.get<{ data: LineItem[]; totals: InvoiceTotals | null }>(`/billing/details${detailsQs}`),
    enabled: Number.isFinite(clientId) && clientId > 0,
  });

  const lines = details.data?.data ?? [];
  const totals = details.data?.totals ?? null;
  const summaryRows = useMemo(() => {
    return sortRows(
      totals
        // PS-514: the full category breakdown is a backend-owned pure function. It renders every
        // category grandTotal includes — Adjustment + Return added here, Replacement from PS-513 —
        // so the summary cards reconcile to the Total instead of under-summing whenever a return or
        // adjustment exists. Returns are live today, so the summary was mis-footing in production.
        ? buildInvoiceSummaryCategories(totals)
        : [],
      summarySort,
      (row, key) => (key === 'amount' ? row.amount : row.type),
      (row) => row.type
    );
  }, [summarySort, totals]);
  const rowCounts = useMemo(
    () => ({
      total: lines.length,
      returns: lines.filter((line) => line.rowType === 'Return').length,
    }),
    [lines]
  );
  const sortedLines = useMemo(
    () =>
      sortRows(
        lines,
        lineSort,
        (line, key) => {
          switch (key) {
            case 'date':
              return line.billingEffectiveDate ?? line.shipDate;
            case 'order':
              return line.displayReference ?? line.orderNumber ?? line.orderId;
            case 'type':
              return line.rowType ?? line.lineType;
            case 'description':
              return line.description;
            case 'qty':
              return Number(line.qty);
            case 'unit':
              return Number(line.unitCost);
            case 'total':
              return invoiceRowTotal(line);
            default:
              return '';
          }
        },
        invoiceRowKey
      ),
    [lineSort, lines]
  );

  return (
    <div className="h-full w-full flex flex-col bg-white">
      {/* Toolbar — hidden on print */}
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-line bg-surface-2 print:hidden">
        <Button variant="ghost" size="sm" onClick={() => navigate(-1)}>
          <ArrowLeft size={12} />
          Back
        </Button>
        <div className="font-bold text-ink">Invoice</div>
        <div className="flex-1" />
        <Select
          value={clientId || ''}
          onChange={(e) => update('clientId', e.target.value)}
        >
          <option value="">Pick client…</option>
          {(clients.data ?? []).map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
        <Input
          type="date"
          value={dateFrom}
          onChange={(e) => update('dateFrom', e.target.value)}
          className="!w-[140px]"
        />
        <span className="text-ink-3">—</span>
        <Input
          type="date"
          value={dateTo}
          onChange={(e) => update('dateTo', e.target.value)}
          className="!w-[140px]"
        />
        <Button
          variant="primary"
          size="sm"
          onClick={() => window.print()}
          disabled={!client}
        >
          <Printer size={12} />
          Print
        </Button>
      </div>

      {/* Print-friendly body */}
      <div className="flex-1 min-h-0 overflow-auto p-8 print:p-0">
        <div className="max-w-[900px] mx-auto">
          {!Number.isFinite(clientId) || clientId === 0 ? (
            <div className="text-center text-ink-3 py-16">
              Pick a client above to render an invoice.
            </div>
          ) : (
            <>
              {/* Header */}
              <div className="flex items-start justify-between mb-8 print:mb-6">
                <div>
                  <div className="flex items-baseline text-[24px] font-extrabold tracking-[-0.5px]">
                    <span className="text-ink">PREP</span>
                    <span className="text-brand">SHIP</span>
                  </div>
                  <div className="text-[10px] uppercase tracking-[0.4px] text-ink-3 mt-1">
                    Dr Prepper Fulfillment
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-[24px] font-extrabold text-ink">INVOICE</div>
                  <div className="text-tiny text-ink-3 mt-1">
                    Issued {formatCaDateLong(issuedAt)}
                  </div>
                </div>
              </div>

              {/* Bill to + period */}
              <div className="grid grid-cols-2 gap-6 mb-6">
                <div>
                  <div className="section-label mb-1">Bill to</div>
                  <div className="font-bold text-ink">
                    {client?.name ?? `Client #${clientId}`}
                  </div>
                  {client?.email && (
                    <div className="text-tiny font-mono text-ink-2">
                      {client.email}
                    </div>
                  )}
                  {client?.phone && (
                    <div className="text-tiny text-ink-2">{client.phone}</div>
                  )}
                </div>
                <div className="text-right">
                  <div className="section-label mb-1">Period</div>
                  <div className="text-ink font-semibold">
                    {dateFrom} → {dateTo}
                  </div>
                  <div className="text-tiny text-ink-3 mt-2">
                    {/* PS-488 M3 — these are aggregated BUSINESS ROWS, not raw line
                        items: a shipment charging pick&pack + package + shipping is one
                        row here and three rows in billing_line_items. Calling the count
                        "line items" understated the real line count and, once returns
                        became their own rows, made an invoice look like it had grown
                        extra fee lines. Returns are called out separately because they
                        are the rows an operator most needs to be able to find. */}
                    {rowCounts.total} billing row{rowCounts.total === 1 ? '' : 's'}
                    {rowCounts.returns > 0
                      ? ` · ${rowCounts.returns} return${rowCounts.returns === 1 ? '' : 's'}`
                      : ''}
                  </div>
                </div>
              </div>

              {/* Summary by type */}
              {summaryRows.length > 0 && (
                <table className="w-full text-sm2 border-collapse mb-4">
                  <thead>
                    <tr className="border-b border-ink">
                      <SortableHeader sortKey="category" sortState={summarySort} onSort={(key) => setSummarySort((current) => nextSortState(current, key))} className="text-left py-1.5 text-tiny font-bold uppercase tracking-wide text-ink-3">
                        Category
                      </SortableHeader>
                      <SortableHeader sortKey="amount" sortState={summarySort} onSort={(key) => setSummarySort((current) => nextSortState(current, key))} align="right" className="text-right py-1.5 text-tiny font-bold uppercase tracking-wide text-ink-3">
                        Amount
                      </SortableHeader>
                    </tr>
                  </thead>
                  <tbody>
                    {summaryRows.map((row) => (
                      <tr key={row.type} className="border-b border-line">
                        <td className="py-1.5 capitalize">
                          {row.type}
                        </td>
                        <td className="py-1.5 text-right font-mono">
                          {fmtMoney(row.amount)}
                        </td>
                      </tr>
                    ))}
                    <tr className="border-t-2 border-ink">
                      <td className="py-2 font-bold">Total</td>
                      <td className="py-2 text-right font-mono font-bold text-[16px]">
                        {fmtMoney(totals?.grandTotal ?? 0)}
                      </td>
                    </tr>
                  </tbody>
                </table>
              )}

              {/* Detail */}
              <div className="section-label mt-6 mb-1">Line items</div>
              <table className="invoice-lines-mobile-table w-full text-tiny border-collapse">
                <thead className="border-b border-ink">
                  <tr>
                    <SortableHeader sortKey="date" sortState={lineSort} onSort={(key) => setLineSort((current) => nextSortState(current, key))} className="text-left py-1.5 font-bold uppercase tracking-wide text-ink-3">
                      Date
                    </SortableHeader>
                    <SortableHeader sortKey="order" sortState={lineSort} onSort={(key) => setLineSort((current) => nextSortState(current, key))} className="text-left py-1.5 font-bold uppercase tracking-wide text-ink-3">
                      Order
                    </SortableHeader>
                    <SortableHeader sortKey="type" sortState={lineSort} onSort={(key) => setLineSort((current) => nextSortState(current, key))} className="text-left py-1.5 font-bold uppercase tracking-wide text-ink-3">
                      Type
                    </SortableHeader>
                    <SortableHeader sortKey="description" sortState={lineSort} onSort={(key) => setLineSort((current) => nextSortState(current, key))} className="text-left py-1.5 font-bold uppercase tracking-wide text-ink-3">
                      Description
                    </SortableHeader>
                    <SortableHeader sortKey="qty" sortState={lineSort} onSort={(key) => setLineSort((current) => nextSortState(current, key))} align="right" className="text-right py-1.5 font-bold uppercase tracking-wide text-ink-3">
                      Qty
                    </SortableHeader>
                    <SortableHeader sortKey="unit" sortState={lineSort} onSort={(key) => setLineSort((current) => nextSortState(current, key))} align="right" className="text-right py-1.5 font-bold uppercase tracking-wide text-ink-3">
                      Unit
                    </SortableHeader>
                    <SortableHeader sortKey="total" sortState={lineSort} onSort={(key) => setLineSort((current) => nextSortState(current, key))} align="right" className="text-right py-1.5 font-bold uppercase tracking-wide text-ink-3">
                      Total
                    </SortableHeader>
                  </tr>
                </thead>
                <tbody>
                  {lines.length === 0 && (
                    <tr>
                      <td colSpan={7} className="text-center py-6 text-ink-3">
                        No line items in this period. Generate them in the
                        Billing page first.
                      </td>
                    </tr>
                  )}
                  {sortedLines.map((l) => (
                    <tr key={invoiceRowKey(l)} className="border-b border-line">
                      <td className="py-1 text-ink-2 whitespace-nowrap">
                        {l.rolledFromWeekend ? (
                          <span className="flex flex-col leading-tight">
                            <span>Billed {formatBillingShipDate(l.billingEffectiveDate)}</span>
                            <span className="text-ink-3">Fulfilled {formatBillingShipDate(l.actualActivityDate ?? l.shipDate)}</span>
                          </span>
                        ) : formatBillingShipDate(l.billingEffectiveDate ?? l.shipDate)}
                      </td>
                      <td className="py-1 font-mono text-brand">
                        {/* PS-488 M3 — the backend's persisted reference. orderId was
                            never a customer-facing number and is now the last resort. */}
                        {l.displayReference ? `#${l.displayReference}` : (l.orderNumber ?? l.orderId ?? '—')}
                      </td>
                      <td className="py-1 text-ink-2 capitalize">
                        {/* PS-488 M3 — rowType ('Outbound' / 'Return') is the real kind of
                            this row. lineType is stamped to the constant 'billing_order'
                            by the aggregator, so this column previously read
                            "billing order" on every line of every invoice. */}
                        {l.rowType ?? l.lineType.replace(/_/g, ' ')}
                      </td>
                      {/* PS-488 M3 — a Return aggregate clears description/qty/unitCost,
                          because each belonged to ONE component line and none of them
                          describes the row: "Return postage" is the wrong description for
                          a row that is postage AND processing, and a 7.73 unit cost
                          against a 10.73 total reads as a quantity error. The backend
                          declines to invent a synthetic answer, so these render as an
                          em-dash. The money is unaffected — it is in Amount, and the
                          breakdown is in the Return Postage / Return Processing columns. */}
                      <td className="py-1 text-ink truncate max-w-[300px]">
                        {l.description ?? '—'}
                      </td>
                      <td className="py-1 text-right font-mono">{l.qty ?? '—'}</td>
                      <td className="py-1 text-right font-mono">
                        {l.unitCost == null ? '—' : fmtMoney(l.unitCost)}
                      </td>
                      <td className="py-1 text-right font-mono font-semibold">
                        {fmtMoney(invoiceRowTotal(l))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
