type CorsOptions = {
  methods?: string;
  headers?: string;
  maxAge?: string;
};

export const DEFAULT_CORS_ALLOW_HEADERS = [
  'Authorization',
  'Content-Type',
  'If-Match',
  'X-Request-Id',
  'X-Correlation-Id',
];

const DEFAULT_ALLOWED_ORIGINS = [
  'https://prepship.vercel.app',
  'https://prepship-eta.vercel.app',
  'https://prepshipv4.vercel.app',
  'https://prepshipv4.drprepperusa.com',
  'https://prepshipv3.vercel.app',
  'https://prepshipv3.drprepperusa.com',
  'https://prepshipv3-dr-prepper-usas-projects.vercel.app',
  'http://localhost:3000',
  'http://localhost:5173',
  'http://localhost:5174',
];

export function configuredCorsOrigins(
  webOrigin = process.env.WEB_ORIGIN
): string[] {
  const fromEnv = webOrigin
    ? webOrigin
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean)
    : [];
  return Array.from(new Set([...fromEnv, ...DEFAULT_ALLOWED_ORIGINS]));
}

export function isAllowedCorsOrigin(origin: string | null | undefined): boolean {
  if (!origin) return false;
  if (configuredCorsOrigins().includes(origin)) return true;

  try {
    const { hostname, protocol } = new URL(origin);
    if (protocol === 'https:') {
      return (
        hostname.endsWith('-dr-prepper-usas-projects.vercel.app') ||
        hostname === 'prepshipv4.vercel.app' ||
        hostname === 'prepshipv4.drprepperusa.com'
      );
    }

    if (protocol !== 'http:') return false;
    return (
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname === '[::1]' ||
      hostname === '::1'
    );
  } catch {
    return false;
  }
}

export function corsHeaders(
  origin: string | null | undefined,
  options: CorsOptions = {}
): Record<string, string> {
  const headers: Record<string, string> = {
    Vary: 'Origin',
    'Access-Control-Allow-Methods':
      options.methods ?? 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers':
      options.headers ?? DEFAULT_CORS_ALLOW_HEADERS.join(', '),
    'Access-Control-Expose-Headers': 'X-Request-Id, Server-Timing',
  };

  if (options.maxAge) {
    headers['Access-Control-Max-Age'] = options.maxAge;
  }

  if (isAllowedCorsOrigin(origin)) {
    headers['Access-Control-Allow-Origin'] = String(origin);
  }

  return headers;
}
