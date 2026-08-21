export type RuntimeVersionIdentity = Readonly<{
  commitSha: string | null;
  commitSource: 'RENDER_GIT_COMMIT' | 'unknown';
  serviceId: string | null;
  instanceId: string | null;
}>;

const FULL_GIT_SHA = /^[0-9a-f]{40}$/i;

function nonEmpty(value: string | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

/**
 * Immutable deploy identity supplied by Render to each running process.
 *
 * A full SHA is required deliberately: operators use this value to prove that
 * the API and worker independently run the reviewed PS-502 commit. A shortened,
 * malformed, or absent value is reported as null instead of being mistaken for
 * deploy evidence.
 */
export function readRuntimeVersionIdentity(
  source: NodeJS.ProcessEnv = process.env,
): RuntimeVersionIdentity {
  const renderCommit = nonEmpty(source.RENDER_GIT_COMMIT);
  const commitSha = renderCommit && FULL_GIT_SHA.test(renderCommit)
    ? renderCommit.toLowerCase()
    : null;

  return Object.freeze({
    commitSha,
    commitSource: commitSha ? 'RENDER_GIT_COMMIT' : 'unknown',
    serviceId: nonEmpty(source.RENDER_SERVICE_ID),
    instanceId: nonEmpty(source.RENDER_INSTANCE_ID),
  });
}

// Captured once at process boot so the reported version cannot drift if a
// mutable process.env is changed by application code or a test after startup.
export const runtimeVersionIdentity = readRuntimeVersionIdentity();
