import type { Client } from '../db/schema/clients';

export type PublicClient = Omit<Client, 'ssApiKey' | 'ssApiSecret' | 'ssApiKeyV2'> & {
  hasShipStationV1Credentials: boolean;
  hasShipStationV2Credentials: boolean;
};

export function publicClient(row: Client): PublicClient {
  const { ssApiKey, ssApiSecret, ssApiKeyV2, ...safe } = row;
  return {
    ...safe,
    hasShipStationV1Credentials: Boolean(ssApiKey && ssApiSecret),
    hasShipStationV2Credentials: Boolean(ssApiKeyV2),
  };
}
