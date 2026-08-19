/**
 * Durable identity for the ShipStation V2 credential that owns a replacement purchase.
 *
 * ShipStation shipment polling uses V1 key/secret pairs, while replacement postage is bought
 * with a V2 key. A client can configure either one without the other, so `client_id` alone is
 * not proof that a V1 page came from the V2 account that bought the label. The purchase intent
 * freezes both the selected V2 scope and a one-way fingerprint; sync accepts a provider row
 * only when the polling account is configured with that exact V2 authority as well.
 */
import { createHash } from 'node:crypto';
import type { ClientCredentials } from '../lib/shipstation/credentials';

export type ReplacementProviderCredentialScope = 'main' | `client:${number}`;

export type ReplacementProviderCredentialAuthority = {
  version: 'shipstation_v2_sha256_v1';
  scope: ReplacementProviderCredentialScope;
  keyFingerprint: string;
};

function normalizedCredential(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function clientScope(clientId: unknown): ReplacementProviderCredentialScope | null {
  return Number.isSafeInteger(clientId) && Number(clientId) > 0
    ? `client:${Number(clientId)}`
    : null;
}

export function fingerprintShipStationV2Credential(apiKeyV2: string): string {
  const credential = normalizedCredential(apiKeyV2);
  if (!credential) throw new Error('ShipStation V2 credential is missing');
  return createHash('sha256').update(credential).digest('hex');
}

export function replacementProviderCredentialAuthority(
  scope: ReplacementProviderCredentialScope,
  apiKeyV2: string,
): ReplacementProviderCredentialAuthority {
  return {
    version: 'shipstation_v2_sha256_v1',
    scope,
    keyFingerprint: fingerprintShipStationV2Credential(apiKeyV2),
  };
}

export function selectReplacementProviderCredentialAuthority(input: {
  requestedClientId: number | null;
  credentials: ClientCredentials;
  mainApiKeyV2: string | null | undefined;
}): { apiKeyV2: string; authority: ReplacementProviderCredentialAuthority } | null {
  const clientCredential = normalizedCredential(input.credentials.apiKeyV2);
  if (clientCredential) {
    const scope = clientScope(input.credentials.sourceClientId);
    if (!scope) return null;
    return {
      apiKeyV2: clientCredential,
      authority: replacementProviderCredentialAuthority(scope, clientCredential),
    };
  }

  const mainCredential = normalizedCredential(input.mainApiKeyV2);
  if (!mainCredential) return null;
  return {
    apiKeyV2: mainCredential,
    authority: replacementProviderCredentialAuthority('main', mainCredential),
  };
}

export function isReplacementProviderCredentialAuthority(
  value: unknown,
): value is ReplacementProviderCredentialAuthority {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const authority = value as Record<string, unknown>;
  if (
    authority.version !== 'shipstation_v2_sha256_v1'
    || typeof authority.scope !== 'string'
    || !/^[a-f0-9]{64}$/.test(String(authority.keyFingerprint ?? ''))
  ) return false;
  return authority.scope === 'main'
    || /^client:[1-9]\d*$/.test(authority.scope);
}

export function sameReplacementProviderCredentialAuthority(
  left: ReplacementProviderCredentialAuthority,
  right: ReplacementProviderCredentialAuthority,
): boolean {
  return left.version === right.version
    && left.scope === right.scope
    && left.keyFingerprint === right.keyFingerprint;
}
