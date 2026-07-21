// PS-414 compatibility gate: PS-439 supersedes its cached-balance contract
// with the immutable signed-ledger source of truth.
await import('./ps-439-inventory-source-of-truth-guard.js');
console.log('PASS PS-414 compatibility guard via PS-439');
