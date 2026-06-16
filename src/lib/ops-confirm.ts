// PS-255 (Card 10): a destructive ops/maintenance script must DEFAULT to a no-op dry run
// and require an explicit --apply (or --confirm) flag to mutate. Optionally it can also
// require an OPS_CONFIRM_TOKEN env match (set in prod) so a fat-fingered
// `npx tsx scripts/<destructive>.ts` against a live target is inert, not catastrophic.

export function opsApplyRequested(argv: readonly string[] = process.argv): boolean {
  return argv.includes('--apply') || argv.includes('--confirm');
}

/**
 * May this destructive script actually MUTATE? Default false (dry run). True only when
 * --apply/--confirm is present AND, when requireToken, --token=<x> matches OPS_CONFIRM_TOKEN.
 */
export function opsMayMutate(
  argv: readonly string[] = process.argv,
  opts: { requireToken?: boolean } = {},
): boolean {
  if (!opsApplyRequested(argv)) return false;
  if (opts.requireToken) {
    const expected = (process.env.OPS_CONFIRM_TOKEN ?? '').trim();
    const tokenArg = argv.find((a) => a.startsWith('--token='));
    const provided = tokenArg ? tokenArg.slice('--token='.length).trim() : '';
    if (!expected || provided !== expected) return false;
  }
  return true;
}
