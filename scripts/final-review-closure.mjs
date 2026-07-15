#!/usr/bin/env node
/**
 * PS-429 canonical Final Review closure-packet validator.
 *
 * Offline/process-only: reads JSON and git metadata. It never imports product
 * runtime, opens a database, calls a provider, or mutates production state.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';

export const FINAL_REVIEW_SCHEMA_VERSION = 1;

export const EVIDENCE_CLASSIFICATIONS = [
  'static',
  'unit',
  'integration',
  'adversarial',
  'failure-injection',
  'e2e',
  'live',
];

export const RISK_PROFILES = Object.freeze({
  auth_scope: {
    requiredClasses: ['integration', 'adversarial'],
    requiredAssertions: ['negative_role_resource_matrix', 'no_side_effect_on_rejection'],
  },
  rate_label: {
    requiredClasses: ['integration', 'adversarial'],
    requiredAssertions: [
      'cross_order_rejected',
      'cross_account_rejected',
      'fact_mismatch_rejected',
      'provider_spy_untouched',
    ],
  },
  provider_durable_job: {
    requiredClasses: ['integration', 'adversarial', 'failure-injection'],
    requiredAssertions: [
      'crash_recovery',
      'lost_response_reconciliation',
      'restart_idempotency',
      'concurrency_single_effect',
      'fencing_stale_worker_rejected',
    ],
  },
  billing_inventory_lifecycle: {
    requiredClasses: ['integration', 'adversarial'],
    requiredAssertions: ['migrated_db_fixture', 'cardinality', 'idempotency', 'repeat_run'],
  },
  timing_live: {
    requiredClasses: ['live'],
    requiredAssertions: ['staging_or_live_artifact'],
  },
  governance: {
    requiredClasses: ['unit', 'adversarial', 'failure-injection'],
    requiredAssertions: ['malformed_rejected', 'sha_drift_rejected', 'false_green_score_caps'],
  },
});

const nonEmptyString = z.string().trim().min(1);
const nullableNonEmptyString = nonEmptyString.nullable();
const shaSchema = z.string().regex(/^[0-9a-f]{40}$/i, 'must be an exact 40-character git SHA');
const resultSchema = z.enum(['pass', 'fail', 'blocked', 'not-run', 'not-applicable']);

const evidenceSchema = z.object({
  id: nonEmptyString,
  classification: z.enum(EVIDENCE_CLASSIFICATIONS),
  command: nonEmptyString,
  result: resultSchema,
  artifactPaths: z.array(nonEmptyString).min(1),
  assertions: z.array(nonEmptyString),
  proves: nonEmptyString,
}).strict();

const criterionSchema = z.object({
  id: nonEmptyString,
  severity: z.enum(['critical', 'high', 'medium', 'low']),
  status: z.enum(['met', 'unmet', 'blocked']),
  description: nonEmptyString,
  evidenceIds: z.array(nonEmptyString).min(1),
}).strict();

const architectureSchema = z.object({
  canonicalOwners: z.array(nonEmptyString).min(1),
  oldOwners: z.array(z.object({
    path: nonEmptyString,
    disposition: z.enum(['deleted', 'delegated', 'retained-with-caveat', 'none']),
    delegatesTo: nullableNonEmptyString,
  }).strict()),
  wrappers: z.array(z.object({
    path: nonEmptyString,
    action: z.enum(['added', 'modified', 'deleted', 'forbidden', 'none']),
    delegatesTo: nullableNonEmptyString,
  }).strict()),
  sotBypass: z.object({
    present: z.boolean(),
    details: nonEmptyString,
  }).strict(),
}).strict();

const migrationsSchema = z.object({
  touched: z.boolean(),
  paths: z.array(nonEmptyString),
  verification: z.object({
    command: nonEmptyString,
    result: resultSchema,
    artifactPaths: z.array(nonEmptyString),
  }).strict(),
  rollbackPlan: nonEmptyString,
}).strict();

const rollbackSchema = z.object({
  strategy: nonEmptyString,
  tested: z.boolean(),
  evidenceIds: z.array(nonEmptyString),
}).strict();

const liveVerificationSchema = z.object({
  status: z.enum(['verified', 'unverified', 'not-required']),
  reason: nonEmptyString,
  followUpOwner: nullableNonEmptyString,
  artifactPaths: z.array(nonEmptyString),
}).strict();

const caveatSchema = z.object({
  id: nonEmptyString,
  severity: z.enum(['critical', 'high', 'medium', 'low']),
  status: z.enum(['open', 'closed']),
  description: nonEmptyString,
  followUpOwner: nullableNonEmptyString,
  followUpTask: nullableNonEmptyString,
}).strict();

export const finalReviewClosurePacketSchema = z.object({
  $schema: nonEmptyString,
  schemaVersion: z.literal(FINAL_REVIEW_SCHEMA_VERSION),
  taskId: z.string().regex(/^(PS|CP)-\d+$/),
  title: nonEmptyString,
  target: z.object({
    branch: nonEmptyString,
    reviewedSha: shaSchema,
  }).strict(),
  riskDomains: z.array(z.enum(Object.keys(RISK_PROFILES))).min(1),
  claimedScore: z.number().int().min(0).max(100),
  acceptanceCriteria: z.array(criterionSchema).min(1),
  architecture: architectureSchema,
  evidence: z.array(evidenceSchema).min(1),
  migrations: migrationsSchema,
  rollback: rollbackSchema,
  liveVerification: liveVerificationSchema,
  caveats: z.array(caveatSchema),
}).strict();

function issue(code, message, details = undefined) {
  return details === undefined ? { code, message } : { code, message, details };
}

function uniqueDuplicates(values) {
  const seen = new Set();
  const duplicates = new Set();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates];
}

function blockedResult(packet, errors, blockers) {
  const invalid = errors.length > 0;
  const cap74 = blockers.some((entry) => entry.scoreCap === 74);
  const scoreCap = invalid ? 0 : cap74 ? 74 : blockers.length > 0 ? 88 : 100;
  const closureStatus = invalid ? 'invalid' : blockers.length > 0 ? 'blocked' : 'complete';
  const hermesGreenEligible =
    closureStatus === 'complete' && packet?.claimedScore > 90 && scoreCap > 90;
  return {
    schemaVersion: FINAL_REVIEW_SCHEMA_VERSION,
    taskId: packet?.taskId ?? null,
    reviewedSha: packet?.target?.reviewedSha ?? null,
    closureStatus,
    scoreCap,
    claimedScore: packet?.claimedScore ?? null,
    hermesGreenEligible,
    errors,
    blockers: blockers.map(({ scoreCap: _scoreCap, ...entry }) => entry),
  };
}

export function evaluateClosurePacket(input, options = {}) {
  const parsed = finalReviewClosurePacketSchema.safeParse(input);
  if (!parsed.success) {
    return blockedResult(input, [issue(
      'MALFORMED_PACKET',
      'Closure packet does not match schema version 1.',
      parsed.error.issues.map((entry) => ({ path: entry.path.join('.'), message: entry.message })),
    )], []);
  }

  const packet = parsed.data;
  const errors = [];
  const blockers = [];
  const expectedSha = String(options.expectedSha ?? '').trim().toLowerCase();
  if (expectedSha && packet.target.reviewedSha.toLowerCase() !== expectedSha) {
    errors.push(issue('SHA_MISMATCH', 'Packet SHA does not match the exact reviewed target SHA.', {
      expectedSha,
      packetSha: packet.target.reviewedSha,
    }));
  }
  const expectedBranch = String(options.expectedBranch ?? '').trim();
  if (expectedBranch && packet.target.branch !== expectedBranch) {
    errors.push(issue('TARGET_BRANCH_MISMATCH', 'Packet target branch does not match the review target.', {
      expectedBranch,
      packetBranch: packet.target.branch,
    }));
  }

  const evidenceDuplicates = uniqueDuplicates(packet.evidence.map((entry) => entry.id));
  if (evidenceDuplicates.length) {
    errors.push(issue('DUPLICATE_EVIDENCE_ID', 'Evidence IDs must be unique.', evidenceDuplicates));
  }
  const criterionDuplicates = uniqueDuplicates(packet.acceptanceCriteria.map((entry) => entry.id));
  if (criterionDuplicates.length) {
    errors.push(issue('DUPLICATE_CRITERION_ID', 'Acceptance-criterion IDs must be unique.', criterionDuplicates));
  }
  const riskDuplicates = uniqueDuplicates(packet.riskDomains);
  if (riskDuplicates.length) {
    errors.push(issue('DUPLICATE_RISK_DOMAIN', 'Risk domains must be unique.', riskDuplicates));
  }

  const evidenceById = new Map(packet.evidence.map((entry) => [entry.id, entry]));
  for (const criterion of packet.acceptanceCriteria) {
    const missingIds = criterion.evidenceIds.filter((id) => !evidenceById.has(id));
    if (missingIds.length) {
      errors.push(issue('UNKNOWN_EVIDENCE_ID', `${criterion.id} references unknown evidence.`, missingIds));
      continue;
    }
    if (criterion.status === 'met') {
      const nonPassing = criterion.evidenceIds.filter((id) => evidenceById.get(id)?.result !== 'pass');
      if (nonPassing.length) {
        errors.push(issue('MET_CRITERION_WITHOUT_PASSING_EVIDENCE', `${criterion.id} is marked met without passing evidence.`, nonPassing));
      }
    }
    if (criterion.status !== 'met') {
      blockers.push({
        code: 'UNMET_ACCEPTANCE_CRITERION',
        message: `${criterion.id} (${criterion.severity}) is ${criterion.status}.`,
        scoreCap: ['critical', 'high'].includes(criterion.severity) ? 74 : 88,
      });
    }
  }

  for (const evidenceId of packet.rollback.evidenceIds) {
    if (!evidenceById.has(evidenceId)) {
      errors.push(issue('UNKNOWN_ROLLBACK_EVIDENCE_ID', 'Rollback references unknown evidence.', evidenceId));
    }
  }
  if (packet.rollback.tested) {
    const rollbackPass = packet.rollback.evidenceIds.some((id) => evidenceById.get(id)?.result === 'pass');
    if (!rollbackPass) {
      errors.push(issue('ROLLBACK_TEST_WITHOUT_EVIDENCE', 'Rollback is marked tested without passing evidence.'));
    }
  }

  if (packet.migrations.touched) {
    if (
      !packet.migrations.paths.length ||
      packet.migrations.verification.result !== 'pass' ||
      !packet.migrations.verification.artifactPaths.length
    ) {
      blockers.push({
        code: 'MIGRATION_PROOF_MISSING',
        message: 'Touched migrations require paths plus passing migrated-database verification artifacts.',
        scoreCap: 88,
      });
    }
    if (!packet.rollback.tested) {
      blockers.push({
        code: 'MIGRATION_ROLLBACK_UNTESTED',
        message: 'A migration-bearing packet requires tested rollback proof.',
        scoreCap: 88,
      });
    }
  } else if (packet.migrations.paths.length || packet.migrations.verification.result !== 'not-applicable') {
    errors.push(issue('MIGRATION_DECLARATION_CONFLICT', 'Migration fields conflict with touched=false.'));
  }

  if (packet.architecture.sotBypass.present) {
    blockers.push({
      code: 'UNRESOLVED_SOT_BYPASS',
      message: packet.architecture.sotBypass.details,
      scoreCap: 74,
    });
  }

  const passingEvidence = packet.evidence.filter((entry) => entry.result === 'pass');
  const passingClasses = new Set(passingEvidence.map((entry) => entry.classification));
  const behavioralAssertions = new Set(
    passingEvidence
      .filter((entry) => entry.classification !== 'static')
      .flatMap((entry) => entry.assertions),
  );

  for (const domain of packet.riskDomains) {
    const profile = RISK_PROFILES[domain];
    const missingClasses = profile.requiredClasses.filter((entry) => !passingClasses.has(entry));
    if (missingClasses.length) {
      blockers.push({
        code: 'REQUIRED_EVIDENCE_CLASS_MISSING',
        message: `${domain} is missing passing evidence classes: ${missingClasses.join(', ')}.`,
        scoreCap: 88,
      });
    }
    const missingAssertions = profile.requiredAssertions.filter((entry) => !behavioralAssertions.has(entry));
    if (missingAssertions.length) {
      blockers.push({
        code: 'RISK_ASSERTION_MISSING',
        message: `${domain} is missing behavioral assertions: ${missingAssertions.join(', ')}.`,
        scoreCap: 88,
      });
    }
  }

  const nonPassingEvidence = packet.evidence.filter((entry) => entry.result !== 'pass');
  if (nonPassingEvidence.length) {
    blockers.push({
      code: 'NON_PASSING_EVIDENCE',
      message: `Evidence is not green: ${nonPassingEvidence.map((entry) => `${entry.id}:${entry.result}`).join(', ')}.`,
      scoreCap: 88,
    });
  }

  if (packet.riskDomains.includes('timing_live')) {
    if (packet.liveVerification.status === 'unverified') {
      if (!packet.liveVerification.followUpOwner) {
        errors.push(issue('UNVERIFIED_LIVE_WITHOUT_OWNER', 'Explicit unverified live blocks require a follow-up owner.'));
      }
      blockers.push({
        code: 'LIVE_EVIDENCE_UNVERIFIED',
        message: packet.liveVerification.reason,
        scoreCap: 88,
      });
    } else if (packet.liveVerification.status !== 'verified') {
      errors.push(issue('LIVE_STATUS_INVALID_FOR_TIMING_RISK', 'timing_live must be verified or explicitly unverified.'));
    } else if (!packet.liveVerification.artifactPaths.length) {
      errors.push(issue('LIVE_ARTIFACT_MISSING', 'Verified live evidence requires at least one artifact path.'));
    }
  }

  for (const caveat of packet.caveats) {
    if (caveat.status === 'open') {
      if (!caveat.followUpOwner) {
        errors.push(issue('OPEN_CAVEAT_WITHOUT_OWNER', `${caveat.id} is open without a follow-up owner.`));
      }
      blockers.push({
        code: 'OPEN_CAVEAT',
        message: `${caveat.id} (${caveat.severity}): ${caveat.description}`,
        scoreCap: ['critical', 'high'].includes(caveat.severity) ? 74 : 88,
      });
    }
  }

  if (packet.claimedScore > 90 && blockers.length > 0) {
    blockers.push({
      code: 'FALSE_GREEN_SCORE_CLAIM',
      message: `Claimed score ${packet.claimedScore} exceeds the evidence-backed cap.`,
      scoreCap: blockers.some((entry) => entry.scoreCap === 74) ? 74 : 88,
    });
  }

  return blockedResult(packet, errors, blockers);
}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function withRepositoryError(result, code, message, details = undefined) {
  return blockedResult(
    { taskId: result.taskId, claimedScore: result.claimedScore, target: { reviewedSha: result.reviewedSha } },
    [...result.errors, issue(code, message, details)],
    result.blockers.map((entry) => ({ ...entry, scoreCap: result.scoreCap === 74 ? 74 : 88 })),
  );
}

export function validatePacketAgainstRepository(packet, options = {}) {
  let result = evaluateClosurePacket(packet, options);
  if (result.closureStatus === 'invalid') return result;
  const reviewedSha = packet.target.reviewedSha;
  try {
    git(['cat-file', '-e', `${reviewedSha}^{commit}`]);
  } catch {
    return withRepositoryError(result, 'REVIEWED_SHA_NOT_FOUND', 'Reviewed SHA is not available in git history.', reviewedSha);
  }
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', reviewedSha, 'HEAD'], { stdio: 'ignore' });
  } catch {
    return withRepositoryError(result, 'REVIEWED_SHA_NOT_ANCESTOR', 'Reviewed SHA is not an ancestor of HEAD.', reviewedSha);
  }
  const changedAfterReview = git(['diff', '--name-only', `${reviewedSha}..HEAD`])
    .split(/\r?\n/)
    .filter(Boolean);
  const nonPacketChanges = changedAfterReview.filter((path) => !path.replaceAll('\\', '/').startsWith('docs/final-review/packets/'));
  if (nonPacketChanges.length) {
    result = withRepositoryError(
      result,
      'SHA_DRIFT_AFTER_REVIEW',
      'Non-packet files changed after the reviewed SHA; create a new evidence packet for the new implementation SHA.',
      nonPacketChanges,
    );
  }
  return result;
}

export function readClosurePacket(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function changedPacketPaths(changedSince) {
  const base = String(changedSince ?? '').trim();
  if (!base) return [];
  const output = /^0{40}$/.test(base)
    ? git(['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD', '--', 'docs/final-review/packets'])
    : git(['diff', '--name-only', `${base}..HEAD`, '--', 'docs/final-review/packets']);
  return output
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.endsWith('.json'));
}

function parseArgs(argv) {
  const options = { repository: false, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--packet') options.packet = argv[++index];
    else if (arg === '--sha') options.sha = argv[++index];
    else if (arg === '--branch') options.branch = argv[++index];
    else if (arg === '--changed-since') options.changedSince = argv[++index];
    else if (arg === '--repository') options.repository = true;
    else if (arg === '--json') options.json = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function printResult(path, result, jsonOnly) {
  if (jsonOnly) {
    console.log(JSON.stringify({ packet: path, ...result }));
    return;
  }
  console.log(`${result.hermesGreenEligible ? 'PASS' : 'FAIL'} ${path}`);
  console.log(JSON.stringify(result, null, 2));
}

function runCli() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
  const paths = options.packet
    ? [options.packet]
    : changedPacketPaths(options.changedSince ?? process.env.FINAL_REVIEW_CHANGED_SINCE);
  if (!paths.length) {
    console.log(JSON.stringify({ closureStatus: 'not-applicable', changedPackets: 0 }));
    return;
  }
  let failed = false;
  for (const path of paths) {
    let result;
    try {
      const packet = readClosurePacket(path);
      result = options.repository || !options.packet
        ? validatePacketAgainstRepository(packet, {
            expectedSha: options.sha,
            expectedBranch: options.branch ?? process.env.FINAL_REVIEW_TARGET_BRANCH,
          })
        : evaluateClosurePacket(packet, {
            expectedSha: options.sha,
            expectedBranch: options.branch,
          });
    } catch (error) {
      result = blockedResult(null, [issue('PACKET_READ_FAILED', error instanceof Error ? error.message : String(error))], []);
    }
    printResult(path, result, options.json);
    if (!result.hermesGreenEligible) failed = true;
  }
  if (failed) process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli();
}
