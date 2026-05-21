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
  inventory.includes('grid-cols-[44px_minmax(420px,1fr)_minmax(220px,0.8fr)_96px_150px_48px]') &&
    !inventory.includes('min-w-[760px]') &&
    !inventory.includes("width: 'min(860px, calc(100vw - 2rem))'"),
  'Receive Inventory SKU dropdown aligns to the input width instead of forcing a wide menu',
);

assert(
  autosuggest.includes('maxResults = 8') &&
    autosuggest.includes('showOnFocus ? options.slice(0, maxResults)') &&
    autosuggest.includes('max-h-72 overflow-y-auto'),
  'Autosuggest still supports caller-controlled full-list display with bounded scrolling',
);

assert(
  autosuggest.includes('renderInPortal') &&
    autosuggest.includes('createPortal') &&
    autosuggest.includes('width: rect.width') &&
    inventory.includes('renderInPortal') &&
    inventory.includes('Receive Inventory SKU dropdown escapes worksheet overflow clipping'),
  'Receive Inventory SKU dropdown escapes worksheet overflow clipping',
);

assert(
  inventory.includes('id="inv-receive-worksheet"') &&
    inventory.includes('id="inv-receive-summary"') &&
    inventory.includes('Batch worksheet') &&
    inventory.includes('Total units'),
  'Receive Inventory uses the new Tailwind worksheet layout with a batch summary bar',
);

if (process.exitCode) {
  process.exit(process.exitCode);
}
