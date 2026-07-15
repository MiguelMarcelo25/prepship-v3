import { eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { clients } from '../../db/schema/clients.js';
import { evaluateClientRateSourcePolicy } from '../../services/client-rate-source-policy.js';

export type ClientCredentials = {
  apiKeyV2: string | null;
  apiKey: string | null;
  apiSecret: string | null;
  sourceClientId: number | null;
};

const EMPTY: ClientCredentials = {
  apiKeyV2: null,
  apiKey: null,
  apiSecret: null,
  sourceClientId: null,
};

/**
 * Resolve per-client ShipStation credentials.
 *
 * Resolution order:
 * 1. Use credentials owned by the requested client.
 * 2. When the client has no v2 key and explicitly names a rate-source client,
 *    validate that link through the canonical policy and borrow its v2 key.
 * 3. With no explicit source, return null credentials so callers may use the
 *    configured application default.
 *
 * An explicit but invalid source fails closed. Silently using the application
 * default would quote, buy, or notify through a different account owner.
 */
export async function loadClientCredentials(
  clientId: number | null | undefined,
  opts: { storeId?: number } = {},
): Promise<ClientCredentials> {
  void opts;
  if (!clientId) return EMPTY;

  const [row] = await db
    .select({
      apiKeyV2: clients.ssApiKeyV2,
      apiKey: clients.ssApiKey,
      apiSecret: clients.ssApiSecret,
      rateSourceClientId: clients.rateSourceClientId,
    })
    .from(clients)
    .where(eq(clients.id, clientId))
    .limit(1);

  if (!row) return EMPTY;

  let apiKeyV2 = row.apiKeyV2?.trim() || null;
  let sourceClientId = apiKeyV2 ? clientId : null;

  if (!apiKeyV2 && row.rateSourceClientId != null) {
    const [source] = await db
      .select({ id: clients.id, active: clients.active, ssApiKeyV2: clients.ssApiKeyV2 })
      .from(clients)
      .where(eq(clients.id, row.rateSourceClientId))
      .limit(1);
    const policy = evaluateClientRateSourcePolicy({
      clientId,
      rateSourceClientId: row.rateSourceClientId,
      source: source ?? null,
    });
    if (!policy.ok) {
      throw new Error(`${policy.code}: ${policy.error}`);
    }
    apiKeyV2 = source!.ssApiKeyV2!.trim();
    sourceClientId = row.rateSourceClientId;
  }

  return {
    apiKeyV2,
    apiKey: row.apiKey ?? null,
    apiSecret: row.apiSecret ?? null,
    sourceClientId,
  };
}
