import { eq } from 'drizzle-orm';
import { db } from '../db/client';
import { clients } from '../db/schema/clients';

export type ClientRateSourcePolicyResult =
  | { ok: true }
  | { ok: false; code: 'RATE_SOURCE_SELF_REFERENCE' | 'RATE_SOURCE_UNAVAILABLE'; error: string };

export function evaluateClientRateSourcePolicy(input: {
  clientId: number | null;
  rateSourceClientId: number | null;
  source: { id: number; active: boolean; ssApiKeyV2: string | null } | null;
}): ClientRateSourcePolicyResult {
  if (input.rateSourceClientId == null) return { ok: true };
  if (input.clientId != null && input.clientId === input.rateSourceClientId) {
    return {
      ok: false,
      code: 'RATE_SOURCE_SELF_REFERENCE',
      error: 'A client cannot use itself as its rate-source client.',
    };
  }
  if (
    !input.source ||
    input.source.id !== input.rateSourceClientId ||
    input.source.active !== true ||
    !input.source.ssApiKeyV2?.trim()
  ) {
    return {
      ok: false,
      code: 'RATE_SOURCE_UNAVAILABLE',
      error: 'Rate-source client must exist, be active, and have its own ShipStation v2 account.',
    };
  }
  return { ok: true };
}

/** Canonical write-boundary validation for clients.rate_source_client_id. */
export async function validateClientRateSourceWrite(input: {
  clientId: number | null;
  rateSourceClientId: number | null;
}): Promise<ClientRateSourcePolicyResult> {
  const source = input.rateSourceClientId == null
    ? null
    : (await db
        .select({
          id: clients.id,
          active: clients.active,
          ssApiKeyV2: clients.ssApiKeyV2,
        })
        .from(clients)
        .where(eq(clients.id, input.rateSourceClientId))
        .limit(1))[0] ?? null;
  return evaluateClientRateSourcePolicy({ ...input, source });
}
