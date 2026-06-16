// PS-251 (Card 6): SSRF guard for caller-supplied carrier endpoint URLs.
//
// A few carrier credential verifiers let the operator set a tenant host
// (creds.apiBase / creds.swsimEndpoint). A malicious or compromised operator
// could point that at internal infrastructure — cloud metadata (169.254.169.254),
// localhost, or an RFC-1918 host — turning a "verify credentials" click into an
// SSRF probe. This validates a caller-supplied URL is a PUBLIC http(s) endpoint
// before any fetch.
//
// Scope: literal-IP + known-internal-name blocking (synchronous, no I/O). DNS
// rebinding (a public name that resolves to a private IP) needs a runtime resolve
// of the connecting socket — tracked as a follow-up; this closes the direct vector.

export class SsrfBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SsrfBlockedError';
  }
}

const BLOCKED_HOSTS = new Set([
  'localhost',
  '127.0.0.1',
  '0.0.0.0',
  '::1',
  '[::1]',
  '169.254.169.254', // cloud instance metadata
  'metadata',
  'metadata.google.internal',
]);

type Ipv4 = [number, number, number, number];

function ipv4Octets(host: string): Ipv4 | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const octets: Ipv4 = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
  return octets.every((n) => n >= 0 && n <= 255) ? octets : null;
}

function isPrivateOrReservedIpv4(octets: Ipv4): boolean {
  const [a, b] = octets;
  if (a === 0 || a === 10 || a === 127) return true; // this-network, RFC1918 /8, loopback
  if (a === 169 && b === 254) return true; // link-local + metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918 /12
  if (a === 192 && b === 168) return true; // RFC1918 /16
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
  if (a >= 224) return true; // multicast / reserved
  return false;
}

function isPrivateOrReservedIpv6(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === '::1' || h === '::') return true;
  if (/^f[cd]/.test(h)) return true; // ULA fc00::/7
  if (h.startsWith('fe80')) return true; // link-local
  if (h.startsWith('::ffff:')) {
    const octets = ipv4Octets(h.slice('::ffff:'.length));
    if (octets) return isPrivateOrReservedIpv4(octets);
  }
  return false;
}

/**
 * Validate a caller-supplied URL points at a PUBLIC http(s) host. Returns the URL
 * unchanged when safe; throws SsrfBlockedError for a bad scheme or an internal /
 * private / loopback / link-local / metadata host.
 */
export function assertPublicHttpUrl(raw: string, label: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SsrfBlockedError(`${label}: not a valid URL`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SsrfBlockedError(`${label}: only http(s) URLs are allowed`);
  }
  const host = url.hostname.toLowerCase();
  if (BLOCKED_HOSTS.has(host)) {
    throw new SsrfBlockedError(`${label}: blocked internal host (${host})`);
  }
  const v4 = ipv4Octets(host);
  if (v4 && isPrivateOrReservedIpv4(v4)) {
    throw new SsrfBlockedError(`${label}: private/reserved IP (${host})`);
  }
  if (host.includes(':') && isPrivateOrReservedIpv6(host)) {
    throw new SsrfBlockedError(`${label}: private/reserved IPv6 (${host})`);
  }
  return raw;
}
