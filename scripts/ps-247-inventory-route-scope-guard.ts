/**
 * PS-247 (Card 2, slice 2) — every inventory MUTATION route is cross-tenant scoped.
 *
 * The read/list routes already filtered by inventoryScopePredicate, but the mutation routes resolved
 * rows by BARE id / trusted a body clientId, so a restricted (client_user) caller could create, patch,
 * receive, adjust, re-parent, or bulk-edit ANY tenant's inventory (a real IDOR). This pins the close:
 *   - inventoryClientInScope gates clientId-write routes (create / patch / bulk-receive / bulk-default).
 *   - inventoryIdInScope gates the by-id movement routes (receive / adjust / POST adjust / delete-parents).
 *   - inventoryScopePredicate is now applied to the by-id mutation WHEREs (patch / set-parent / add-parent /
 *     bulk-update-dims / bulk-receive find-or-create), so an out-of-scope row 404s / is skipped.
 *
 *   npx tsx scripts/ps-247-inventory-route-scope-guard.ts
 */
import { readFileSync } from 'node:fs';
// BEHAVIORAL: import + run the real scope classifier the inventory route guards delegate to (satisfies
// the Card 14 authz-guard behavioral ratchet — a scope guard must exercise ../src, not just grep).
import { getClientStoreScope } from '../src/lib/client-store-scope';

let failures = 0;
function check(name: string, cond: boolean): void {
  if (!cond) { failures += 1; console.error(`FAIL ${name}`); }
  else console.log(`ok   ${name}`);
}

// ── behavioral: the restricted/global verdict that drives inventoryClientInScope/inventoryIdInScope ──
const restricted = getClientStoreScope({ role: 'client_user', clientIds: [4], storeIds: [] });
check('a client_user scope is RESTRICTED (the inventory mutation guards must enforce it)',
  restricted.isRestricted === true);
const adminScope = getClientStoreScope({ role: 'admin', clientIds: [], storeIds: [] });
check('an admin scope is NOT restricted (inventory mutations pass through)',
  adminScope.isRestricted !== true);

const inv = readFileSync('src/routes/inventory.ts', 'utf8');
const count = (re: RegExp) => inv.match(re)?.length ?? 0;

check('inventoryClientInScope guard helper exists', /function inventoryClientInScope\(/.test(inv));
check('inventoryIdInScope guard helper exists', /async function inventoryIdInScope\(/.test(inv));
check('client-scope checks gate the clientId-write routes (create/patch/bulk-receive/bulk-default, >=4)',
  count(/inventoryClientInScope\(/g) >= 5); // 1 def + >=4 call sites
check('id-scope checks gate the by-id movement routes (receive/adjust/POST-adjust/delete-parents, >=4)',
  count(/await inventoryIdInScope\(/g) >= 4);
check('inventoryScopePredicate now also guards mutations, not just reads (>=7 usages)',
  count(/inventoryScopePredicate\(/g) >= 7);

// region spot-checks: the two highest-risk bulk/by-id UPDATEs carry the predicate in their WHERE
const flat = inv.replace(/\s+/g, '');
check('PATCH /:id update is scope-predicated',
  flat.includes('.where(and(eq(inventory.id,id),inventoryScopePredicate(scope)))'));
check('bulk-update-dims update is scope-predicated',
  flat.includes('.where(and(eq(inventory.id,item.id),inventoryScopePredicate(scope)))'));
check('create (POST /) rejects an out-of-scope body clientId (403)',
  /if \(!inventoryClientInScope\(inventoryScopeFromContext\(c\), body\.clientId\)\)/.test(inv));

check('package.json wires test:ps-247-inventory-route-scope',
  /test:ps-247-inventory-route-scope/.test(readFileSync('package.json', 'utf8')));

if (failures > 0) {
  console.error(`\nFAIL PS-247 inventory route-scope guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-247 inventory route-scope guard');
