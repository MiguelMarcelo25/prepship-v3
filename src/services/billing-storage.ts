// PS-373 — canonical prorated cubic-foot-day storage billing calculator.
//
// v2/older v4 billed storage from the CURRENT end-of-period inventory snapshot
// (a current-balance snapshot × cuFtPerUnit × monthlyRate). That over/under-bills: a unit
// received mid-month or shipped mid-month is billed as if held the whole month,
// and retroactive receive dates were ignored.
//
// This owner rebuilds each SKU's on-hand timeline from the canonical inventory
// LEDGER (src/db/schema/inventory.ts inventory_ledger — the same signed-delta
// source the canonical inventory quantity is built on) and integrates
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

export type CalendarStoragePeriod = {
  monthKey: string;
  periodStart: Date;
  periodEnd: Date;
  lineDate: Date;
};

export type StorageLedgerMovement = {
  /** receive | adjust | pick | ship | return | damage */
  type: string;
  /** signed delta (receive/return +, ship/pick/damage −, adjust ±) — same sign convention as applyMovement. */
  qty: number | string | null | undefined;
  /** optional source order identity; insertion owns exactly-once enforcement. */
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

/**
 * Expand any requested billing range into the full UTC calendar month(s) it
 * intersects. Storage is a monthly fact: weekly/custom refreshes may refresh
 * that fact, but they must never mint a second storage identity for the month.
 */
export function calendarStoragePeriodsForRange(
  periodStart: Date | string | number,
  periodEnd: Date | string | number,
): CalendarStoragePeriod[] {
  const requestedStartMs = utcDayStartMs(periodStart);
  const requestedEndMs = utcDayStartMs(periodEnd);
  if (requestedEndMs <= requestedStartMs) return [];

  const first = new Date(requestedStartMs);
  let cursorMs = Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), 1);
  const periods: CalendarStoragePeriod[] = [];
  while (cursorMs < requestedEndMs) {
    const cursor = new Date(cursorMs);
    const nextMs = Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1);
    periods.push({
      monthKey: isoDay(cursorMs).slice(0, 7),
      periodStart: new Date(cursorMs),
      periodEnd: new Date(nextMs),
      lineDate: new Date(nextMs - DAY_MS),
    });
    cursorMs = nextMs;
  }
  return periods;
}

// Storage consumes the same persisted movement sequence as Inventory. Duplicate
// prevention belongs to the ledger insert constraint, never a billing-only fallback.
export function normalizeStorageMovements(
  movements: StorageLedgerMovement[],
): Array<{ dayMs: number; qty: number }> {
  return movements.map((movement) => ({
    dayMs: utcDayStartMs(movement.effectiveAt),
    qty: toNum(movement.qty),
  }));
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

  const effective = normalizeStorageMovements(input.movements);

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
