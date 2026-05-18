import {
  createRemoteJWKSet,
  decodeProtectedHeader,
  jwtVerify,
  type JWTVerifyOptions,
  type JWTPayload,
} from 'jose';

export type SupabaseJwtVerification =
  | { ok: true; payload: JWTPayload }
  | { ok: false; reason: string };

type VerifyOptions = {
  supabaseUrl?: string;
  jwtSecret?: string;
  strictClaims?: boolean;
};

let cachedJwks: ReturnType<typeof createRemoteJWKSet> | null = null;
let cachedJwksBase = '';

function boolFromEnv(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === 'true' || normalized === '1' || normalized === 'yes';
}

function normalizedSupabaseUrl(supabaseUrl?: string): string {
  return (supabaseUrl ?? process.env.SUPABASE_URL ?? '').replace(/\/+$/, '');
}

function getSupabaseJwks(supabaseUrl?: string) {
  const base = normalizedSupabaseUrl(supabaseUrl);
  if (!base) return null;
  if (!cachedJwks || cachedJwksBase !== base) {
    cachedJwksBase = base;
    cachedJwks = createRemoteJWKSet(
      new URL(`${base}/auth/v1/.well-known/jwks.json`)
    );
  }
  return cachedJwks;
}

function strictJwtOptions(options: VerifyOptions): JWTVerifyOptions | undefined {
  const strict =
    options.strictClaims ?? boolFromEnv(process.env.STRICT_JWT_CLAIMS);
  if (!strict) return undefined;

  const base = normalizedSupabaseUrl(options.supabaseUrl);
  if (!base) return undefined;

  return {
    issuer: `${base}/auth/v1`,
    audience: 'authenticated',
  };
}

export async function verifySupabaseJwt(
  token: string,
  options: VerifyOptions = {}
): Promise<SupabaseJwtVerification> {
  const errors: string[] = [];
  let protectedHeader: ReturnType<typeof decodeProtectedHeader>;

  try {
    protectedHeader = decodeProtectedHeader(token);
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : 'Malformed JWT',
    };
  }

  const verifyOptions = strictJwtOptions(options);
  const secret = options.jwtSecret ?? process.env.SUPABASE_JWT_SECRET;
  const jwks = getSupabaseJwks(options.supabaseUrl);
  const isHmacToken = protectedHeader.alg?.startsWith('HS') ?? false;

  const verifyWithSecret = async () => {
    if (!secret) throw new Error('SUPABASE_JWT_SECRET is not configured');
    return jwtVerify(token, new TextEncoder().encode(secret), verifyOptions);
  };

  const verifyWithJwks = async () => {
    if (!jwks) throw new Error('SUPABASE_URL is not configured');
    return jwtVerify(token, jwks, verifyOptions);
  };

  const attempts = isHmacToken
    ? [
        ['HS256', verifyWithSecret] as const,
        ['JWKS', verifyWithJwks] as const,
      ]
    : [
        ['JWKS', verifyWithJwks] as const,
        ['HS256', verifyWithSecret] as const,
      ];

  for (const [label, attempt] of attempts) {
    try {
      const { payload } = await attempt();
      return { ok: true, payload };
    } catch (err) {
      errors.push(
        `${label}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  return {
    ok: false,
    reason: errors.join(' | ') || 'no verification method available',
  };
}

export function extractBearerToken(authHeader: unknown): string {
  if (typeof authHeader !== 'string') return '';
  return authHeader.toLowerCase().startsWith('bearer ')
    ? authHeader.slice(7).trim()
    : '';
}
