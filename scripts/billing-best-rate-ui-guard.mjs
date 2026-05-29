import fs from 'node:fs'

function read(path) {
  return fs.readFileSync(path, 'utf8')
}

function assert(condition, message) {
  if (!condition) {
    console.error(`FAIL ${message}`)
    process.exitCode = 1
    return
  }
  console.log(`PASS ${message}`)
}

const css = read('web/src/components/Views/BillingView.css')
const view = read('web/src/components/Views/BillingView.tsx')
const packageJson = JSON.parse(read('package.json'))

const rateHitRule = css.match(/\.billing-detail-rate-hit\s*\{([\s\S]*?)\}/)?.[1] ?? ''

assert(!/\bborder\s*:/.test(rateHitRule), 'billing detail rate-hit style does not draw a blue border')
assert(!/\boutline\s*:/.test(rateHitRule), 'billing detail rate-hit style does not draw an outline')
assert(view.includes('data-billing-rate="bestRate"'), 'Billing Detail Best Rate cell has a stable UI selector')
assert(
  packageJson.scripts?.['test:billing-best-rate-ui'] === 'playwright test web/e2e/billing-best-rate-ui.spec.js --reporter=line',
  'package exposes focused Billing Best Rate UI browser test',
)

if (process.exitCode) process.exit(process.exitCode)
