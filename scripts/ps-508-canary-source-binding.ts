/**
 * PS-508 — the executed-source binding owner for the canary packet (Hermes round-9).
 *
 * Round-8 bound the executed source with a clean-worktree gate (`git status --porcelain`). Hermes
 * round-9 demonstrated that this is insufficient: a tracked file carrying the `skip-worktree` (S)
 * or `assume-unchanged` (lowercase tag) index flag can be modified on disk while `git status
 * --porcelain` still reports the tree clean — so the packet could run modified acceptance code
 * while attesting the reviewed commit.
 *
 * This owner binds the ACCEPTANCE-CRITICAL source closure to the committed HEAD blobs by three
 * independent, fail-closed signals, evaluated per file:
 *   1. INDEX FLAG — the file's `git ls-files -v` tag must be exactly 'H' (cached, unflagged). 'S'
 *      (skip-worktree) or any lowercase tag (assume-unchanged) is refused. This directly rejects
 *      the two demonstrated bypasses and needs no line-ending normalization.
 *   2. HEAD-BLOB CONTENT — the working bytes must equal the committed HEAD blob. This repository
 *      has MIXED line endings between the committed blobs and the working tree (some blobs are LF,
 *      some CRLF — verified: a raw `git cat-file blob HEAD:<path>` vs disk compare differs on
 *      clean files), so a RAW byte compare false-positives. The compare therefore normalizes only
 *      the CRLF PAIR to LF (normalizeLineEndings) — NOT stripping every CR: a lone CR is a JS/TS
 *      line terminator, so stripping all CR would let a lone-CR insertion end a `//` comment early
 *      and smuggle executed code past the compare. Collapsing only `\r\n` erases line-ending-style
 *      differences (the sole normalization in play) while a lone CR survives and is caught. This
 *      catches a tamper even if a future git grows a flag this owner does not yet enumerate.
 *   3. PRESENCE — the file must exist on disk AND at HEAD; a missing/untracked bound file is
 *      refused (it cannot be bound to the reviewed commit).
 *
 * A clean-worktree porcelain check remains in the packet as defense in depth, but it is NOT the
 * authoritative binding — signals 1 and 2 here are. The functions are pure so the smoke exercises
 * them directly, including adversarial index-flag, lone-CR relineation, and content-tamper fixtures.
 *
 * ACCEPTED RESIDUAL — environment trust. Every fact here is produced by shelling `git`. The packet
 * scrubs the GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE/GIT_OBJECT_DIRECTORY/… family from the child env
 * and keeps GIT_NO_REPLACE_OBJECTS=1, which closes the GIT_*-redirection variant. It does NOT
 * defend against an attacker who controls PATH or the `git` binary itself (a `git` shim can lie
 * about every fact) — but that actor already controls the whole `tsx` run (they can edit the .ts on
 * disk, inject via NODE_OPTIONS, or hand-write the packet JSON), so it crosses no privilege
 * boundary and is out of threat model. This is the same class as the packet's deployment identity,
 * which is an operator attestation. For real assurance, run the packet in an attested CI runner.
 *
 * KNOWN LIMITATIONS (defense-in-depth gaps, not in-threat-model bypasses):
 *  - Import-before-validate ordering: the packet imports the bound modules at top of file, so their
 *    (declaration-only) top-level evaluates before main() runs this gate. No in-threat tamper mints a
 *    PASS (every one is refused before the verdict), but a validate-then-spawn bootstrap would remove
 *    the window entirely. Documented, not yet re-architected.
 *  - Closure completeness: BOUND_SOURCE_CLOSURE is hand-maintained. The smoke adds a static
 *    import-graph-vs-closure guard (extractRelativeImports below) so a first-party module imported by
 *    the acceptance mechanism but omitted from the closure fails CI — closing the only seam where BOTH
 *    the index-flag and porcelain checks could miss (an out-of-closure file hidden behind a flag).
 */

/**
 * The acceptance-critical source closure: the packet, the pure owners it imports, and the
 * shipping-money decision/classification/cutover/snapshot/money modules it imports. Modifying any
 * of these changes what the packet accepts, so each must be byte-bound to the reviewed commit.
 */
export const BOUND_SOURCE_CLOSURE: string[] = [
  'scripts/ps-508-canary-evidence-packet.ts',
  'scripts/ps-508-canary-portal-identity.ts',
  'scripts/ps-508-canary-worker-identity.ts',
  'scripts/ps-508-canary-source-binding.ts',
  'src/services/customer-shipping-money-billable-decision.ts',
  'src/services/customer-shipping-money-classification.ts',
  'src/services/customer-shipping-money-cutover-gate.ts',
  'src/services/customer-shipping-money-snapshot.ts',
  'src/lib/money.ts',
];

/** Parse `git ls-files -v` output into a path -> tag map (tag = the leading status letter). */
export function parseLsFilesV(output: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of output.split(/\r?\n/)) {
    if (!line) continue;
    // Format: "<tag><space><path>"; the tag is a single character.
    const tag = line[0]!;
    const path = line.slice(2);
    if (path) map.set(path, tag);
  }
  return map;
}

/**
 * A bound file's index tag is safe ONLY when it is exactly 'H' (cached/unflagged). 'S' is
 * skip-worktree; a lowercase tag is assume-unchanged; both hide working-tree modifications from
 * `git status`. Anything that is not 'H' is refused.
 */
export function isBoundIndexTagSafe(tag: string | undefined): boolean {
  return tag === 'H';
}

/**
 * Normalize ONLY the CRLF pair to LF so the HEAD-blob compare tolerates this repo's mixed line
 * endings WITHOUT masking a lone carriage return. Round-9's first attempt stripped EVERY `\r`,
 * which was itself a bypass: a lone U+000D is a JavaScript/TypeScript LineTerminator, so an
 * attacker could insert one lone CR to end a `//` comment early (turning comment prose into
 * executed code) or trigger ASI — invisibly to a strip-all-CR compare. Collapsing only the `\r\n`
 * PAIR erases genuine line-ending-style differences (the sole normalization this repo applies)
 * while a lone CR survives and is caught as a content tamper. Verified by the adversarial
 * "lone-CR relineation" fixture in the smoke.
 */
export function normalizeLineEndings(buf: Buffer): Buffer {
  return Buffer.from(buf.toString('latin1').replace(/\r\n/g, '\n'), 'latin1');
}

export type BoundFileFact = {
  path: string;
  tag: string | undefined;   // undefined = not present in `git ls-files -v` (untracked)
  headBlob: Buffer | null;   // null = not present at HEAD
  disk: Buffer | null;       // null = missing on disk
};

/**
 * The pure decision: given the collected git facts for the bound closure, return the list of
 * binding failures (empty = the executed source is bound to HEAD). Fail-closed on every ambiguity.
 */
export function sourceBindingFailures(facts: BoundFileFact[]): string[] {
  const failures: string[] = [];
  if (facts.length === 0) {
    return ['source binding ran over an EMPTY file closure — refusing (nothing was actually bound)'];
  }
  for (const f of facts) {
    if (f.disk === null) {
      failures.push('bound source ' + f.path + ' is missing on disk — cannot bind to the reviewed commit');
      continue;
    }
    if (f.headBlob === null) {
      failures.push('bound source ' + f.path + ' is not present at HEAD (untracked/renamed) — cannot bind to the reviewed commit');
      continue;
    }
    if (!isBoundIndexTagSafe(f.tag)) {
      failures.push('bound source ' + f.path + ' carries a hidden git index flag (ls-files -v tag "'
        + String(f.tag) + '": skip-worktree/assume-unchanged) — a flagged file can be modified while '
        + 'git status stays clean; refusing');
      continue;
    }
    if (!normalizeLineEndings(f.headBlob).equals(normalizeLineEndings(f.disk))) {
      failures.push('bound source ' + f.path + ' DIFFERS from its HEAD blob (content tamper) — the '
        + 'executed source is not the reviewed commit');
    }
  }
  return failures;
}

/**
 * Extract the first-party (relative) import/require specifiers from a module's source — the ones
 * beginning './' or '../'. External packages (postgres, node:*) are ignored. The smoke walks these
 * transitively from the packet and asserts every reachable module is in BOUND_SOURCE_CLOSURE, so a
 * new acceptance-critical import cannot silently escape the binding.
 */
export function extractRelativeImports(source: string): string[] {
  const out: string[] = [];
  const re = /(?:from|import|require)\s*\(?\s*['"](\.[^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) out.push(m[1]!);
  return out;
}
