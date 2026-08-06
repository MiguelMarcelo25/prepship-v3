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
    const key = orderKey(row.orderId);
    const canonical = key ? canonicalByOrder.get(key) : undefined;
    return {
      ...row,
      rowType: 'Outbound',
      destination: (canonical?.destination as string | undefined) ?? undefined,
      displayReference: (canonical?.displayReference as string | null | undefined) ?? null,
      // Return money is NEVER carried on an outbound row. Explicit zeros rather than
      // undefined, so a future reader cannot mistake "absent" for "not yet computed".
      returnPostage: 0,
      returnProcessing: 0,
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
