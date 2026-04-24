import { eq } from 'drizzle-orm';
import { db } from '../../db/client';
import { clients } from '../../db/schema/clients';

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

// v2-parity: resolve per-client ShipStation credentials with the
// rate_source_client_id fallback. Mirrors apps/api/src/modules/labels/data/
// sqlite-label-repository.ts:81-120 in v2original.
//
// Resolution order:
//   1. Direct lookup on clientId → ssApiKeyV2 / ssApiKey / ssApiSecret
//   2. If clientId has null ssApiKeyV2 AND rateSourceClientId is set,
//      recurse once to the target client to pick up ITS apiKeyV2 (v2 treats
//      the rate-source client as a carrier-account fallback). V1 key+secret
//      stay on the original client — the rate source only fills the V2 key.
//   3. If nothing resolves, return all-null — callers fall through to env
//      defaults via ssRequest/ssV1Request.
//
// Note: `opts.storeId` is accepted for forward-compat with v2's
// `getShippingAccountContext(storeId)` signature, but v4 resolves by clientId.
// If you need storeId→clientId resolution, fetch the client first and pass
// its id here.
export async function loadClientCredentials(
  clientId: number | null | undefined,
  opts: { storeId?: number } = {},
): Promise<ClientCredentials> {
  void opts; // reserved for future storeId-based resolution
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

  let apiKeyV2 = row.apiKeyV2 ?? null;
  let sourceClientId = apiKeyV2 ? clientId : null;

  // v2-parity fallback: if this client has no V2 key of its own AND points
  // at a rate-source client, borrow the source's V2 key.
  if (!apiKeyV2 && row.rateSourceClientId && row.rateSourceClientId !== clientId) {
    try {
      const [src] = await db
        .select({ apiKeyV2: clients.ssApiKeyV2 })
        .from(clients)
        .where(eq(clients.id, row.rateSourceClientId))
        .limit(1);
      if (src?.apiKeyV2) {
        apiKeyV2 = src.apiKeyV2;
        sourceClientId = row.rateSourceClientId;
      }
    } catch (err) {
      // Non-fatal — caller falls through to env default.
      console.warn(
        `[ss-credentials] rate-source lookup failed for clientId=${clientId} → ${row.rateSourceClientId}:`,
        err
      );
    }
  }

  return {
    apiKeyV2,
    apiKey: row.apiKey ?? null,
    apiSecret: row.apiSecret ?? null,
    sourceClientId,
  };
}
