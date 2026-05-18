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

  return { hasSource, hasLabel, source, label, labelGoesNull };
}

export function maskAccountIdentifier(value: string | null): string | null {
  return value ? `${value.slice(0, 8)}...` : null;
}
