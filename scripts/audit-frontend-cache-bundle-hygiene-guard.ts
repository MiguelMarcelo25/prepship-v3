/**
 * Audit 2026-07-13 item 4.4 frontend cache and bundle hygiene guard.
 *
 * Offline/static only. No browser, database, provider, label/postage,
 * marketplace, inventory, or production data access.
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'

function read(file: string): string {
  return existsSync(file) ? readFileSync(file, 'utf8') : ''
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) return sourceFiles(fullPath)
    return /\.(?:ts|tsx)$/.test(entry.name) ? [fullPath] : []
  })
}

const webSources = sourceFiles('web/src').map((file) => read(file)).join('\n')
const clientQuery = read('web/src/lib/client-query.ts')
const queryClient = read('web/src/lib/query-client.ts')
const apiClient = read('web/src/lib/v2-apiClient.ts')
const carrierBadge = read('web/src/components/CarrierBadge.tsx')
const integrations = read('web/src/components/Settings/CarrierIntegrationsCard.tsx')
const budgetGuard = read('scripts/web-bundle-budget-guard.mjs')
const packageJson = JSON.parse(read('package.json')) as {
  dependencies?: Record<string, string>
  scripts?: Record<string, string>
}
const guardPack = read('scripts/sot-guard-pack.mjs')
const doc = read('docs/ps-tickets/audit-4.4-frontend-cache-bundle-hygiene.md')

assert.match(clientQuery, /active:\s*\['clients', 'active-only'\]/,
  'active clients endpoint must have one canonical TanStack key')
assert.match(clientQuery, /includeInactive:\s*\['clients', 'include-inactive'\]/,
  'include-inactive clients endpoint must have one canonical TanStack key')
assert.match(clientQuery, /\/clients\?activeOnly=true/,
  'active client scope must remain explicit at the endpoint owner')
assert.match(clientQuery, /\/clients\?includeInactive=true/,
  'admin client scope must remain explicit at the endpoint owner')
assert.match(queryClient, /export const queryClient = new QueryClient/,
  'the app and imperative adapter must share one QueryClient instance')
const fetchClientsBlock = apiClient.slice(
  apiClient.indexOf('fetchClients()'),
  apiClient.indexOf('listClients()'),
)
assert.match(fetchClientsBlock, /queryClient\.fetchQuery\(activeClientRowsQueryOptions\(\)\)/,
  'legacy fetchClients must delegate to the canonical TanStack cache')
assert.doesNotMatch(fetchClientsBlock, /cachedSafe\(/,
  'legacy fetchClients must not create a parallel cachedReads entry')
assert.doesNotMatch(webSources, /\['v2-hooks:clients'/,
  'legacy client query keys must be removed')
assert.doesNotMatch(webSources, /\['analysis', 'clients'\]|\['settings', 'marketplace-fee-clients'\]/,
  'views must not mint endpoint-specific client cache aliases')

assert.equal(packageJson.dependencies?.['react-icons'], undefined,
  'lucide-react must be the only icon library')
assert.doesNotMatch(webSources, /from ['"]react-icons\//,
  'frontend source must not import react-icons')
assert.doesNotMatch(webSources, /<AnimatePresence\b[^>]*\bmode=["']wait["']/,
  'AnimatePresence swaps must not serialize exit before enter')

for (const carrier of ['ups', 'usps', 'fedex', 'shipp', 'easypost', 'walmart']) {
  const asset = `web/public/carrier-logos/${carrier}.svg`
  assert.ok(existsSync(asset), `${carrier} must be emitted as a static SVG asset`)
  assert.match(read(asset), /<svg\b/, `${carrier} asset must contain an SVG root`)
  assert.equal(existsSync(`web/src/utils/logo/${carrier}.tsx`), false,
    `${carrier} inline TSX logo must be removed from JavaScript chunks`)
}
assert.match(carrierBadge, /\/carrier-logos\//,
  'CarrierBadge must load static carrier-logo assets')
assert.match(integrations, /\/carrier-logos\//,
  'integration settings must load static carrier-logo assets')

assert.match(budgetGuard, /JS_CHUNK_RAW_LIMIT/,
  'bundle guard must define a raw per-JavaScript-chunk budget')
assert.match(budgetGuard, /JS_CHUNK_GZIP_LIMIT/,
  'bundle guard must define a gzip per-JavaScript-chunk budget')
assert.match(budgetGuard, /\.filter\(\(entry\) => \/\\\.js\$\//,
  'bundle guard must inspect every emitted JavaScript asset')
assert.equal(
  packageJson.scripts?.['test:audit-frontend-cache-bundle-hygiene'],
  'tsx scripts/audit-frontend-cache-bundle-hygiene-guard.ts',
  'package must expose the Audit 4.4 guard',
)
assert.ok(guardPack.includes("'test:audit-frontend-cache-bundle-hygiene'"),
  'SOT pack must require the Audit 4.4 guard')

for (const field of [
  'Business rule/workflow being changed',
  'Canonical backend/domain/read-model/policy owner',
  'Current duplicated/unsafe owners',
  'Where bad/stale/incomplete data can enter',
  'Callers that must delegate to the owner',
  'Wrapper/resolver/helper logic to delete or explicitly forbid',
  'Frontend role: display/action only; no authoritative business logic',
  'Backend boundary tests required',
  'Workflow/UI proof required',
]) {
  assert.ok(doc.includes(field), `placement record must include ${field}`)
}

console.log('PASS Audit 4.4 frontend cache and bundle hygiene guard')
