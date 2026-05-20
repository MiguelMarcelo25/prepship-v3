import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const inventoryPath = path.join(root, 'web/src/components/Views/InventoryView.tsx');
const autosuggestPath = path.join(root, 'web/src/components/Autosuggest.tsx');
const packagePath = path.join(root, 'package.json');

const inventory = fs.readFileSync(inventoryPath, 'utf8');
const autosuggest = fs.readFileSync(autosuggestPath, 'utf8');
const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));

function assert(condition, message) {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`ok: ${message}`);
  }
}

assert(
  pkg.scripts?.['test:receive-sku-picker'] === 'node scripts/receive-sku-picker-guard.mjs',
  'package.json exposes test:receive-sku-picker',
);

assert(
  inventory.includes('apiClient.fetchInventory({') && inventory.includes('includeInactive: true'),
  'Receive SKU loader fetches all client inventory rows, including inactive SKUs',
);

assert(
  !inventory.includes('const clientPage = await apiClient.fetchInventoryPage({\n          clientId: Number.parseInt(receiveClientId, 10),\n          active: true,\n          page: 1,\n          pageSize: 2000,'),
  'Receive SKU loader no longer uses one active-only inventory page',
);

assert(
  autosuggest.includes('popoverClassName?: string') && autosuggest.includes('popoverStyle?: CSSProperties'),
  'Autosuggest supports wider custom popover sizing',
);

assert(
  inventory.includes("width: 'min(760px, calc(100vw - 2rem))'"),
  'Receive SKU dropdown has at least 4x wider horizontal viewing space',
);

assert(
  inventory.includes('maxResults={receiveSkuOptions.length || 50}'),
  'Receive SKU dropdown can show the full selected-client SKU result set',
);

if (process.exitCode) {
  process.exit(process.exitCode);
}
