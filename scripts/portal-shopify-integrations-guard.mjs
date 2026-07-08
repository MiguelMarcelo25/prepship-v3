import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

function read(path) {
  assert(existsSync(path), `missing ${path}`);
  return readFileSync(path, 'utf8');
}

const route = read('src/routes/client-portal/integrations.ts');
const service = read('src/services/portal-shopify-integrations.ts');
const main = read('src/main.ts');

assert(main.includes("import clientPortalIntegrationsRoute"), 'main must import client portal integrations route');
assert(main.includes("'/client-portal'"), 'main must protect and mount /client-portal');
assert(route.includes("post('/integrations/validate'"), 'portal route must expose validate endpoint');
assert(route.includes("post('/integrations'"), 'portal route must expose submit endpoint');
assert(route.includes('isPortalSession'), 'portal route must require a portal session');
assert(route.includes("provider: 'shopify'"), 'portal route must be Shopify-specific for v1');
assert(route.includes('validateShopifyCredentials'), 'portal route must validate Shopify credentials server-side');
assert(route.includes('rateLimitShopifyValidation'), 'validate endpoint must be rate-limited');
assert(route.includes('clientIds') && route.includes('primaryPortalClientId'), 'clientId must be derived from auth scope');
assert(!route.includes('body.clientId'), 'portal route must never trust body.clientId');
assert(!route.includes('adminAccessToken') || route.includes('redact'), 'route must not echo raw Admin API token');
assert(service.includes("source: 'portal'"), 'portal submit must save as source=portal');
assert(service.includes('active: false'), 'portal submit must save inactive pending approval');
assert(service.includes('accountIdentifier: validation.myshopifyDomain'), 'account identifier must come from Shopify validation');
assert(service.includes('credentials'), 'service stores credentials through existing credential rails');
assert(!/return\s+\{[\s\S]*credentials/.test(service), 'portal service must not return stored credentials');

console.log('PASS portal Shopify integration route safety is pinned');
