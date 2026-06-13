# Draft cards — PS-209 follow-ups (A, B) + PS-211 per-provider voids

Drafted 2026-06-13 at DJ's request, from the PS-209 architecture audit
(docs/engineering/ps-209-shipping-architecture-audit.md) and the PS-211
universal-void architecture (commit dd52185d). Numbers PS-217/218/219 are
SUGGESTIONS — renumber to the tracker's next free IDs before posting.

---

## PS-217 — One canonical persistence owner for direct marketplace order import (audit follow-up A)

Assignee: <@714064895963955211>
Repo: https://github.com/drprepperusa-org/prepship-v4.git
Branch: prepshipv4-stable
Status: New task — follow-up A proposed by the PS-209 shipping architecture audit (ranked MEDIUM).

Copy/paste Codex prompt

You are working on PrepShip V4.
Task: PS-217 — Collapse imported-handler-local order persistence into ONE canonical owner.

Problem / audit evidence
The PS-209 audit (docs/engineering/ps-209-shipping-architecture-audit.md — read it FIRST,
it contains the file-level inventory) found that the direct marketplace import handlers
(Walmart / eBay store connectors' order-import paths) each carry HANDLER-LOCAL SQL for
persisting imported orders and store_orders rows. The upsert/dedupe/status-mapping logic
is duplicated per handler instead of delegating to a single owner — the same drift class
that let the legacy label endpoint diverge from v4. Today the copies agree; nothing
structural keeps them agreeing.

Architecture-first requirement
Read first: AGENTS.md, ARCHITECTURE.md, CONTRIBUTING.md, .github/pull_request_template.md,
docs/engineering/ps-209-shipping-architecture-audit.md.
Canonical owner: ONE backend service owns "persist an imported marketplace order"
(normalize → upsert orders + store_orders + items). Store connectors translate provider
payloads; they do not own persistence policy. Routes/sync jobs stay thin.

Implementation requirements
1. Extract a canonical persistImportedMarketplaceOrders service from the existing
   handler-local SQL. BEHAVIOR-PRESERVING: same dedupe key semantics
   (external_order_id uniqueness), same status mapping, same client/store attribution,
   same items replacement path (replaceOrderItemsForOrders or its existing owner), same
   source_provider/source_order_id stamping (recordOrderSourceIfNeeded compatibility).
2. Each import handler becomes a thin adapter: normalize provider payload → call the
   owner. Delete the duplicated SQL from the handlers once parity is proven.
3. Do NOT change sync cadence, scheduler wiring, webhook behavior, or order-status
   meaning. Do NOT touch shipped/cancelled rows beyond what the existing import already
   does (status refresh on upsert is existing behavior — preserve it exactly).
4. Fixture-parity proof: feed the SAME recorded provider payload through the old path
   (at base commit, via detached worktree) and the new owner — the persisted row shapes
   must be identical. Document any intentional delta explicitly.

Safety / lockdown
- Imports may update order rows including shipped ones (existing sync behavior) — this
  card REFACTORS placement only; if any code you must touch is inside the shipped
  lockdown surfaces named in AGENTS.md, stop and request the override phrase first.
- No marketplace notifications, no labels/postage, no production SQL UPDATE/DELETE by
  hand, no invoice/billing changes.

Required tests / guards
npm run test:ps-217-import-persistence-owner (new) proving:
- the owner module is the ONLY place with the orders/store_orders upsert SQL for
  imported orders (handlers contain none);
- behavioral fixture parity per provider (Walmart, eBay) — same input → same persisted
  shape (offline, mocked rows, no DB writes in the guard);
- dedupe: re-importing the same payload is idempotent;
- source_provider stamping preserved (PS-192's resolver depends on it).
Run and report: git status --short --branch, npm run typecheck,
npm run test:ps-217-import-persistence-owner, the existing store-connector +
confirmation guards (test:store-connector-source, test:ps-064-confirmation-outbox),
npm run build:web, full test:shipping-roundtrip-certification.

Definition of done
- One persistence owner; handlers are thin adapters with zero local upsert SQL.
- Fixture parity proven per provider; idempotent re-import proven.
- No sync/webhook/cadence/notification behavior change. Roundtrip cert green.
Return/update format: start every update with `PS-217 update:`.

---

## PS-218 — Label create→queue atomicity certification (audit follow-up B)

Assignee: <@714064895963955211>
Repo: https://github.com/drprepperusa-org/prepship-v4.git
Branch: prepshipv4-stable
Status: New task — follow-up B proposed by the PS-209 shipping architecture audit (ranked LOW-MEDIUM).

Copy/paste Codex prompt

You are working on PrepShip V4.
Task: PS-218 — Certify the label-purchase → persist → print-queue window against crashes.

Problem / audit evidence
createLabelV2 runs: provider purchase → persistCreatedLabel (shipments insert) →
markOrderShipped → deductions/outbox → (caller) add-to-print-queue. The PS-209 audit
flagged that the crash windows between these steps are UNCERTIFIED: if the process dies
after the provider charged postage but before the shipment row persists, or after
persist but before the queue insert, the recovery story is unproven (it may be fine —
dedupe keys and the outbox self-heal confirmations — but nothing PROVES the label/queue
side). This is a certification card, not a rewrite: "Do not turn it into a giant
rewrite" applies.

Architecture-first requirement
Read first: AGENTS.md, ARCHITECTURE.md, docs/engineering/ps-209-shipping-architecture-audit.md.
The invariant to certify (or implement the smallest recovery for): every PURCHASED label
eventually has a persisted shipment row, and every persisted-label order that should be
queued either is queued or is visibly recoverable — no silent money loss, no silent
missing-label-in-queue.

Implementation requirements
1. MAP the windows: purchase→persist, persist→markOrderShipped, persist→queue-add.
   Document each window's current failure behavior in a short section appended to the
   PS-209 audit doc (or a new docs/engineering/ps-218-atomicity-certification.md).
2. MOCKED crash-window tests (no live postage, no real DB requirement in guards):
   simulate "purchase returned, persist threw", "persist succeeded, queue-add threw",
   etc., against the real code paths with injected failures, and assert the recovery
   behavior (dedupe key prevents double-purchase on retry; the order surfaces as
   recoverable; nothing double-deducts inventory).
3. IF a window has NO recovery: implement the SMALLEST one — e.g. a reconciler sweep
   (existing scheduler patterns: env-gated, advisory-locked, observe-only first) that
   finds purchased-but-unpersisted (via provider dedupe key) or
   persisted-but-unqueued labels and reports/repairs them. Env-gated dark rollout,
   kill-switch default off, exactly like PS-056/PS-215 flag pairs.
4. FORBIDDEN: restructuring the purchase pipeline, wrapping provider HTTP in DB
   transactions, real labels/postage, marketplace notifications, shipped/cancelled
   mutations (recovery writes need DJ sign-off on exact scope before enabling).

Required tests / guards
npm run test:ps-218-label-queue-atomicity (new): the mocked crash-window matrix + pins
that the dedupe key covers the purchase retry path + (if built) the reconciler is
env-gated in BOTH scheduler paths (sync-scheduler + sync-job-queue — registering in only
one is the classic miss).
Run and report: typecheck, the new guard, test:print-queue-durable,
test:print-queue-client-scope, guard:shipping-certification, full
test:shipping-roundtrip-certification.

Definition of done
- Every window documented with its proven behavior; mocked crash tests pass.
- Any gap has the smallest env-gated recovery, observe-only by default.
- No purchase-flow restructure; cert stays green.
Return/update format: start every update with `PS-218 update:`.

---

## PS-219 — Direct-carrier void implementations (provider-by-provider, PS-211 follow-up)

Assignee: <@714064895963955211>
Repo: https://github.com/drprepperusa-org/prepship-v4.git
Branch: prepshipv4-stable
Status: New task — follow-up to PS-211 (dd52185d). PS-211 built the universal dispatch:
voids route to the OWNING provider, local void applies ONLY after provider success, and
unimplemented providers honestly return not_supported. This card implements the actual
provider void calls, one provider per slice.

Copy/paste Codex prompt

You are working on PrepShip V4.
Task: PS-219 — Implement voidLabel on the direct-carrier connectors so operators can
void/refund direct labels from PrepShip instead of the carrier portal.

Current architecture (PS-211 — do not re-litigate it)
- src/services/label-void-policy.ts routes a shipment row to its owning provider with a
  provider-native void key: selectedRateJson.providerLabelId (persisted since PS-211),
  tracking-number fallback for pre-PS-211 rows.
- voidLabelV2 dispatches via voidCarrierLabel(provider) and applies the local
  voided:true write ONLY after provider success ('provider_failed' leaves the row
  active). KEEP the ps-211 guard's source-order pin green.
- Capability honesty is DYNAMIC: scripts/ps-211-universal-void-guard.ts asserts the
  matrix advertises labels.void IFF the registry connector implements voidLabel. Each
  provider implementation = implement connector.voidLabel + re-add 'labels.void' to BOTH
  src/connectors/matrix.ts and the connector file's capabilities array, or the guard
  fails.

Slice order (one slice = one PR/commit, each independently shippable)
1. Direct UPS (ROCEL/ORION accounts) — UPS Shipping API void-shipment endpoint, keyed by
   the shipment identification number (1Z tracking). Highest refund value; we hold our
   own credentials. Map UPS responses: already-voided, not-voidable (manifested/too
   old), auth failures → the PS-211 statuses.
2. EasyPost — POST /v2/shipments/:id/refund (refund-request model: submission succeeds,
   refund resolves async). Decide + document the honest mapping: a submitted refund
   request = 'voided' locally (postage refund pending) vs a new 'refund_requested'
   status — prefer the smallest honest mapping and say so in the update.
3. Shipp — RESEARCH FIRST: confirm whether the Shipp API exposes label cancel/refund.
   If it does not, the slice's deliverable is the documented finding + the connector
   stays honestly not_supported (that is a VALID outcome, not a failure).
4. Walmart Shipping — same research-first gate as Shipp.

Implementation requirements (every slice)
- The connector's voidLabel receives CarrierVoidInput { labelId, trackingNumber } plus
  credentials the same way its createLabel does. Use the provider-native id; NEVER the
  locally-synthesized numeric labelShipmentId.
- Provider error → throw (the service classifies provider_failed and keeps the row
  active). Distinguish not-voidable provider responses where the API allows it.
- Mocked tests only: recorded/replay response fixtures through the real parser — no
  live void calls, no postage, no refunds in tests. The ps-219 guard must run offline.
- Update BOTH capability surfaces together (matrix.ts + connector capabilities) — the
  ps-211 dynamic guard enforces this.
- Do NOT touch voidLabelV2's ordering (dispatch → provider_failed exit → single local
  write), the route's status→HTTP mapping, or the test/local void paths.

Safety / lockdown
- Voiding writes shipments.voided + resets the order to awaiting_shipment — that is the
  EXISTING sanctioned void workflow; this card only adds provider calls BEFORE it.
  No other shipped/cancelled mutations. No live marketplace notifications.
- A real-money void against a live label is DJ's manual canary AFTER deploy, per
  provider — never part of CI/tests.

Required tests / guards
npm run test:ps-219-direct-void-<provider> per slice (e.g. test:ps-219-direct-void-ups):
fixture-driven behavioral cases (success → voided; already-voided; not-voidable;
auth/HTTP failure → provider_failed) + pins (provider-native key used, capability
surfaces updated together, ps-211 ordering untouched).
Run and report per slice: typecheck, the slice guard, test:ps-211-universal-void,
guard:shipping-certification, full test:shipping-roundtrip-certification.

Definition of done (per slice)
- Provider void works against recorded fixtures; statuses map honestly; ps-211 guard
  green (capability honesty + local-void-after-success preserved).
- Research slices (Shipp/Walmart) may close as "documented not_supported".
- DJ's live canary checklist included in the update (which label to void, expected
  refund window).
Return/update format: start every update with `PS-219 update:` and name the slice.
