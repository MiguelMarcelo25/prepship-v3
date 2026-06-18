// PS-288 (continuation) — pure resolver for the SECOND ShipStation account key used by the
// label-recovery fallback. When the PRIMARY account's recent labels don't contain a match for a
// shipment whose local label_url went NULL, the recovery ALSO reads the second account's recent
// labels (the KFG account — env SHIPSTATION_KFG_API_KEY_V2) before giving up. The match itself
// stays the EXISTING exact-match matchRecoverableLabelUrl (tracking, then label_id), so a second
// account can never produce a cross-account false positive. Pure: no IO, no DB, no network — just
// reads the env key and returns it (or null when unset/blank/identical to the primary). Returning
// the same key as the primary would only re-read the same labels, so it is treated as "no second
// account" to avoid a redundant ShipStation call.

export function resolveSecondaryShipstationLabelKey(
  env: { SHIPSTATION_KFG_API_KEY_V2?: string | null; SHIPSTATION_API_KEY_V2?: string | null } = {},
): string | null {
  const secondary = (env.SHIPSTATION_KFG_API_KEY_V2 ?? '').trim();
  if (!secondary) return null;
  const primary = (env.SHIPSTATION_API_KEY_V2 ?? '').trim();
  if (primary && secondary === primary) return null;
  return secondary;
}
