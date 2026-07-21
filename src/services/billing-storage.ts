// PS-373 — canonical prorated cubic-foot-day storage billing calculator.
//
// v2/older v4 billed storage from the CURRENT end-of-period inventory snapshot
// (Σ stock_qty × cuFtPerUnit × monthlyRate). That over/under-bills: a unit
// received mid-month or shipped mid-month is billed as if held the whole month,
// and retroactive receive dates were ignored.
//
// This owner rebuilds each SKU's on-hand timeline from the canonical inventory
// LEDGER (src/db/schema/inventory.ts inventory_ledger — the same signed-delta
// source stock_qty and computeEffectiveStockForIds are built on) and integrates
// cubic-foot-DAYS over the billing month, prorated by the actual number of days
// in that month. billing.ts delegates the storage line to this module; nothing
// here reads or writes shipped/cancelled order/shipment rows.
//
// Canonicals (no duplicates — PS-373 guardrail):
//   - per-unit volume: cuFtPerUnit() (src/lib/inventory-cuft.ts)
//   - monthly rate:    billing_config.storage_fee_per_cu_ft
//   - movement truth:  inventory_ledger (effectiveAt, type, qty[signed], orderId)
//
// PURE: dates/numbers in, a billing decision + frozen proof out. No db, no io —
// the SQL that loads the ledger lives in billing.ts; the guard exercises the
// full timeline matrix offline.

import { roundMoney } from '../lib/money';

const DAY_MS = 24 * 60 * 60 * 1000;

export type StorageLedgerMovement = {
  /** receive | adjust | pick | ship | return | damage */
  type: string;
  /** signed delta (receive/return +, ship/pick/damage −, adjust ±) — same sign convention as applyMovement. */
  qty: number | string | null | undefined;
  /** the order a ship belongs to; used to de-dupe idempotent ship writes (min qty per order). */
  orderId: number | string | null | undefined;
  /** when the movement took effect — a retroactive receive carries its entered date here. */
  effectiveAt: Date | string | number;
};

export type StorageSegment = {
  /** UTC day the segment starts (inclusive), ISO yyyy-mm-dd. */
  fromDay: string;
  /** UTC day the segment ends (exclusive), ISO yyyy-mm-dd. */
  toDay: string;
  /** signed on-hand balance during the segment (may be negative — see exception). */
  balance: number;
  /** balance clamped at 0 for billing. */
  billedQty: number;
  days: number;
  /** billedQty × cuFtPerUnit × days. */
  cuFtDays: number;
};

export type SkuStorageProof = {
  inventoryId: number;
  sku: string;
  cuFtPerUnit: number;
  segments: StorageSegment[];
  cuFtDays: number;
  /** this SKU's share of the storage line (roundMoney(cuFtDays × dailyRate)). */
  amount: number;
  /** true when the on-hand balance went below zero during the period (over-ship / bad adjust). */
  hadNegativeBalance: boolean;
  /** number of days billed at a clamped 0 because the raw balance was negative. */
  negativeDays: number;
};

function toNum(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** Floor a timestamp to the start of its UTC calendar day (ms). */
function utcDayStartMs(value: Date | string | number): number {
  const d = value instanceof Date ? value : new Date(value);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

// De-dupe idempotent ship writes: the ship path can record the same order's ship
// more than once, so — exactly like computeEffectiveStockForIds — collapse ship
// rows that carry an orderId to ONE effective movement per order of min(qty) (the
// most-negative = the real ship), dated at that order's earliest ship day. Ships
// without an orderId and all non-ship movements pass through untouched.
export function dedupeShipMovements(
  movements: StorageLedgerMovement[],
): Array<{ dayMs: number; qty: number }> {
  const shipByOrder = new Map<string, { qty: number; dayMs: number }>();
  const out: Array<{ dayMs: number; qty: number }> = [];

  for (const move of movements) {
    const qty = toNum(move.qty);
    const dayMs = utcDayStartMs(move.effectiveAt);
    const type = String(move.type ?? '').toLowerCase();
    const orderId = move.orderId == null ? '' : String(move.orderId).trim();

    if (type === 'ship' && orderId) {
      const existing = shipByOrder.get(orderId);
      if (!existing) {
        shipByOrder.set(orderId, { qty, dayMs });
      } else {
        shipByOrder.set(orderId, {
          qty: Math.min(existing.qty, qty),
          dayMs: Math.min(existing.dayMs, dayMs),
        });
      }
      continue;
    }
    out.push({ dayMs, qty });
  }

  for (const ship of shipByOrder.values()) out.push({ dayMs: ship.dayMs, qty: ship.qty });
  return out;
}

/**
 * Integrate one SKU's cubic-foot-DAYS across the billing month [periodStart, periodEnd).
 * Starting balance = Σ deltas whose day is BEFORE periodStart (so a unit received
 * in a prior month carries in; storage "starts from the received date"). In-period
 * movements change the balance at the START of their UTC day, producing constant-
 * balance segments; each segment accrues clamped-nonnegative qty × cuFtPerUnit × days.
 */
export function computeSkuStorageCuFtDays(input: {
  inventoryId: number;
  sku: string;
  cuFtPerUnit: number;
  movements: StorageLedgerMovement[];
  periodStart: Date | string | number;
  periodEnd: Date | string | number;
}): Omit<SkuStorageProof, 'amount'> {
  const cuFtPerUnit = toNum(input.cuFtPerUnit);
  const startMs = utcDayStartMs(input.periodStart);
  const endMs = utcDayStartMs(input.periodEnd);
  const base = { inventoryId: input.inventoryId, sku: input.sku, cuFtPerUnit };

  if (cuFtPerUnit <= 0 || endMs <= startMs) {
    return { ...base, segments: [], cuFtDays: 0, hadNegativeBalance: false, negativeDays: 0 };
  }

  const effective = dedupeShipMovements(input.movements);

  // Starting on-hand at the first day of the period.
  let startingBalance = 0;
  const deltaByDay = new Map<number, number>();
  for (const move of effective) {
    if (move.dayMs < startMs) {
      startingBalance += move.qty;
    } else if (move.dayMs < endMs) {
      deltaByDay.set(move.dayMs, (deltaByDay.get(move.dayMs) ?? 0) + move.qty);
    }
    // movements on/after periodEnd belong to the next period.
  }

  const eventDays = [...deltaByDay.keys()].sort((a, b) => a - b);
  const segments: StorageSegment[] = [];
  let cuFtDays = 0;
  let negativeDays = 0;
  let hadNegativeBalance = false;

  let cursor = startMs;
  let balance = startingBalance;
  const pushSegment = (from: number, to: number, bal: number): void => {
    const days = Math.round((to - from) / DAY_MS);
    if (days <= 0) return;
    const billedQty = Math.max(0, bal);
    const segCuFtDays = billedQty * cuFtPerUnit * days;
    cuFtDays += segCuFtDays;
    if (bal < 0) { hadNegativeBalance = true; negativeDays += days; }
    segments.push({
      fromDay: isoDay(from),
      toDay: isoDay(to),
      balance: bal,
      billedQty,
      days,
      cuFtDays: segCuFtDays,
    });
  };

  for (const eventDay of eventDays) {
    pushSegment(cursor, eventDay, balance);
    balance += deltaByDay.get(eventDay) ?? 0;
    cursor = eventDay;
  }
  pushSegment(cursor, endMs, balance);

  return {
    ...base,
    segments,
    cuFtDays: Math.round(cuFtDays * 1e6) / 1e6,
    hadNegativeBalance,
    negativeDays,
  };
}

export type ClientStorageSku = {
  inventoryId: number;
  sku: string;
  cuFtPerUnit: number;
  movements: StorageLedgerMovement[];
};

export type ClientStorageBilling = {
  /** the single storage line amount (Σ per-SKU rounded amounts, so it reconciles to the proof). */
  amount: number;
  totalCuFtDays: number;
  daysInMonth: number;
  monthlyRatePerCuFt: number;
  dailyRatePerCuFt: number;
  skuProofs: SkuStorageProof[];
  /** SKUs whose on-hand went negative during the period — surfaced for admin review, billed at 0. */
  exceptions: Array<{ inventoryId: number; sku: string; negativeDays: number }>;
};

/**
 * The client's single prorated storage line for the month. Bills only when the
 * rate is positive; each eligible SKU contributes roundMoney(cuFtDays × dailyRate),
 * and the line total is the SUM of those rounded shares (exact reconciliation to
 * the frozen proof rows). Returns amount 0 with an empty proof when nothing bills.
 */
export function computeClientStorageBilling(input: {
  skus: ClientStorageSku[];
  storageFeePerCuFtMonth: number;
  periodStart: Date | string | number;
  periodEnd: Date | string | number;
}): ClientStorageBilling {
  const monthlyRate = toNum(input.storageFeePerCuFtMonth);
  const startMs = utcDayStartMs(input.periodStart);
  const endMs = utcDayStartMs(input.periodEnd);
  const daysInMonth = Math.max(0, Math.round((endMs - startMs) / DAY_MS));
  const dailyRate = daysInMonth > 0 ? monthlyRate / daysInMonth : 0;

  const empty: ClientStorageBilling = {
    amount: 0, totalCuFtDays: 0, daysInMonth, monthlyRatePerCuFt: monthlyRate,
    dailyRatePerCuFt: dailyRate, skuProofs: [], exceptions: [],
  };
  if (monthlyRate <= 0 || daysInMonth <= 0) return empty;

  const skuProofs: SkuStorageProof[] = [];
  const exceptions: ClientStorageBilling['exceptions'] = [];
  let totalCuFtDays = 0;
  let amount = 0;

  for (const sku of input.skus) {
    // Eligibility: positive per-unit volume only (active-ness is filtered by the caller's query).
    if (toNum(sku.cuFtPerUnit) <= 0) continue;
    const timeline = computeSkuStorageCuFtDays({
      inventoryId: sku.inventoryId,
      sku: sku.sku,
      cuFtPerUnit: sku.cuFtPerUnit,
      movements: sku.movements,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
    });
    if (timeline.cuFtDays <= 0 && !timeline.hadNegativeBalance) continue;

    const skuAmount = roundMoney(timeline.cuFtDays * dailyRate);
    totalCuFtDays += timeline.cuFtDays;
    amount += skuAmount;
    skuProofs.push({ ...timeline, amount: skuAmount });
    if (timeline.hadNegativeBalance) {
      exceptions.push({ inventoryId: sku.inventoryId, sku: sku.sku, negativeDays: timeline.negativeDays });
    }
  }

  return {
    amount: roundMoney(amount),
    totalCuFtDays: Math.round(totalCuFtDays * 1e6) / 1e6,
    daysInMonth,
    monthlyRatePerCuFt: monthlyRate,
    dailyRatePerCuFt: dailyRate,
    skuProofs,
    exceptions,
  };
}
