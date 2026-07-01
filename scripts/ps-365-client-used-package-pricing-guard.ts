import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

type Check = { name: string; run: () => void | Promise<void> };

const servicePath = 'src/services/billing-client-package-pricing.ts';
const routePath = 'src/routes/billing.ts';
const billingParityPath = 'web/src/components/Views/billing-parity.ts';
const billingViewPath = 'web/src/components/Views/BillingView.tsx';
const packageJsonPath = 'package.json';

function src(path: string) {
  return readFileSync(path, 'utf8');
}

const route = src(routePath);
const billingParity = src(billingParityPath);
const billingView = src(billingViewPath);
const packageJson = src(packageJsonPath);

const checks: Check[] = [
  {
    name: 'backend client-used package pricing owner exists',
    run: () => {
      assert.equal(existsSync(servicePath), true);
    },
  },
  {
    name: '/billing/package-prices delegates row-set membership to backend owner',
    run: () => {
      assert.match(route, /clientUsedPackagePricingRows/);
      assert.doesNotMatch(
        route,
        /\.select\(\)\s*\n\s*\.from\(clientPackagePrices\)[\s\S]{0,500}return c\.json\(\{ data: rows \}\)/,
      );
    },
  },
  {
    name: 'frontend package pricing builder no longer accepts global packages as membership input',
    run: () => {
      assert.doesNotMatch(billingParity, /packages\s*:\s*PackageDto\[\][\s\S]{0,180}savedRows/);
      assert.doesNotMatch(billingParity, /\.filter\(\(pkg\)\s*=>\s*pkg\.source\s*===\s*['"]custom['"]\)/);
      assert.doesNotMatch(billingView, /buildBillingPackagePriceRows\(packages,/);
    },
  },
  {
    name: 'empty client copy says no used package evidence instead of global package fallback',
    run: () => {
      assert.match(billingView + src('web/src/components/Views/BillingPackagePricingTable.tsx'), /No package sizes found for this client/i);
      assert.doesNotMatch(src('web/src/components/Views/BillingPackagePricingTable.tsx'), /No custom packages found/);
    },
  },
  {
    name: 'save payload is scoped to visible backend rows',
    run: () => {
      assert.match(billingView, /prices:\s*packagePricingRows\.map/);
      assert.doesNotMatch(billingView, /prices:\s*packages\.map/);
    },
  },
  {
    name: 'package.json wires the PS-365 guard',
    run: () => {
      assert.match(packageJson, /"test:ps-365-client-used-package-pricing"\s*:\s*"tsx scripts\/ps-365-client-used-package-pricing-guard\.ts"/);
    },
  },
  {
    name: 'backend pure owner includes billing-line package usage and excludes unused global packages',
    run: async () => {
      assert.equal(existsSync(servicePath), true);
      const mod = await import(pathToFileURL(`${process.cwd()}/${servicePath}`).href) as {
        buildClientUsedPackagePricingRows: (input: unknown) => Array<{ packageId: number; name: string }>;
      };

      const rows = mod.buildClientUsedPackagePricingRows({
        packages: [
          { packageId: 1, name: 'Unused A', source: 'custom', length: 4, width: 4, height: 4, unitCost: 0.5 },
          { packageId: 2, name: 'Used B', source: 'custom', length: 6, width: 5, height: 4, unitCost: 0.75 },
          { packageId: 3, name: 'Unused C', source: 'custom', length: 9, width: 9, height: 9, unitCost: 1.25 },
        ],
        savedPrices: [],
        billingPackageIds: [2],
        shipmentEvidence: [],
      });

      assert.deepEqual(rows.map((row) => row.packageId), [2]);
      assert.equal(rows[0]?.name, 'Used B');
    },
  },
  {
    name: 'backend pure owner resolves shipment selected_pid, selected_package_id code, and dims evidence',
    run: async () => {
      assert.equal(existsSync(servicePath), true);
      const mod = await import(pathToFileURL(`${process.cwd()}/${servicePath}`).href) as {
        buildClientUsedPackagePricingRows: (input: unknown) => Array<{ packageId: number }>;
      };

      const rows = mod.buildClientUsedPackagePricingRows({
        packages: [
          { packageId: 11, name: 'PID Box', source: 'custom', length: 11, width: 10, height: 3, unitCost: 0.9 },
          { packageId: 12, name: 'Code Box', source: 'custom', packageCode: 'box-code-12', length: 12, width: 10, height: 3, unitCost: 1.1 },
          { packageId: 13, name: 'Dims Box', source: 'custom', length: 13, width: 10, height: 3, unitCost: 1.3 },
          { packageId: 14, name: 'Never Used', source: 'custom', length: 14, width: 10, height: 3, unitCost: 1.4 },
        ],
        savedPrices: [{ packageId: 14, price: 9.99, is_custom: true }],
        billingPackageIds: [],
        shipmentEvidence: [
          { selectedPid: 11, selectedPackageId: null, dimsL: 11, dimsW: 10, dimsH: 3 },
          { selectedPid: null, selectedPackageId: 'box-code-12', dimsL: 12, dimsW: 10, dimsH: 3 },
          { selectedPid: null, selectedPackageId: null, dimsL: 13, dimsW: 10, dimsH: 3 },
        ],
      });

      assert.deepEqual(rows.map((row) => row.packageId), [12, 13, 11]);
    },
  },
];

let failed = 0;
for (const check of checks) {
  try {
    await check.run();
    console.log(`ok   ${check.name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL ${check.name}`);
    console.error(error instanceof Error ? error.message : error);
  }
}

if (failed > 0) {
  console.error(`\nFAIL PS-365 client-used package pricing guard (${failed} failing)`);
  process.exit(1);
}

console.log('\nPASS PS-365 client-used package pricing guard');
