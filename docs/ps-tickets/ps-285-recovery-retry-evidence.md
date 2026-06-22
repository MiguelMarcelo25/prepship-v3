# PS-285 recovery/retry tooling safety evidence

Date: 2026-06-22

## Status

Current completion estimate: PS-285 65%.

This packet completes PS-285 phase 9, recovery/retry tooling safety. It does
not make PS-285 Final Review-ready. The umbrella still has unfinished
verification harness, auth/scope conversion, lockdown preservation,
certification, and final closeout phases.

## Backend Owners

The recovery/retry safety evidence is owned by existing backend code and
guards:

- `src/lib/ops-confirm.ts`
- `scripts/migrate-supabase.ts`
- `src/services/worker-status-events.ts`
- `src/services/worker-status.ts`
- `src/services/sync-staleness-watchdog.ts`
- `src/lib/shipstation/durable-rate-limiter.ts`
- `src/services/print-queue-label-recovery.ts`
- `src/services/print-queue-secondary-ss-account.ts`
- `src/services/print-queue.ts`
- `scripts/ps-255-ops-confirm-gate-guard.ts`
- `scripts/ps-256-durable-worker-status-guard.ts`
- `scripts/ps-256-durable-rate-limiter-guard.ts`
- `scripts/ps-288-label-recovery-guard.ts`
- `scripts/ps-285-recovery-retry-evidence-guard.ts`

## Proof

The current backend boundary proves the phase-9 requirements:

1. Destructive ops scripts default to dry-run and require explicit
   `--apply`/`--confirm`; token-gated paths still block mismatched tokens.
2. Admin recovery routes remain mounted behind `requireAdmin`.
3. Durable worker status events are env-gated by
   `WORKER_STATUS_EVENTS_DURABLE`, default off, and the off path is a true
   no-op that does not touch the database.
4. Worker status emits heartbeat, job start, job complete, job failed, and
   staleness alert events as best-effort observations.
5. The durable ShipStation rate limiter is selected only by
   `RATE_LIMITER_BACKEND=durable`; the default in-memory limiter remains
   unchanged.
6. Label recovery reads existing ShipStation labels through exact matching and
   backfills only label URL/format. It does not call `createLabelV2` and
   therefore cannot buy duplicate postage during recovery.

Live retry/canary evidence is intentionally excluded from this offline packet.
Those actions require separate DJ approval because they can touch production
workers, queues, or provider state. This packet closes only the static/offline
recovery safety proof for PS-285.

## Commands

- `npm run test:ps-255-ops-confirm-gate`
- `npm run test:ps-256-durable-worker-status`
- `npm run test:ps-256-durable-rate-limiter`
- `npm run test:ps-288-label-recovery`
- `npm run test:ps-285-recovery-retry-evidence`
- `npm run test:ps-285-phase-evidence-matrix`
- `npm run test:ps-285-umbrella-closeout`
- `git diff --check`
- `npm run typecheck`
- `npm run build:web`

## Safety Boundaries

This packet is offline/static. It does not restart workers, enable live retry
flags, create live labels, buy postage, void labels, print labels, send
marketplace notifications, mutate production orders, mutate production queues,
repair production data, or modify shipped/cancelled data.

No Trello comment, card move, card creation, title edit, checklist edit, label
change, member change, archive, or deletion is authorized by this packet.
