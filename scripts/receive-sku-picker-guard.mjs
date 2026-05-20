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
  inventory.includes('includeInactive: true') &&
    inventory.includes('clientId: Number.parseInt(receiveClientId, 10)') &&
    inventory.includes('setReceiveSkuMap(nextMap)'),
  'Receive Inventory SKU lookup loads the full selected-client inventory set, including inactive rows',
);

assert(
  inventory.includes('maxResults={receiveSkuOptions.length || 50}'),
  'Receive Inventory SKU picker does not cap selected-client SKU results to the default small list',
);

assert(
  inventory.includes("flex: '4 1 960px'") &&
    inventory.includes('minWidth: 760') &&
    inventory.includes("width: 'min(1040px, calc(100vw - 2rem))'"),
  'Receive Inventory SKU field and popover stay wide for operator scanning',
);

assert(
  autosuggest.includes('maxResults = 8') &&
    autosuggest.includes('showOnFocus ? options.slice(0, maxResults)') &&
    autosuggest.includes('max-h-72 overflow-y-auto'),
  'Autosuggest still supports caller-controlled full-list display with bounded scrolling',
);

if (process.exitCode) {
  process.exit(process.exitCode);
}
