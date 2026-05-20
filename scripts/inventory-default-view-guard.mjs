import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const inventoryView = fs.readFileSync(path.join(root, 'web/src/components/Views/InventoryView.tsx'), 'utf8');
const inventoryParity = fs.readFileSync(path.join(root, 'web/src/components/Views/inventory-parity.ts'), 'utf8');
const compactView = inventoryView.replace(/\s+/g, ' ');

function fail(message) {
  console.error(`FAIL ${message}`);
  process.exitCode = 1;
}

function pass(message) {
  console.log(`PASS ${message}`);
}

function assert(condition, message) {
  if (condition) pass(message);
  else fail(message);
}

assert(
  inventoryView.includes("const INVENTORY_ACTIVE_ONLY_KEY = 'inventory_active_only'"),
  'Inventory active/deactivated preference uses a named storage key',
);

assert(
  inventoryView.includes('function readStoredInventoryActiveOnly(): boolean'),
  'Inventory active/deactivated preference has a defensive reader',
);

assert(
  compactView.includes("if (typeof window === 'undefined') return true"),
  'Inventory defaults to Active only during non-browser rendering',
);

assert(
  compactView.includes("return raw === null ? true : raw === 'true'"),
  'Fresh browsers default Inventory Stock Levels to Active only',
);

assert(
  !compactView.includes("return raw === null ? false : raw === 'true'"),
  'Fresh browsers no longer default Inventory Stock Levels to Deactivated only',
);

assert(
  compactView.includes('const [activeOnly, setActiveOnly] = useState<boolean>(readStoredInventoryActiveOnly)'),
  'Inventory view initializes activeOnly from the defensive reader',
);

assert(
  inventoryView.includes('function writeStoredInventoryActiveOnly(activeOnly: boolean): void'),
  'Inventory active/deactivated preference has a best-effort writer',
);

assert(
  inventoryView.includes('window.localStorage.setItem(INVENTORY_ACTIVE_ONLY_KEY, String(activeOnly))'),
  'Inventory active/deactivated preference writer persists the toggle state',
);

assert(
  inventoryView.includes('Status mode defaults to Active only'),
  'InventoryView comment documents fresh-browser Active-only default',
);

assert(
  inventoryParity.includes('Defaults to') && inventoryParity.includes('true in the view'),
  'Inventory parity helper documents Active-only as the default view',
);

if (process.exitCode) {
  process.exit(process.exitCode);
}
