import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const script = readFileSync('scripts/ps-462-inventory-correction-packet.ts', 'utf8');

assert.match(script, /buildInventoryReconciliationPlan/);
assert.match(script, /set transaction read only/i);
assert.match(script, /PS462_CORRECTION_PACKET_IS_READ_ONLY/);
assert.match(script, /PREPARED_NOT_AUTHORIZED_FOR_APPLY/);
assert.match(script, /productionMovementApplyApproved:\s*false/);
assert.match(script, /migrationApplyApproved:\s*false/);
assert.match(script, /pushApproved:\s*false/);
assert.match(script, /deployApproved:\s*false/);
assert.doesNotMatch(script, /from ['"]\.\.\/src\/services\/inventory-movement/);
assert.doesNotMatch(script, /\bapplyInventoryMovement(?:InTransaction)?\s*\(/);
assert.doesNotMatch(script, /\b(?:tx|db|client)\.(?:update|delete|insert)\s*\(/);
assert.doesNotMatch(script, /`\s*(?:update|delete|insert|alter|drop|truncate)\b/i);

console.log('PASS PS-462 read-only correction packet generator guard');
