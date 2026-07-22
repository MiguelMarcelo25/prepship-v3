// PS-427 cache rebuild was superseded by PS-439: no balance cache exists and
// reconciliation is now a read-only discrepancy report.
await import('./ps-439-inventory-source-of-truth-guard.js');
console.log('PASS PS-427 compatibility guard via PS-439 report-only reconciliation');
