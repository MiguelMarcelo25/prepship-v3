/**
 * Deprecated safety shim.
 *
 * PS-026 changed the operational rule: shipped/cancelled order status does not
 * prove the warehouse physically printed the label. Active print queue entries
 * must persist until an operator explicitly confirms printed or removes them.
 *
 * This script intentionally does not delete print_queue_orders rows.
 */

async function main() {
  console.log('No-op: active print queue entries persist until explicit operator action.');
  console.log('Use the Print Queue UI to confirm printed, remove one item, or clear with confirmation.');
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
