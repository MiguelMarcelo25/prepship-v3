# PS-350 - Backend Rate Jobs

## Backend Owner

`src/services/rate-browse-workflow.ts` owns the Rate Browser job lifecycle. `src/services/rate-browse-job-store.ts` is the durable storage owner for job state and per-provider status rows. `src/services/rate-browse-response-producer.ts` remains the only owner of rate ranking, proof, house/customer tuple output, and the final browse DTO.

## Imperfect Data Injection

Bad rate UX first enters when multiple browser/manual actions, Recalculate flows, or backfill work start identical live provider fanout without a shared backend job identity. Before PS-350, `rate-browse-workflow-store.ts` persisted snapshots through the `settings` JSON blob, so duplicate API/worker processes had no durable request-key attachment point and no per-provider status rows.

## Route Contract

`POST /rates/browse/workflow` now starts or attaches to a durable backend rate-browse job. The route marks explicit Rate Browser work as `manual` priority, returns the backend job DTO quickly, and leaves the frontend as a renderer of `job_id`, `status`, `progress`, `result`, diagnostics, and backend-issued proof fields.

The workflow still returns cache-first partial state before live refresh work when `forceLive` is requested. Duplicate live starts for the same normalized request key attach to the active `rate_browse_jobs` row instead of launching a second provider fanout.

## Shared Provider Limit

The ShipStation shared limiter remains backend-owned in `src/lib/shipstation/durable-rate-limiter.ts` and is enabled with `RATE_LIMITER_BACKEND=durable`. This PS-350 slice adds durable job coordination around the Rate Browser workflow; provider call budgets still flow through the existing rate engine and limiter owners.

Manual Rate Browser and Print Queue preflight outrank background backfill in the job model by priority. The current route writes Rate Browser jobs as `manual`; future Print Queue preflight/backfill callers should pass `preflight` or `backfill` when they delegate to this owner.

## Durable State

The new additive runtime tables are:

- `rate_browse_jobs`: one row per durable backend browse job, including request key, priority, lifecycle status, progress counts, diagnostics, and snapshot JSON.
- `rate_browse_job_provider_statuses`: one row per provider/carrier status observed by a job, including source, carrier/account identifiers, status, rate count, duration, nullable limiter wait, and diagnostic JSON.

The old `settings` snapshots remain only as a legacy fallback for in-flight jobs that existed before this slice. New workflow reads try the durable job store first.

## Safety

This slice does not change rate ranking or selected-rate proof. Partial/failed carrier states remain diagnostics and cannot become purchasable unless the backend rate browse producer and quote snapshot owner return current proof.

No labels, postage, provider calls, queue mutation, billing, inventory, or shipped/cancelled mutation is performed by the PS-350 guard or documentation slice.

## Remaining canary proof

- Confirm on Render that `rate_browse_jobs` and `rate_browse_job_provider_statuses` are created.
- Run HUGRAB Rate Browser live refresh twice for the same package facts and confirm the second request attaches to the active job instead of starting duplicate fanout.
- Confirm provider diagnostics show cached/partial/live/failed statuses and that `/orders` is not repeatedly refetched just to show progress.
