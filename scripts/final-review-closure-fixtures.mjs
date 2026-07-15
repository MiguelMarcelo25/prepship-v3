#!/usr/bin/env node
/**
 * PS-429 offline acceptance fixtures plus changed-packet CI validation.
 */
import assert from 'node:assert/strict';
import {
  EVIDENCE_CLASSIFICATIONS,
  RISK_PROFILES,
  changedPacketPaths,
  evaluateClosurePacket,
  readClosurePacket,
  validatePacketAgainstRepository,
} from './final-review-closure.mjs';

const REVIEWED_SHA = 'a'.repeat(40);

function parseArgs(argv) {
  const options = { repository: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--packet') options.packet = argv[++index];
    else if (arg === '--sha') options.sha = argv[++index];
    else if (arg === '--branch') options.branch = argv[++index];
    else if (arg === '--repository') options.repository = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function evidence(id, classification, assertions = []) {
  return {
    id,
    classification,
    command: `offline fixture command for ${id}`,
    result: 'pass',
    artifactPaths: [`artifacts/final-review/${id}.txt`],
    assertions,
    proves: `${classification} evidence for ${id}`,
  };
}

function packetFor(riskDomains, options = {}) {
  const requiredClasses = new Set(
    riskDomains.flatMap((domain) => RISK_PROFILES[domain].requiredClasses),
  );
  const requiredAssertions = riskDomains.flatMap(
    (domain) => RISK_PROFILES[domain].requiredAssertions,
  );
  const proof = [...requiredClasses].map((classification, index) => evidence(
    `evidence-${index + 1}`,
    classification,
    requiredAssertions,
  ));
  const timingLive = riskDomains.includes('timing_live');

  return {
    $schema: 'docs/final-review/evidence-packet.schema.json',
    schemaVersion: 1,
    taskId: options.taskId ?? 'PS-429',
    title: options.title ?? 'Complete fixture',
    target: {
      branch: 'prepshipv4-stable',
      reviewedSha: REVIEWED_SHA,
    },
    riskDomains,
    claimedScore: options.claimedScore ?? 95,
    acceptanceCriteria: [{
      id: 'AC-1',
      severity: 'critical',
      status: 'met',
      description: 'The fixture supplies every evidence tier and risk assertion.',
      evidenceIds: proof.map((entry) => entry.id),
    }],
    architecture: {
      canonicalOwners: ['scripts/final-review-closure.mjs#evaluateClosurePacket'],
      oldOwners: [],
      wrappers: [],
      sotBypass: {
        present: false,
        details: 'No source-of-truth bypass is present.',
      },
    },
    evidence: proof,
    migrations: {
      touched: false,
      paths: [],
      verification: {
        command: 'No migrations; not applicable.',
        result: 'not-applicable',
        artifactPaths: [],
      },
      rollbackPlan: 'Revert the process-only commit; no data migration is involved.',
    },
    rollback: {
      strategy: 'Revert the process-only commit.',
      tested: false,
      evidenceIds: [],
    },
    liveVerification: timingLive ? {
      status: 'verified',
      reason: 'The fixture represents a verified staging run.',
      followUpOwner: null,
      artifactPaths: ['artifacts/final-review/staging-run.txt'],
    } : {
      status: 'not-required',
      reason: 'This risk profile does not require timing/live proof.',
      followUpOwner: null,
      artifactPaths: [],
    },
    caveats: [],
  };
}

function staticOnlyPacket(taskId, riskDomain) {
  const packet = packetFor([riskDomain], { taskId, title: `${taskId} false-green fixture` });
  packet.evidence = [evidence(
    'static-breadcrumb',
    'static',
    RISK_PROFILES[riskDomain].requiredAssertions,
  )];
  packet.acceptanceCriteria[0].evidenceIds = ['static-breadcrumb'];
  return packet;
}

function codes(entries) {
  return new Set(entries.map((entry) => entry.code));
}

function runCase(name, packet, expected, options = {}) {
  const result = evaluateClosurePacket(packet, options);
  assert.equal(result.closureStatus, expected.status, `${name}: closure status`);
  assert.equal(result.scoreCap, expected.cap, `${name}: score cap`);
  assert.equal(result.hermesGreenEligible, expected.eligible, `${name}: Hermes eligibility`);
  const actualCodes = new Set([...codes(result.errors), ...codes(result.blockers)]);
  for (const expectedCode of expected.codes ?? []) {
    assert(actualCodes.has(expectedCode), `${name}: missing ${expectedCode}`);
  }
  console.log(`PASS fixture ${name} (${result.closureStatus}, cap ${result.scoreCap})`);
}

const completeAllProfiles = packetFor(Object.keys(RISK_PROFILES));
runCase('complete-all-risk-profiles', completeAllProfiles, {
  status: 'complete', cap: 100, eligible: true,
});

for (const riskDomain of Object.keys(RISK_PROFILES)) {
  runCase(`complete-${riskDomain}`, packetFor([riskDomain]), {
    status: 'complete', cap: 100, eligible: true,
  });
}

const malformed = packetFor(['governance']);
delete malformed.taskId;
runCase('malformed-packet', malformed, {
  status: 'invalid', cap: 0, eligible: false, codes: ['MALFORMED_PACKET'],
});

runCase('stale-sha', packetFor(['governance']), {
  status: 'invalid', cap: 0, eligible: false, codes: ['SHA_MISMATCH'],
}, { expectedSha: 'b'.repeat(40) });

runCase('wrong-target-branch', packetFor(['governance']), {
  status: 'invalid', cap: 0, eligible: false, codes: ['TARGET_BRANCH_MISMATCH'],
}, { expectedBranch: 'another-target' });

runCase('PS-333-static-only-auth-scope', staticOnlyPacket('PS-333', 'auth_scope'), {
  status: 'blocked', cap: 88, eligible: false,
  codes: ['REQUIRED_EVIDENCE_CLASS_MISSING', 'RISK_ASSERTION_MISSING', 'FALSE_GREEN_SCORE_CLAIM'],
});

runCase('PS-350-static-only-provider-job', staticOnlyPacket('PS-350', 'provider_durable_job'), {
  status: 'blocked', cap: 88, eligible: false,
  codes: ['REQUIRED_EVIDENCE_CLASS_MISSING', 'RISK_ASSERTION_MISSING', 'FALSE_GREEN_SCORE_CLAIM'],
});

runCase('PS-351-static-only-provider-job', staticOnlyPacket('PS-351', 'provider_durable_job'), {
  status: 'blocked', cap: 88, eligible: false,
  codes: ['REQUIRED_EVIDENCE_CLASS_MISSING', 'RISK_ASSERTION_MISSING', 'FALSE_GREEN_SCORE_CLAIM'],
});

const sotBypass = packetFor(['governance']);
sotBypass.architecture.sotBypass = {
  present: true,
  details: 'A convenience wrapper still owns policy.',
};
runCase('source-of-truth-bypass', sotBypass, {
  status: 'blocked', cap: 74, eligible: false,
  codes: ['UNRESOLVED_SOT_BYPASS', 'FALSE_GREEN_SCORE_CLAIM'],
});

const unmetHigh = packetFor(['governance']);
unmetHigh.acceptanceCriteria[0].severity = 'high';
unmetHigh.acceptanceCriteria[0].status = 'unmet';
runCase('unmet-high-acceptance', unmetHigh, {
  status: 'blocked', cap: 74, eligible: false,
  codes: ['UNMET_ACCEPTANCE_CRITERION', 'FALSE_GREEN_SCORE_CLAIM'],
});

runCase('complete-score-not-above-90', packetFor(['governance'], { claimedScore: 90 }), {
  status: 'complete', cap: 100, eligible: false,
});

const liveUnverified = packetFor(['timing_live']);
liveUnverified.evidence = [
  evidence('review-breadcrumb', 'static', ['staging_or_live_artifact']),
  {
    ...evidence('pending-live-run', 'live', ['staging_or_live_artifact']),
    result: 'not-run',
  },
];
liveUnverified.acceptanceCriteria[0].evidenceIds = ['review-breadcrumb'];
liveUnverified.liveVerification = {
  status: 'unverified',
  reason: 'The staging timing window has not occurred yet.',
  followUpOwner: 'release-operator',
  artifactPaths: [],
};
runCase('explicit-live-unverified-block', liveUnverified, {
  status: 'blocked', cap: 88, eligible: false,
  codes: ['LIVE_EVIDENCE_UNVERIFIED', 'NON_PASSING_EVIDENCE', 'FALSE_GREEN_SCORE_CLAIM'],
});

assert.deepEqual(
  [...EVIDENCE_CLASSIFICATIONS],
  ['static', 'unit', 'integration', 'adversarial', 'failure-injection', 'e2e', 'live'],
  'Evidence taxonomy changed without updating PS-429 fixtures.',
);

const cliOptions = parseArgs(process.argv.slice(2));
if (cliOptions.packet) {
  const packet = readClosurePacket(cliOptions.packet);
  const result = cliOptions.repository
    ? validatePacketAgainstRepository(packet, {
        expectedSha: cliOptions.sha,
        expectedBranch: cliOptions.branch,
      })
    : evaluateClosurePacket(packet, {
        expectedSha: cliOptions.sha,
        expectedBranch: cliOptions.branch,
      });
  assert(result.hermesGreenEligible, `${cliOptions.packet}: ${JSON.stringify(result)}`);
  console.log(`PASS requested packet ${cliOptions.packet} (${result.reviewedSha})`);
}

const changedSince = process.env.FINAL_REVIEW_CHANGED_SINCE;
if (changedSince && !/^0{40}$/.test(changedSince)) {
  const changedPackets = changedPacketPaths(changedSince);
  for (const path of changedPackets) {
    const result = validatePacketAgainstRepository(readClosurePacket(path), {
      expectedBranch: process.env.FINAL_REVIEW_TARGET_BRANCH,
    });
    assert(result.hermesGreenEligible, `${path}: ${JSON.stringify(result)}`);
    console.log(`PASS repository packet ${path} (${result.reviewedSha})`);
  }
}

console.log('PS-429 Final Review closure fixtures passed.');
