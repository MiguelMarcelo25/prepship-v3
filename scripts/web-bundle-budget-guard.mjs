import { readdir, readFile, stat } from 'node:fs/promises'
import { gzipSync } from 'node:zlib'
import path from 'node:path'

const root = process.cwd()
const assetsDir = path.join(root, 'web/dist/assets')
const packageJsonPath = path.join(root, 'package.json')
const RAW_LIMIT = 1_000_000
const GZIP_LIMIT = 110_000
const GRADIENT_RULE_LIMIT = 300

function fail(message) {
  console.error(`FAIL ${message}`)
  process.exitCode = 1
}

function pass(message) {
  console.log(`PASS ${message}`)
}

function formatBytes(bytes) {
  return `${bytes.toLocaleString('en-US')} bytes`
}

async function findIndexCssAsset() {
  let entries
  try {
    entries = await readdir(assetsDir)
  } catch (error) {
    throw new Error(`Unable to read ${assetsDir}. Run the web build before this guard. ${error.message}`)
  }

  const candidates = entries
    .filter((entry) => /^index-.*\.css$/.test(entry))
    .map((entry) => path.join(assetsDir, entry))

  if (candidates.length === 0) {
    throw new Error(`No index-*.css asset found in ${assetsDir}. Run the web build before this guard.`)
  }

  const stats = await Promise.all(candidates.map(async (filePath) => ({ filePath, stats: await stat(filePath) })))
  stats.sort((a, b) => b.stats.mtimeMs - a.stats.mtimeMs)
  return stats[0].filePath
}

function countGradientUtilityRules(css) {
  const rules = css.match(/[^{}]+\{[^{}]*\}/g) ?? []
  return rules.filter((rule) => /(^|[,\s])\.(?:[-_a-zA-Z0-9]+\\:)*(?:from|via|to)-/.test(rule)).length
}

const cssPath = await findIndexCssAsset()
const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8'))
const css = await readFile(cssPath)
const rawSize = css.byteLength
const gzipSize = gzipSync(css).byteLength
const cssText = css.toString('utf8')
const gradientRuleCount = countGradientUtilityRules(cssText)

console.log(`CSS asset: ${path.relative(root, cssPath)}`)
console.log(`Raw size: ${formatBytes(rawSize)}`)
console.log(`Gzip size: ${formatBytes(gzipSize)}`)
console.log(`Generated gradient from/via/to rules: ${gradientRuleCount.toLocaleString('en-US')}`)

if (rawSize > RAW_LIMIT) {
  fail(`global CSS raw size must be <= ${formatBytes(RAW_LIMIT)}`)
} else {
  pass(`global CSS raw size is within ${formatBytes(RAW_LIMIT)}`)
}

if (gzipSize > GZIP_LIMIT) {
  fail(`global CSS gzip size must be <= ${formatBytes(GZIP_LIMIT)}`)
} else {
  pass(`global CSS gzip size is within ${formatBytes(GZIP_LIMIT)}`)
}

if (gradientRuleCount > GRADIENT_RULE_LIMIT) {
  fail(`generated gradient from/via/to rules must be <= ${GRADIENT_RULE_LIMIT}`)
} else {
  pass(`generated gradient from/via/to rules are within ${GRADIENT_RULE_LIMIT}`)
}

if (packageJson.scripts?.['test:web-bundle-budget'] !== 'npm run build:web && node scripts/web-bundle-budget-guard.mjs') {
  fail('package.json must expose test:web-bundle-budget')
} else {
  pass('package.json exposes test:web-bundle-budget')
}

if (process.exitCode) {
  process.exit(process.exitCode)
}
