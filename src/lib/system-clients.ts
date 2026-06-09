// PS-132 (old PS-141): single source of truth for the synthetic/system client names that
// must be excluded from billing config/summary, reporting, and analytics. These are not real
// billable customers (Manual Orders, the Rate Browser scratch client, API-only shipments).
//
// Replace EVERY hardcoded copy with this constant so a new system client (or a rename) is a
// one-line change instead of a hunt across raw SQL in billing/reporting.

export const SYSTEM_CLIENT_NAMES: string[] = ['Manual Orders', 'Rate Browser', 'Api Shipments'];

/** True when a client name is a synthetic/system client (case-sensitive, matches the DB names). */
export function isSystemClientName(name: string | null | undefined): boolean {
  return name != null && SYSTEM_CLIENT_NAMES.includes(name);
}
