#!/usr/bin/env tsx
/**
 * PS-514 — the FE invoice summary category cards must RECONCILE to grandTotal.
 *
 * The page listed only Pick&pack / Additional / Package / Shipping / Storage (+ Replacement from
 * PS-513) but the Total = grandTotal already summed Adjustment + Return too, so the category rows
 * under-summed the Total whenever a return or a billing_adjustment existed — and returns are LIVE
 * in production today. This guard drives the backend-owned pure category builder and asserts the
 * category union equals grandTotal, plus source-pins the returnTotal owner + the FE delegation.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  buildInvoiceSummaryCategories,
  invoiceSummaryCategoriesSum,
  type InvoiceSummaryTotals,
} from '../web/src/pages/invoice-summary-categories';

let failures = 0;
function check(cond: boolean, msg: string, detail?: string): void {
  if (cond) console.log(`  PASS ${msg}`);
  else {
    console.error(`  FAIL ${msg}${detail ? `\n       ${detail}` : ''}`);
    failures += 1;
  }
}
const near = (a: number, b: number) => Math.abs(a - b) < 0.005;

// 1 — every category present, sums to grandTotal.
{
  const totals: InvoiceSummaryTotals = {
    pickPackTotal: 4, additionalTotal: 1.5, packageTotal: 2, shippingTotal: 5, storageTotal: 0.75,
    adjustmentTotal: -12.5, returnTotal: 10.73, replacePostageTotal: 8.75, replacePickPackTotal: 3,
    grandTotal: 23.23,
  };
  const byType = Object.fromEntries(buildInvoiceSummaryCategories(totals).map((c) => [c.type, c.amount]));
  check(byType['Adjustment'] === -12.5, 'Adjustment category is rendered (was omitted)', `got ${byType['Adjustment']}`);
  check(byType['Return'] === 10.73, 'Return category is rendered (was omitted)', `got ${byType['Return']}`);
  check(byType['Replacement'] === 11.75, 'Replacement category = postage + pick&pack', `got ${byType['Replacement']}`);
  check(near(invoiceSummaryCategoriesSum(totals), totals.grandTotal),
    'RECONCILIATION: the category union equals grandTotal', `${invoiceSummaryCategoriesSum(totals)} vs ${totals.grandTotal}`);
}

// 2 — rare categories hidden when zero (a normal invoice is not cluttered), still reconciles.
{
  const totals: InvoiceSummaryTotals = {
    pickPackTotal: 4, additionalTotal: 0, packageTotal: 2, shippingTotal: 5, storageTotal: 0, grandTotal: 11,
  };
  const types = buildInvoiceSummaryCategories(totals).map((c) => c.type);
  check(!types.includes('Adjustment'), 'no Adjustment card when zero');
  check(!types.includes('Return'), 'no Return card when zero');
  check(!types.includes('Replacement'), 'no Replacement card when zero');
  check(types.length === 5, 'exactly the 5 operating categories on a plain invoice', types.join(','));
  check(near(invoiceSummaryCategoriesSum(totals), totals.grandTotal), 'plain invoice reconciles');
}

// 3 — the live bug this closes: a RETURN-only period must reconcile, not under-sum to $0.
{
  const totals: InvoiceSummaryTotals = {
    pickPackTotal: 0, additionalTotal: 0, packageTotal: 0, shippingTotal: 0, storageTotal: 0,
    returnTotal: 10.73, grandTotal: 10.73,
  };
  const types = buildInvoiceSummaryCategories(totals).map((c) => c.type);
  check(types.includes('Return'), 'return-only period shows a Return card');
  check(near(invoiceSummaryCategoriesSum(totals), 10.73),
    'return-only period reconciles to the Total (was under-summing to 0 across the operating cards)');
}

// 4 — an adjustment-only credit period reconciles (negative amount).
{
  const totals: InvoiceSummaryTotals = {
    pickPackTotal: 0, additionalTotal: 0, packageTotal: 0, shippingTotal: 0, storageTotal: 0,
    adjustmentTotal: -12.5, grandTotal: -12.5,
  };
  check(near(invoiceSummaryCategoriesSum(totals), -12.5), 'adjustment-only credit reconciles (negative)');
}

// 5 — source pins.
{
  const totalsSrc = readFileSync('src/services/billing-invoice-totals.ts', 'utf8');
  check(/as return_total\b/.test(totalsSrc) && /\breturnTotal: number/.test(totalsSrc) && /\breturnTotal,/.test(totalsSrc),
    'billing-invoice-totals.ts owns a returnTotal category (SQL sum + type field + returned)');
  const invoiceSrc = readFileSync('web/src/pages/Invoice.tsx', 'utf8');
  check(invoiceSrc.includes('buildInvoiceSummaryCategories(totals)'),
    'Invoice.tsx delegates the summary categories to the backend-owned pure builder');
}

console.log(`\n${failures === 0 ? 'PASS PS-514 invoice summary reconcile guard' : `FAIL PS-514 — ${failures} check(s) failed`}`);
if (failures > 0) process.exit(1);
