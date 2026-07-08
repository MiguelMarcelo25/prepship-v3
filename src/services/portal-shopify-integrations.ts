import { sql } from '../db/client.js';
import {
  normalizeShopifyShopDomain,
  validateShopifyCredentials,
} from '../connectors/store/shopify.js';

export type PortalShopifyIntegrationInput = {
  clientId: number;
  shopDomain: string;
  adminAccessToken: string;
  label?: string | null;
};

export type PortalShopifyIntegration = {
  id: number;
  clientId: number;
  provider: 'shopify';
  label: string | null;
  accountIdentifier: string;
  source: 'portal';
  active: false;
  createdAt: Date | string | null;
};

type PortalShopifyIntegrationRow = {
  id: number;
  clientId: number;
  provider: 'shopify';
  label: string | null;
  accountIdentifier: string;
  source: 'portal';
  active: false;
  createdAt: Date | string | null;
};

export class PortalShopifyIntegrationError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = 'PortalShopifyIntegrationError';
    this.status = status;
  }
}

function cleanLabel(value: string | null | undefined, fallback: string): string {
  const trimmed = value?.trim().slice(0, 200);
  return trimmed || fallback;
}

function cleanToken(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new PortalShopifyIntegrationError(
      "Couldn't connect - check your shop domain and Admin API token.",
    );
  }
  return trimmed;
}

export async function submitPortalShopifyIntegration(
  input: PortalShopifyIntegrationInput,
): Promise<PortalShopifyIntegration> {
  if (!Number.isInteger(input.clientId) || input.clientId <= 0) {
    throw new PortalShopifyIntegrationError('Client scope required', 403);
  }

  const credentials = {
    shopDomain: normalizeShopifyShopDomain(input.shopDomain),
    adminAccessToken: cleanToken(input.adminAccessToken),
  };
  const validation = await validateShopifyCredentials(credentials);
  if (!validation.ok) {
    throw new PortalShopifyIntegrationError(validation.error);
  }

  const account = {
    clientId: input.clientId,
    provider: 'shopify' as const,
    label: cleanLabel(input.label, validation.shopName),
    accountIdentifier: validation.myshopifyDomain,
    credentials,
    source: 'portal' as const,
    active: false as const,
  };

  const rows = (await sql`
    INSERT INTO store_accounts (
      client_id,
      provider,
      label,
      account_identifier,
      credentials,
      source,
      active
    )
    VALUES (
      ${account.clientId},
      ${account.provider},
      ${account.label},
      ${account.accountIdentifier},
      ${JSON.stringify(account.credentials)}::jsonb,
      ${account.source},
      ${account.active}
    )
    ON CONFLICT (COALESCE(client_id, -1), provider, COALESCE(account_identifier, ''))
    DO NOTHING
    RETURNING
      id,
      client_id AS "clientId",
      provider,
      label,
      account_identifier AS "accountIdentifier",
      source,
      active,
      created_at AS "createdAt"
  `) as unknown as PortalShopifyIntegrationRow[];

  const row = rows[0];
  if (!row) {
    throw new PortalShopifyIntegrationError(
      'This Shopify store is already pending or connected.',
      409,
    );
  }

  return {
    id: Number(row.id),
    clientId: Number(row.clientId),
    provider: 'shopify',
    label: row.label,
    accountIdentifier: row.accountIdentifier,
    source: 'portal',
    active: false,
    createdAt: row.createdAt ?? null,
  };
}
