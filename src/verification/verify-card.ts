// PS-245 (Card 0): resolve the verification guards for a card id, so "verify card X did not break
// money/quantity/label/inventory behavior" is a single, deterministic lookup. Source of truth: the
// package.json test:* scripts — test:ps-<n> and test:ps-<n>-* belong to PS-<n>. No golden capture here
// (that is the operational baseline step); this is the offline resolver the gate harness drives.
import { readFileSync } from 'node:fs';

/** Normalize 'PS-249' / 'ps249' / '249' -> '249' (digits only), or '' if not a PS card id. */
export function normalizeCardNumber(cardId: string): string {
  const n = String(cardId ?? '').trim().replace(/^ps[-\s]?/i, '').trim();
  return /^\d+$/.test(n) ? n : '';
}

/** The package.json `test:*` script names that verify the given card (sorted, deduped). */
export function resolveCardGuards(cardId: string, packageJsonText?: string): string[] {
  const n = normalizeCardNumber(cardId);
  if (!n) return [];
  const pkg = JSON.parse(packageJsonText ?? readFileSync('package.json', 'utf8')) as {
    scripts?: Record<string, string>;
  };
  const scripts = pkg.scripts ?? {};
  const exact = `test:ps-${n}`;
  const prefix = `test:ps-${n}-`;
  return Object.keys(scripts)
    .filter((k) => k === exact || k.startsWith(prefix))
    .sort();
}
