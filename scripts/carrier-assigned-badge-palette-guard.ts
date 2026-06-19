/**
 * Guard: carrier assignment chips in Settings should reuse the same per-client
 * palette as Awaiting Shipment order-row client badges.
 */
import { readFileSync } from 'node:fs';

const card = readFileSync('web/src/components/Settings/CarrierIntegrationsCard.tsx', 'utf8');

let failures = 0;

function check(name: string, condition: boolean) {
  if (!condition) {
    failures += 1;
    console.error(`FAIL ${name}`);
  } else {
    console.log(`ok   ${name}`);
  }
}

const assignedChipStart = card.indexOf('d.assignedClientIds.map((cid) => {');
const assignedChipBlock =
  assignedChipStart >= 0
    ? card.slice(assignedChipStart, assignedChipStart + 2_400)
    : '';

check(
  'CarrierIntegrationsCard imports the Awaiting Shipment client palette owner',
  /import \{ getClientPalette \} from '\.\.\/Views\/orders-formatting'/.test(card),
);
check(
  'assigned-client chips compute palette from the rendered client name',
  /const clientPalette = getClientPalette\(clientName\)/.test(assignedChipBlock),
);
check(
  'assigned-client chips use palette background/color/border for active clients',
  /: clientPalette\.bg/.test(assignedChipBlock) &&
    /: clientPalette\.color/.test(assignedChipBlock) &&
    /`1px solid \$\{clientPalette\.border\}`/.test(assignedChipBlock),
);
check(
  'assigned-client chips match the Awaiting Shipment client-badge radius',
  /borderRadius:\s*4/.test(assignedChipBlock),
);
check(
  'assigned-client active chips no longer use the generic brand-blue tint',
  !/rgb\(var\(--brand-rgb,\s*42 91 215\)/.test(assignedChipBlock),
);

if (failures > 0) {
  console.error(`\nFAIL carrier assigned badge palette guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS carrier assigned badge palette guard');
