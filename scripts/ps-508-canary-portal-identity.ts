/**
 * PS-508 — the Portal-provenance and executed-source owners for the canary packet, extracted as
 * pure, testable functions (Hermes round-8). Both the evidence packet and its smoke import from
 * here; neither redefines the logic, so a test can exercise the exact code the activation path
 * runs WITHOUT importing the packet (which self-invokes main() on load).
 *
 * Round-7 established why Portal provenance goes through the GitHub REST API, not a git fetch:
 * git rewrites command-line URLs through url.<base>.insteadOf in the operator-supplied clone, and
 * GIT_NO_REPLACE_OBJECTS does not disable that rewriting — a doctored clone could redirect the
 * "hardcoded" remote and publish a forged descendant. The REST API cannot be redirected by any
 * git configuration: it is a plain fetch() to api.github.com with redirect:'error'.
 *
 * Round-8 closed the last redirect seam: the previous PS508_PORTAL_API_BASE env override was the
 * REST equivalent of that git-config redirect (point the base at a stub and any claim passes). It
 * is REMOVED. The activation path passes the immutable PORTAL_OFFICIAL_API constant below as the
 * apiBase argument; apiBase is a parameter only so tests can drive a local stub. There is NO env
 * seam: verifyPortalViaApi reads nothing from process.env, so no environment variable consumed by
 * the activation binary can redirect verification.
 */

/**
 * The IMMUTABLE official GitHub API base for Portal provenance. Activation uses ONLY this value;
 * it is never read from the environment.
 */
export const PORTAL_OFFICIAL_API =
  'https://api.github.com/repos/drprepperusa-org/client-portal-prepship';

export type PortalVerifyResult = { ok: true } | { ok: false; reason: string };

/**
 * Pure (apiBase, token, portalSha, mirrorSha, predicatePath are all parameters) so it is
 * unit-testable WITHOUT any env seam on the activation path. The whole REST sequence is wrapped
 * so every fetch/JSON failure normalizes into a fail-closed PortalVerifyResult, and the predicate
 * is compared as RAW BYTES (not a UTF-8 round-trip). What is machine-verified: the attested SHA
 * EXISTS on GitHub (published), the mirror commit is an ancestor of it (compare), and the
 * predicate file is byte-identical at both SHAs (contents). Deployed-ness of the attested SHA
 * remains an OPERATOR ATTESTATION — no live Portal version endpoint exists to read.
 */
export async function verifyPortalViaApi(input: {
  portalSha: string; token: string; apiBase: string; mirrorSha: string; predicatePath: string;
}): Promise<PortalVerifyResult> {
  const headers: Record<string, string> = {
    authorization: 'Bearer ' + input.token,
    accept: 'application/vnd.github+json',
    'user-agent': 'ps508-canary-packet',
    'x-github-api-version': '2022-11-28',
  };
  const get = (p: string) => fetch(input.apiBase + p, {
    headers, redirect: 'error', signal: AbortSignal.timeout(15_000),
  });
  try {
    // 1. Published: the attested SHA must exist as a commit on GitHub (404 -> never pushed).
    const commitRes = await get('/commits/' + input.portalSha);
    if (commitRes.status === 404) {
      return { ok: false, reason: 'PORTAL-SHA-UNPUBLISHED: GitHub has no commit ' + input.portalSha
        + ' in the official repository — an unpushed local commit cannot attest a deployment' };
    }
    if (commitRes.status !== 200) {
      return { ok: false, reason: 'PORTAL-API-ERROR: /commits returned HTTP ' + commitRes.status };
    }
    // 2. Ancestry: the embedded mirror must be an ancestor of the attested SHA.
    const cmpRes = await get('/compare/' + input.mirrorSha + '...' + input.portalSha);
    if (cmpRes.status !== 200) {
      return { ok: false, reason: 'PORTAL-API-ERROR: /compare returned HTTP ' + cmpRes.status };
    }
    const cmp = (await cmpRes.json()) as { status?: string };
    if (cmp.status !== 'ahead' && cmp.status !== 'identical') {
      return { ok: false, reason: 'PORTAL-MIRROR-STALE: the embedded mirror commit '
        + input.mirrorSha.slice(0, 7) + ' is not an ancestor of the attested Portal SHA (compare status '
        + String(cmp.status) + ')' };
    }
    // 3. Predicate identity: byte-identical at mirror and attested SHA. Require a base64 FILE
    //    response and compare raw bytes (a UTF-8 round-trip could mask a binary difference).
    const bytesAt = async (ref: string): Promise<Buffer | { err: string }> => {
      const r = await get('/contents/' + input.predicatePath + '?ref=' + ref);
      if (r.status !== 200) return { err: 'HTTP ' + r.status + ' at ref ' + ref };
      const j = (await r.json()) as { content?: string; encoding?: string; type?: string };
      if (j.type !== 'file' || j.encoding !== 'base64' || typeof j.content !== 'string') {
        return { err: 'unexpected contents shape at ref ' + ref };
      }
      return Buffer.from(j.content, 'base64');
    };
    const [atMirror, atDeployed] = await Promise.all([bytesAt(input.mirrorSha), bytesAt(input.portalSha)]);
    if ('err' in atMirror) return { ok: false, reason: 'PORTAL-API-ERROR: ' + atMirror.err };
    if ('err' in atDeployed) return { ok: false, reason: 'PORTAL-API-ERROR: ' + atDeployed.err };
    if (!atMirror.equals(atDeployed)) {
      return { ok: false, reason: 'PORTAL-MIRROR-STALE: ' + input.predicatePath
        + ' CHANGED between the embedded mirror commit and the attested Portal SHA — re-embed the predicate first' };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: 'PORTAL-API-UNREACHABLE: ' + String(e).slice(0, 120) };
  }
}

/**
 * Round-8: the packet must BE the reviewed commit, not just claim its HEAD. `git rev-parse HEAD`
 * returns the committed SHA even with uncommitted working-tree edits, so a modified packet could
 * run while attesting a clean SHA. A clean whole-worktree gate is the simple, safe closure: given
 * `git status --porcelain` output, the tree is clean only when no path is dirty.
 */
export function worktreeIdentity(porcelain: string): { clean: boolean; dirtyPaths: string[] } {
  const dirtyPaths = porcelain.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return { clean: dirtyPaths.length === 0, dirtyPaths };
}
