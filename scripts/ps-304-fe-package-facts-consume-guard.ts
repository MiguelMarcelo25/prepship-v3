/**
 * PS-304 (FE) guard — the order detail panel CONSUMES the backend package-facts verdict.
 *
 * The PS-304 audit's #1 gap was "packageFacts has 0 web/src consumers". This guard pins
 * the first consumer: OrdersPanelPackageFactsLine reads order.packageFacts (immutableReason
 * / staleRateImpact / requiresRerate) as a pure display, and OrdersView renders it in the
 * panel wired to panelOrder.packageFacts. Fails if the consumption is removed or if the FE
 * recomputes the verdict instead of reading the backend field (PS-305 boundary).
 *
 * Offline/static only: no DB, no network, no providers, no labels, no shipped/cancelled mutation.
 */
import { readFileSync } from 'node:fs';

let failures = 0;
function check(name: string, condition: boolean, detail?: unknown): void {
  if (!condition) {
    failures += 1;
    console.error(`FAIL ${name}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`);
    return;
  }
  console.log(`ok   ${name}`);
}
function read(path: string): string {
  try { return readFileSync(path, 'utf8'); } catch { return ''; }
}

const panelFields = read('web/src/components/Views/OrdersPanelShippingFields.tsx');
const ordersView = read('web/src/components/Views/OrdersView.tsx');

check('panel exposes OrdersPanelPackageFactsLine (pure display of the backend verdict)',
  /export function OrdersPanelPackageFactsLine/.test(panelFields));
check('panel line READS the backend package-facts fields',
  /packageFacts\.immutableReason/.test(panelFields) &&
  /packageFacts\.staleRateImpact/.test(panelFields) &&
  /packageFacts\.requiresRerate/.test(panelFields));
check('panel line does NOT recompute the verdict (no dims math / insured-value heuristics)',
  !/insuredValue/.test(panelFields) &&
  !/length\s*\*\s*width/.test(panelFields));

check('OrdersView imports the package-facts consumer',
  /OrdersPanelPackageFactsLine/.test(ordersView));
check('OrdersView renders it wired to the selected order packageFacts (the consumption)',
  /<OrdersPanelPackageFactsLine\s+packageFacts=\{panelOrder\?\.packageFacts/.test(ordersView));

if (failures > 0) {
  console.error(`\nPS-304 FE package-facts consume guard FAILED with ${failures} failure(s).`);
  process.exit(1);
}
console.log('\nPS-304 FE package-facts consume guard passed.');
