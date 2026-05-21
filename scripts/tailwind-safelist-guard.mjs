import { readFile } from 'node:fs/promises'
import path from 'node:path'

const root = process.cwd()
const tailwindConfigPath = path.join(root, 'tailwind.config.ts')
const packageJsonPath = path.join(root, 'package.json')
const source = await readFile(tailwindConfigPath, 'utf8')
const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8'))

const checks = [
  {
    name: 'ACCENT_PALETTES is not present',
    pass: !source.includes('ACCENT_PALETTES'),
  },
  {
    name: 'broad color utility safelist pattern is not present',
    pass: !/\(\s*bg\|text\|ring\|border\|shadow\|from\|via\|to\s*\)/.test(source),
  },
  {
    name: 'all-shades safelist pattern is not present',
    pass: !/\(\s*50\|100\|200\|300\|400\|500\|600\|700\|800\|900\s*\)/.test(source),
  },
  {
    name: 'safelist does not generate patterns with RegExp',
    pass: !/safelist\s*:\s*\[[\s\S]*?(pattern\s*:|new\s+RegExp)/.test(source),
  },
  {
    name: 'package.json exposes test:tailwind-safelist',
    pass: packageJson.scripts?.['test:tailwind-safelist'] === 'node scripts/tailwind-safelist-guard.mjs',
  },
]

const failures = checks.filter((check) => !check.pass)

for (const check of checks) {
  console.log(`${check.pass ? 'PASS' : 'FAIL'} ${check.name}`)
}

if (failures.length > 0) {
  console.error(`\n${failures.length} Tailwind safelist guard check${failures.length === 1 ? '' : 's'} failed.`)
  process.exit(1)
}
