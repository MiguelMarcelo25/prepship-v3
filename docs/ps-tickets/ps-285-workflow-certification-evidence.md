# PS-285 workflow certification evidence

Date: 2026-06-22

## Status

Current completion estimate: PS-285 70%.

This packet completes PS-285 phase 11, end-to-end certification matrix. It does
not make PS-285 Final Review-ready. The umbrella still has unfinished
verification harness, auth/scope conversion, lockdown preservation, and final
closeout phases.

## Certification Owners

The workflow certification evidence is owned by existing offline certification
artifacts:

- `docs/full-workflow-certification-matrix.md`
- `scripts/run-workflow-certification.mjs`
- `scripts/shipping-roundtrip-certification.mjs`
- `docs/shipping-certification-harness.md`
- `scripts/ps-285-workflow-certification-evidence-guard.ts`

## Proof

The current certification boundary proves the phase-11 requirements:

1. `npm run test:workflow-suites` is the offline behavioral core and does not
   require a server, live providers, or a real database.
2. The offline runner groups certification by workflow checkpoints A through P,
   plus backend authority and perimeter/ops safety ratchets.
3. The current run completed successfully with 81/81 suites passing.
4. Live and browser-required suites remain explicitly outside the offline runner.
5. The shipping roundtrip certification runner composes the offline workflow
   suites with safe fixture/mock shipping checks and supports `--notify-dry-run`
   for sanitized notification payload inspection.

## Commands

- `npm run test:workflow-suites`
- `npm run test:ps-285-workflow-certification-evidence`
- `npm run test:ps-285-phase-evidence-matrix`
- `npm run test:ps-285-umbrella-closeout`
- `git diff --check`
- `npm run typecheck`
- `npm run build:web`

## Excluded From This Packet

These commands are intentionally not part of this offline packet:

- `npm run test:full-site-certification`
- `npm run test:full-workflow-certification`
- `npm run smoke:shipping:real-label`
- `npm run marketplace:confirm:retry -- --live-approved`

Browser-required certification and live provider canaries still require the
right runtime setup or explicit DJ approval. They are not needed to complete
the offline phase-11 evidence.

## Safety Boundaries

This packet is offline/static except for running local guard commands. It does
not start a server, restart workers, enable live retry flags, create live
labels, buy postage, void labels, print labels, send marketplace notifications,
mutate production orders, mutate production queues, repair production data, or
modify shipped/cancelled data.

No Trello comment, card move, card creation, title edit, checklist edit, label
change, member change, archive, or deletion is authorized by this packet.
