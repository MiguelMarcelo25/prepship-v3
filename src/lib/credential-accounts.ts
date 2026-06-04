export type CredentialAccountSource = 'admin' | 'portal';

export const CREDENTIAL_ACCOUNT_SOURCES = ['admin', 'portal'] as const;
export const ALLOWED_ACCOUNT_SOURCES = new Set<string>(CREDENTIAL_ACCOUNT_SOURCES);
export const CREDENTIAL_PROVIDER_PATTERN = /^[a-z][a-z0-9_]{1,30}$/;

export type CredentialAccountBody = {
  provider: string;
  label: string | null;
  accountIdentifier: string | null;
  credentials: Record<string, unknown>;
  source: CredentialAccountSource;
  clientId: number | null;
  credentialKeys: string[];
  bodyKeys: string[];
  bodyType: string;
};

export type CredentialAccountPatchBody = {
  hasSource: boolean;
  hasLabel: boolean;
  source: CredentialAccountSource | null;
  label: string | null;
  labelGoesNull: boolean;
  // Credential re-entry ("Reconnect"): merge these keys into the stored
  // credentials JSONB. Only non-empty values are kept so a blank field never
  // wipes an existing secret (e.g. change the password, keep the apiKey/email).
  hasCredentials: boolean;
  credentials: Record<string, unknown> | null;
  credentialKeys: string[];
  // Active toggle: hide/show a carrier in the Rate Browser. active=false is
  // filtered out client-side (fetchDirectCarrierAccountRows) so the carrier
  // stops appearing for any order without deleting it.
  hasActive: boolean;
  active: boolean | null;
};

export async function readJsonRequestBody(req: any): Promise<Record<string, unknown>> {
  if (req.body) {
    if (typeof req.body === 'object') return req.body as Record<string, unknown>;
    if (typeof req.body === 'string') {
      try {
        return JSON.parse(req.body) as Record<string, unknown>;
      } catch {
        return {};
      }
    }
  }

  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk: { toString: () => string }) => {
      raw += chunk.toString();
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw) as Record<string, unknown>);
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

export function normalizeCredentialAccountBody(
  body: Record<string, unknown>,
  defaultSource: CredentialAccountSource = 'admin',
): CredentialAccountBody {
  const rawSource = String(body?.source ?? '');
  const credentials =
    body?.credentials && typeof body.credentials === 'object' && !Array.isArray(body.credentials)
      ? (body.credentials as Record<string, unknown>)
      : {};

  return {
    provider: String(body?.provider ?? '').toLowerCase(),
    label: body?.label != null ? String(body.label).slice(0, 200) : null,
    accountIdentifier:
      body?.accountIdentifier != null ? String(body.accountIdentifier).slice(0, 200) : null,
    credentials,
    source: ALLOWED_ACCOUNT_SOURCES.has(rawSource)
      ? (rawSource as CredentialAccountSource)
      : defaultSource,
    clientId:
      body?.clientId != null && Number.isFinite(Number(body.clientId))
        ? Number(body.clientId)
        : null,
    credentialKeys: Object.keys(credentials).sort(),
    bodyKeys: Object.keys(body ?? {}).sort(),
    bodyType: typeof body,
  };
}

export function normalizeCredentialAccountPatchBody(
  body: Record<string, unknown>,
): CredentialAccountPatchBody {
  const hasSource = body?.source !== undefined;
  const hasLabel = body?.label !== undefined;

  let source: CredentialAccountSource | null = null;
  if (hasSource) {
    const rawSource = body?.source != null ? String(body.source) : '';
    if (ALLOWED_ACCOUNT_SOURCES.has(rawSource)) {
      source = rawSource as CredentialAccountSource;
    }
  }

  let label: string | null = null;
  let labelGoesNull = false;
  if (hasLabel) {
    const rawLabel = body?.label == null ? '' : String(body.label);
    const trimmed = rawLabel.trim().slice(0, 200);
    if (trimmed.length === 0) {
      labelGoesNull = true;
    } else {
      label = trimmed;
    }
  }

  // Credentials merge — keep only fields the caller actually supplied. Blank
  // strings/nulls are treated as "leave unchanged" so re-entering just the
  // password never clears the stored apiKey/email.
  let credentials: Record<string, unknown> | null = null;
  let credentialKeys: string[] = [];
  const rawCredentials = body?.credentials;
  if (rawCredentials && typeof rawCredentials === 'object' && !Array.isArray(rawCredentials)) {
    const filtered: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(rawCredentials as Record<string, unknown>)) {
      if (value == null) continue;
      if (typeof value === 'string' && value.trim() === '') continue;
      filtered[key] = value;
    }
    credentialKeys = Object.keys(filtered).sort();
    if (credentialKeys.length > 0) credentials = filtered;
  }
  const hasCredentials = credentials != null;

  const hasActive = typeof body?.active === 'boolean';
  const active = hasActive ? Boolean(body.active) : null;

  return { hasSource, hasLabel, source, label, labelGoesNull, hasCredentials, credentials, credentialKeys, hasActive, active };
}

export function maskAccountIdentifier(value: string | null): string | null {
  return value ? `${value.slice(0, 8)}...` : null;
}
