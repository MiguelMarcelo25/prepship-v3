// PS-488 AC-6 — the invoice reconciliation projection (Handoff v1.1).
//
// The invoice and the Billing table used to be two independent derivations of the same
// money that merely agreed. This makes the canonical DTO the single owner of return
// identity, return money, and the Type/Destination classification, WITHOUT redefining the
// invoice's outbound grain.
//
// Why not a straight DTO swap (the v1 instruction, which was unsafe):
// `toBillingDetailOrderRows` keys outbound rows `order:<orderId>`, but the invoice keeps
// one row per frozen SHIPMENT. Orders 501 and 502 are two shipments of one order, so a
// direct replacement collapses two invoice rows into one — losing a frozen row before any
// return is even involved. Two grains coexist here on purpose: shipment for outbound,
// return-event for returns.
//
// Pure: no I/O, no DB, no provider calls. Both inputs are derived from ONE read of
// billing_line_items; this module never fetches anything.

import type { BillingDetailRowDto } from '../services/billing-detail-row-sot';

/** The shape the invoice already produces per frozen shipment. Structural on purpose. */
export type InvoiceOutboundRow = {
  orderId?: number | string | null;
  [key: string]: unknown;
};

export type ReconciledInvoiceRow = InvoiceOutboundRow & {
  /** 'Outbound' | 'Return' — stamped from the canonical DTO, never derived here. */
  rowType?: string;
  destination?: string;
  displayReference?: string | null;
  returnPostage?: number;
  returnProcessing?: number;
};

function orderKey(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  return String(value);
}

/**
 * PS-488 M3 — the order id of an invoice row, under EITHER spelling.
 *
 * This module was written against `orderId`, but billingInvoiceData produces snake_case
 * `order_id` rows straight out of SQL. Wired as originally written, every lookup missed:
 * the reconciler would have run, matched nothing, and stamped `destination: undefined`
 * and `displayReference: null` onto every outbound row on the invoice — silently, since
 * a miss is indistinguishable from an order with no canonical counterpart.
 *
 * snake_case is checked FIRST because that is the shape the production caller passes.
 */
function outboundOrderKey(row: InvoiceOutboundRow): string | null {
  return orderKey(row.order_id ?? row.orderId);
}

function num(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Reconcile the frozen outbound shipment rows with the canonical DTO.
 *
 * Outbound rows are returned FIRST, in their original order, untouched except for three
 * stamped display fields. Return rows are APPENDED after all of them.
 */
export function reconcileInvoiceRows(input: {
  outbound: InvoiceOutboundRow[];
  canonical: BillingDetailRowDto[];
}): ReconciledInvoiceRow[] {
  // Index canonical OUTBOUND rows by order. Many invoice shipment rows map to one
  // canonical order row; that is safe only because the stamp carries no money —
  // Type/Destination/reference are order-level facts identical across shipments.
  const canonicalByOrder = new Map<string, BillingDetailRowDto>();
  const returns: BillingDetailRowDto[] = [];

  for (const row of input.canonical) {
    if (row.rowType === 'Return') {
      returns.push(row);
      continue;
    }
    const key = orderKey(row.orderId);
    if (key && !canonicalByOrder.has(key)) canonicalByOrder.set(key, row);
  }

  const stamped: ReconciledInvoiceRow[] = input.outbound.map((row) => {
    const key = outboundOrderKey(row);
    const canonical = key ? canonicalByOrder.get(key) : undefined;
    return {
      ...row,
      rowType: 'Outbound',
      // PS-488 M3 — fall back to the row's OWN value when the canonical lookup misses.
      // Written as `canonical?.destination ?? undefined`, a miss actively erased a
      // destination the invoice had already classified correctly, turning a lookup gap
      // into a blank cell on a shipped invoice. The canonical row still wins when present;
      // it just may no longer destroy on absence.
      destination: (canonical?.destination as string | undefined) ?? (row.destination as string | undefined),
      displayReference:
        (canonical?.displayReference as string | null | undefined)
        ?? (row.display_reference as string | null | undefined)
        ?? null,
      // Return money is NEVER carried on an outbound row. Explicit zeros rather than
      // undefined, so a future reader cannot mistake "absent" for "not yet computed".
      returnPostage: 0,
      returnProcessing: 0,
      // PS-488 M3 — but an outbound row has no return FEE at all, which is a different
      // statement from "its return fee is zero". Marking presence false is what makes the
      // serializers leave those two cells blank on outbound rows instead of printing 0.00
      // in a return column on every shipment line of every invoice.
      has_return_postage_line: false,
      has_return_processing_line: false,
      return_postage_amt: null,
      return_processing_amt: null,
    };
  });

  // Deterministic append order. returnId is unique, so the sort is total — no ties, and
  // the same input always produces the same invoice.
  const appended = [...returns]
    .sort((a, b) => {
      const dateA = String(a.billingEffectiveDate ?? '');
      const dateB = String(b.billingEffectiveDate ?? '');
      if (dateA !== dateB) return dateB.localeCompare(dateA);
      const orderA = num(a.orderId);
      const orderB = num(b.orderId);
      if (orderA !== orderB) return orderB - orderA;
      return num(a.returnId) - num(b.returnId);
    })
    .map((row) => ({
      orderId: row.orderId as number | string | null,
      orderNumber: row.orderNumber,
      rowType: 'Return',
      // ── PS-488 M3: the InvoiceDetailRow shape the three exports actually render ──
      //
      // The camelCase fields below were the module's original output. Every invoice
      // renderer (HTML, XLSX, CSV) addresses rows by snake_case column name, so an
      // appended row rendered as a blank line across every column — present in the row
      // count, invisible in the money. Both spellings are emitted: the snake_case set is
      // what ships, the camelCase set is what this module's behavioural guard asserts on,
      // and they are written from the SAME canonical values so they cannot drift.
      order_id: row.orderId as number | null,
      order_number: row.orderNumber as string | null,
      // A return has no shipment. The exports render this as "External".
      shipment_id: null,
      return_id: (row.returnId ?? null) as number | null,
      ship_date: (row.shipDate ?? null) as string | null,
      billing_effective_date: (row.billingEffectiveDate ?? null) as string | null,
      billing_policy_version: null,
      billing_adjustment_id: null,
      source_finalization_id: null,
      adjustment_description: null,
      base_qty: '0',
      addl_qty: '0',
      // Outbound money buckets stay at zero so no return charge can be read as an
      // outbound one, and so the outbound column totals across the invoice are unchanged
      // by the presence of returns.
      pickpack_amt: '0',
      additional_amt: '0',
      shipping_amt: '0',
      storage_amt: '0',
      package_cost_amt: '0',
      // PS-488 M3 — absent stays absent. A fee the return was never charged is null, not
      // '0': a processing-only return must not export postage as 0.00, which reads as a
      // waived charge on a document the client is billed from. A genuine zero keeps its
      // '0' because its presence flag is true.
      return_postage_amt: row.hasReturnPostageLine === true ? String(num(row.returnPostageTotal)) : null,
      return_processing_amt: row.hasReturnProcessingLine === true ? String(num(row.returnProcessingTotal)) : null,
      has_return_postage_line: row.hasReturnPostageLine === true,
      has_return_processing_line: row.hasReturnProcessingLine === true,
      row_total: String(num(row.grandTotal)),
      item_names: null,
      skus: null,
      carrier_code: null,
      box_label: '—',
      box_review: false,
      fee_waived: false,
      // AC-1: the STORED reference, passed through. PrepShip never mints a -RETURN
      // suffix — the portal owns the numbering, and a second generator here would render
      // #1234-RETURN for a return already stored as #1234-RETURN-2.
      order_number_label:
        (row.displayReference as string | null | undefined)
        ?? String(row.orderNumber ?? row.orderId ?? ''),
      // AC-3: a return INHERITS the original outbound order's classification. The return
      // physically ships to the US warehouse, so classifying it from its own destination
      // would read an international order's return as Domestic. The order is the fact;
      // the parcel's direction is not. Falls back to the return's own value only when the
      // outbound order is absent, so an unknown stays Needs Review rather than guessing.
      destination:
        (canonicalByOrder.get(orderKey(row.orderId) ?? '')?.destination as string | undefined)
        ?? (row.destination as string | undefined),
      displayReference: (row.displayReference as string | null | undefined) ?? null,
      returnPostage: num(row.returnPostageTotal),
      returnProcessing: num(row.returnProcessingTotal),
      // The return's own money, from the canonical owner. Outbound buckets stay empty so
      // no return charge can be read as an outbound one.
      shippingTotal: 0,
      grandTotal: num(row.grandTotal),
      billingEffectiveDate: row.billingEffectiveDate,
      shipDate: row.shipDate,
    })) as ReconciledInvoiceRow[];

  return [...stamped, ...appended];
}
