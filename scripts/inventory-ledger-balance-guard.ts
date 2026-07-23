// Historical compatibility gate. PS-439 makes the raw signed ledger sum the
// only balance and removes every order/cache fallback.
await import('./ps-439-inventory-source-of-truth-guard.js');
console.log('PASS inventory ledger balance compatibility guard via PS-439');
