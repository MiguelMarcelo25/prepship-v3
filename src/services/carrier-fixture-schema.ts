// Carrier harness — fixture envelope schema + load/save (Slice 3).
// Plan: ~/.claude/plans/zany-spinning-hennessy.md
//
// A fixture is a recording of the REAL carrier HTTP responses for one
// provider × serviceCode label flow, captured through timedFetch. Replaying it
// drives the connector's own request-build + response-parse code against genuine
// bytes — so the parser is exercised, not bypassed. We deliberately do NOT
// validate provider-specific body shapes here (the body is whatever the carrier
// actually returned); we validate the ENVELOPE + provenance so a malformed or
// fabricated fixture can't masquerade as a real capture.
//
// Imported dynamically by the harness only — never on a production code path.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import type { CarrierReplayStep } from '../lib/http/timing.js';

export interface CarrierFixture {
  provider: string;
  serviceCode: string;
  /** true once recorded from real carrier traffic; scaffolds are false. */
  captured: boolean;
  capturedAt?: string;
  /** masked account label for provenance; never a secret. */
  account?: string;
  steps: CarrierReplayStep[];
}

export const CARRIER_FIXTURE_ROOT = 'test-fixtures/carriers';

export function fixturePath(provider: string, serviceCode: string): string {
  const p = String(provider).toLowerCase().replace(/[\s-]+/g, '_');
  const s = String(serviceCode).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'svc';
  return `${CARRIER_FIXTURE_ROOT}/${p}/labels/${s}.json`;
}

export function validateCarrierFixture(obj: unknown): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  const f = obj as Record<string, any>;
  if (!f || typeof f !== 'object') return { ok: false, errors: ['fixture is not an object'] };
  if (typeof f.provider !== 'string' || !f.provider.trim()) errors.push('provider must be a non-empty string');
  if (typeof f.serviceCode !== 'string' || !f.serviceCode.trim()) errors.push('serviceCode must be a non-empty string');
  if (typeof f.captured !== 'boolean') errors.push('captured must be a boolean');
  if (!Array.isArray(f.steps) || f.steps.length === 0) {
    errors.push('steps must be a non-empty array');
  } else {
    f.steps.forEach((s: any, i: number) => {
      if (!s || typeof s !== 'object') { errors.push(`steps[${i}] must be an object`); return; }
      if (typeof s.name !== 'string' || !s.name.trim()) errors.push(`steps[${i}].name must be a non-empty string (the timedFetch name)`);
      if (s.status != null && (typeof s.status !== 'number' || s.status < 100 || s.status > 599)) errors.push(`steps[${i}].status must be a valid HTTP status`);
      if (!('body' in s)) errors.push(`steps[${i}].body is required (may be {} )`);
    });
  }
  return { ok: errors.length === 0, errors };
}

export function loadCarrierFixture(provider: string, serviceCode: string): CarrierFixture | null {
  const path = fixturePath(provider, serviceCode);
  if (!existsSync(path)) return null;
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  const { ok, errors } = validateCarrierFixture(parsed);
  if (!ok) throw new Error(`invalid carrier fixture ${path}: ${errors.join('; ')}`);
  return parsed as CarrierFixture;
}

export function saveCarrierFixture(fixture: CarrierFixture): string {
  const { ok, errors } = validateCarrierFixture(fixture);
  if (!ok) throw new Error(`refusing to save invalid fixture: ${errors.join('; ')}`);
  const path = fixturePath(fixture.provider, fixture.serviceCode);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(fixture, null, 2));
  return path;
}
