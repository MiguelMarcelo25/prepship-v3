# Audit 5.5 — Multi-instance readiness

## Architecture placement / source-of-truth gate

- **Business rule/workflow being changed:** Equivalent live rate workflows
  must not fan out twice across API/worker replicas; explicit and ingest rate
  backfills must survive process exit and execute in one fleet lane; concurrent
  automated Best Rate writes must preserve the no-downgrade rule atomically.
- **Canonical backend/domain/read-model/policy owner:** PostgreSQL advisory
  reservation plus `rate_browse_jobs` owns Rate Browser admission; pg-boss plus
  the cross-process sync-lane advisory lock owns backfill admission/execution;
  `best-rate-ratchet.ts` owns the decision and
  `best-rate-ratchet-db.ts` owns its compare-and-swap persistence boundary.
- **Current duplicated/unsafe owners:** The old ingest/manual backfill `Set`,
  arrays, and module-local active ID admitted work independently per process;
  Rate Browser's lock-busy branch deliberately started an independent job; the
  ratchet read and unconditional upsert could race another instance.
- **Where bad/stale/incomplete data can enter:** Two replicas can observe no
  active job before either persists, a worker can lose targeted IDs when a
  shared lane is busy, a process can restart after in-memory admission, and two
  automated writers can read the same prior Best Rate before either writes.
- **Callers that must delegate to the owner:** Rate routes, order/package
  mutation routes, product default saves, and normalized store import await the
  durable backfill producer. Rate Browser callers reserve through the durable
  store. Backfill and strict-recalculate writers call the atomic ratchet.
- **Wrapper/resolver/helper logic to delete or explicitly forbid:** No
  process-local authoritative ingest queue, no lock-busy independent provider
  fan-out, no automated read-then-upsert ratchet, and no frontend coordination
  or money decision are allowed.
- **Frontend role: display/action only; no authoritative business logic:** No
  frontend change. Existing polling renders durable backend snapshots and sends
  operator intent only.
- **Backend boundary tests required:** The focused guard runs the real ratchet
  against in-memory PostgreSQL, including two concurrent same-input quotes, and
  statically pins pg-boss admission, payload-preserving deferral, blocking
  Rate Browser reservation, fail-closed admission, and bounded telemetry.
- **Workflow/UI proof required:** Typecheck, production build, focused rate and
  coordination guards, mandatory SOT pack, and the full offline test suite must
  pass. No browser change requires new UI proof.

## Per-instance state inventory

| State | Classification | Fleet authority / bound |
|---|---|---|
| `rates-backfill.ts` execution promises, active/latest IDs, job map | Worker-local telemetry only | pg-boss + sync-lane lock own admission; completed entries prune to 25 |
| Rate-on-ingest and explicit backfill requests | Durable authority | pg-boss payload stores exact targeted IDs; busy-lane deferral preserves payload |
| Backfill producer connection promise | Local transport lifecycle | one pg-boss connection per process; PostgreSQL job row remains authoritative |
| `rate-browse-singleflight.ts` in-flight map | Local optimization | entries delete on settle; durable outer reservation owns fleet dedupe |
| `rate-browse-job-store.ts` reservation | Durable authority | blocking PostgreSQL advisory lock, recheck, then durable insert |
| Best Rate no-downgrade persistence | Durable authority | optimistic JSONB compare-and-swap retries after a lost race |
| Scheduler handler booleans and lane map | Local telemetry/fast guard | pg-boss plus PostgreSQL lane advisory locks own cross-process admission |
| TTL rate/account caches | Local optimization | bounded by TTL/size; never official purchased/selected-rate truth |
| Print merge/send active maps | Local optimization | durable print job tables own lifecycle and recovery |

Per the current-conversation `unlock shipped data` override, protected shared
order/import routes changed only to await the durable awaiting-only rate lane.
No shipped/cancelled guard was weakened. No production rows, labels, postage,
provider purchases, marketplace notifications, or inventory were mutated.
