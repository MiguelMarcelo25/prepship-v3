import fs from 'node:fs'

function read(path) {
  return fs.readFileSync(path, 'utf8')
}

function assert(condition, message) {
  if (!condition) {
    console.error(`FAIL ${message}`)
    process.exitCode = 1
  }
}

const inventoryCss = read('web/src/components/Views/InventoryView.css')
const appShellCss = read('web/src/app-shell.css')
const main = read('web/src/main.tsx')
const cacheVersion = read('web/src/lib/ui-cache-version.ts')
const vercel = JSON.parse(read('vercel.json'))

assert(
  /--sidebar-w:240px;/.test(appShellCss) &&
    /\.inventory-drawer-overlay\s*\{[\s\S]*left:var\(--sidebar-w,\s*240px\)/.test(inventoryCss),
  'Inventory SKU drawer overlay starts after the desktop sidebar',
)
assert(
  /@media \(max-width:\s*768px\)[\s\S]*\.inventory-drawer-overlay\s*\{[\s\S]*inset:0;/.test(inventoryCss),
  'Inventory SKU drawer overlay remains full-screen on mobile',
)
assert(
  main.includes("import { runUiCacheVersionMigration } from './lib/ui-cache-version';") &&
    main.includes('runUiCacheVersionMigration();'),
  'UI cache-version migration runs before the React app mounts',
)
assert(
  cacheVersion.includes("const VERSION_KEY = 'prepship:ui-cache-version'") &&
    cacheVersion.includes('inventory-stock-levels') &&
    cacheVersion.includes('inventory-history-table') &&
    !cacheVersion.includes('auth-token') &&
    !cacheVersion.includes('access_token') &&
    !cacheVersion.includes('refresh_token'),
  'UI cache migration clears layout keys without targeting auth/session tokens',
)

const headers = Array.isArray(vercel.headers) ? vercel.headers : []
assert(
  headers.some((entry) =>
    entry.source === '/((?!assets/).*)' &&
    entry.headers?.some((header) => header.key === 'Cache-Control' && /no-cache/.test(header.value ?? '')),
  ),
  'Vercel app shell routes are no-cache/revalidate',
)
assert(
  headers.some((entry) =>
    entry.source === '/assets/(.*)' &&
    entry.headers?.some((header) => header.key === 'Cache-Control' && /immutable/.test(header.value ?? '')),
  ),
  'Vercel hashed assets stay immutable-cacheable',
)

if (!process.exitCode) {
  console.log('PASS sidebar/cache UX guard')
}
