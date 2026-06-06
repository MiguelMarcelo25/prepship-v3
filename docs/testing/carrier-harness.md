# Carrier E2E Test Harness — Runbook

Prove that printing an order to the print queue succeeds with **zero bugs** across
the full frontend + backend pipeline, for **every carrier path and every
sub-carrier/service**, **without spending money, buying real postage, or notifying
any marketplace**.

Principle: **test order + real-carrier-equivalent = success ⇒ real order + real
carrier = success.**

> Plan of record: `~/.claude/plans/zany-spinning-hennessy.md`.
> Built in 7 slices; see commits `34987d66 … 9cd78baa`.

---

## The two label paths (why this exists)

| Path | Route | Safe test mode |
|---|---|---|
| **ShipStation** | Render `src/routes/labels.ts` → `createLabelV2` | `testLabel:true` — $0 mock, marks shipped |
| **4 direct carriers** (easypost/shipp/ups/walmart_shipping) | Vercel `api/carriers/labels.ts` | **none originally** — always real postage + in-request marketplace confirm |

The harness adds a safe test mode for the direct path via **one seam** in
`src/services/carrier-connector-orchestrator.ts` (wraps the single
`createLabel` call) — production behavior is byte-identical.

---

## Safety model (how money/marketplace are impossible in test mode)

1. **Double gate** — test mode is active only when BOTH `CARRIER_TEST_MODE` is set
   AND the per-call `__carrierTestMode === true` flag is present. Production never
   sets the flag.
2. **EasyPost** must use a **test key** (`EZTK…`); a live key (`EZAK…`) is refused.
3. **Replay** carriers perform **no real network** — they replay recorded responses.
4. **Test orders** use a dedicated `is_test` client (`__CARRIER_HARNESS__`),
   `source_provider='internal'`, `external_order_id=NULL`, SKU `TEST-CARRIER-…`,
   `order_number` prefixed `HARNESS-`. This makes the marketplace confirmation path
   unreachable and lets cleanup find only harness rows (never shipped/cancelled).
5. `smoke:carrier-harness:real-label` (real postage) is `manual_live_gated` and
   excluded from every default profile.

---

## Tiers (fidelity)

| Tier | Carriers | Cost | Proves |
|---|---|---|---|
| **self-check** | all (offline) | $0, no net | seam + factory + matrix + safety invariants |
| **sandbox** | EasyPost | $0 (test key) | live request/response accepted by the real carrier |
| **replay** | shipp / ups / walmart_shipping | $0, no net | our request-build + parse + persist against real recorded bytes |
| **live (gated)** | any | **real $** | the only tier that fully closes replay↔live |

---

## Commands

```bash
# Offline — safe anywhere, in master/shipping/quick profiles:
npm run test:carrier-harness            # provider × service self-check matrix
npm run test:carrier-test-mode-seam     # seam double-gate + safety
npm run test:carrier-suppression        # marketplace/postage suppression invariants
npm run test:carrier-fixture-schema     # replay/capture infra + fixtures on disk
npm run test:carrier-print-to-queue:browser   # real "Print to Queue" click, no errors

# With credentials (you supply):
CARRIER_HARNESS_EASYPOST_TEST_KEY=EZTK... npm run carrier-harness:sandbox
npm run carrier-harness:capture         # record real fixtures for shipp/ups/walmart

# Human-approved, real postage (manual_live_gated):
npm run smoke:carrier-harness:real-label -- --live-approved
```

Output matrix: `test-results/carrier-harness/latest.{json,md}`.

---

## Run order (capture → sandbox → certify)

### 1. Offline gate (always)
```bash
npm run test:carrier-harness && npm run test:carrier-print-to-queue:browser
```
Green = the harness wiring, frontend button, and safety invariants all hold.

### 2. EasyPost sandbox (real carrier, $0)
1. Get a **test** API key from the EasyPost dashboard (starts `EZTK`).
2. ```bash
   CARRIER_HARNESS_EASYPOST_TEST_KEY=EZTK... npm run carrier-harness:sandbox
   ```
3. Read the matrix: every enabled USPS/UPS/FedEx service should be `pass` with
   `cost 0` and `no marketplace notify`. A `fail` row names the exact service + error.

### 3. Capture replay fixtures (shipp / ups / walmart_shipping)
Fixtures must be **recorded**, never hand-written (a fabricated body proves nothing).
```bash
# with each carrier's sandbox/test creds in the connector account:
npm run carrier-harness:capture
```
This records real `timedFetch` responses into
`test-fixtures/carriers/<provider>/labels/<serviceCode>.json`. Validate:
```bash
npm run test:carrier-fixture-schema
```
Re-run `test:carrier-harness` — replay rows now exercise the real parser against
genuine bytes.

### 4. Final live certification (real postage, refundable)
Only when offline + sandbox + replay are all green:
```bash
npm run smoke:carrier-harness:real-label -- --live-approved
```
Buys one real (immediately voidable) label per critical service to confirm the
live carrier still accepts our payload and returns a real PDF + tracking.

---

## Adding a new carrier

1. Implement the connector (`src/connectors/carrier/<name>.ts`) routing all HTTP
   through `timedFetch('<name>.<step>', …)`.
2. Set its tier in `resolveCarrierTestStrategy` (`src/services/carrier-test-mode.ts`)
   — `sandbox` if it has a test key/URL, else `replay`.
3. Capture fixtures (step 3 above).
4. The master runner auto-discovers any new `test:carrier-*` script.

---

## Honest gaps (do not over-trust)

- **Replay ≠ live acceptance** — proves our code against a known-good payload, not
  that the carrier still accepts it today (auth drift, deactivated services, their
  schema changes). **Fixtures rot — recapture periodically.**
- **Sandbox ≠ prod parity** — EasyPost test labels relax some validations.
- **Enumeration is account-state-dependent** — a service not enabled on the test
  account is a coverage hole, not a pass.
- **The direct handler (`api/carriers/labels.ts`) infers the confirmation provider
  from `external_order_id` only** (null → `shipstation`). The harness therefore
  drives `createCarrierLabel` + persist + print-queue (confirmation-free), NOT the
  handler's confirmation branch. `test:carrier-suppression` fails if that changes.
- Real-customer confidence still requires the step-4 live run per critical service.
