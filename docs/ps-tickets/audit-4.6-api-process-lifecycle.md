# Audit 4.6 — API process lifecycle

## Architecture placement / source-of-truth gate

- **Business rule/workflow being changed:** The API must stop accepting new
  connections on SIGINT/SIGTERM, let active HTTP work drain within a bounded
  deadline, and restart after a bounded number of process-level failures escape
  normal request/background error handling.
- **Canonical backend/domain/read-model/policy owner:**
  `src/services/api-process-lifecycle.ts#createApiProcessLifecycle` owns the
  shutdown state machine, drain deadline, exit code, and escaped-failure count.
- **Current duplicated/unsafe owners:** `src/main.ts` logs unhandled rejections
  and uncaught exceptions forever, does not retain the server returned by
  `serve`, and has no SIGINT/SIGTERM handlers.
- **Where bad/stale/incomplete data can enter:** Node process signals and errors
  escaping every request, job, or detached-promise boundary first enter the two
  process event handlers in `src/main.ts`.
- **Callers that must delegate to the owner:** API SIGINT, SIGTERM,
  `unhandledRejection`, and `uncaughtException` handlers delegate directly to
  the lifecycle controller created for the listening server.
- **Wrapper/resolver/helper logic to delete or explicitly forbid:** Inline
  keep-alive-forever process-error policy and direct signal exits in `main.ts`
  are forbidden. There is one idempotent shutdown state machine.
- **Frontend role: display/action only; no authoritative business logic:** No
  frontend code or operator workflow changes.
- **Backend boundary tests required:** A fake HTTP server proves that signals
  stop admission once, active work delays exit until close completes, the third
  escaped failure opens the breaker, and a missed drain deadline force-closes
  connections with a non-zero exit.
- **Workflow/UI proof required:** Strict typecheck, production build, runtime
  schema readiness, structured logging, health-route, and full SOT guards pass.

This change is process-local and performs no database, provider, label/postage,
marketplace-notification, inventory, or shipped/cancelled mutation.
