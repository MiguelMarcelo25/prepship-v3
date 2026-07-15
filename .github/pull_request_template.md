<!--
PrepShip V4 PR. Read ARCHITECTURE.md (Architecture-First Development Standard) and
AGENTS.md (shipped/cancelled lockdown) before opening. Fill every section; delete the
"N/A" lines that don't apply and say why.
-->

## Summary

<!-- What changed and why, in 2-4 sentences. -->

## Architecture Placement

> Fix the source of truth, not the symptom. Trace bad data to where it first entered.
> See [ARCHITECTURE.md](../ARCHITECTURE.md). **Fast rejection:** a PR that only changes the
> visible symptom — without explaining why the canonical source of truth is already correct,
> or how the fix moved the rule to that source of truth — is incomplete.

- **Business rule / workflow changed:**
- **Where could imperfect data** (bad, stale, incomplete, ambiguous, or less-than-perfect)
  **have entered** before this fix? (sync/webhook, import, provider payload,
  default/fallback, cache write, input boundary):
- **Canonical owner / source of truth** (file + symbol):
- **Current duplicated/unsafe owners:**
- **Why is this the canonical source-of-truth owner:**
- **Which callers now delegate to it:**
- **What duplicate frontend/route/adapter logic was removed** (or marked as follow-up):
- **Wrapper/resolver/helper logic to delete or explicitly forbid:**
- **Frontend role: display/action only; no authoritative business logic:**
- **Backend boundary tests required:**
- **What boundary test proves the source-of-truth behavior** (path):
- **Frontend/adapters stay thin consumers** (no money/label/inventory/fulfillment/auth/
  rate/marketplace decision moved into UI or adapter): yes / N/A — explain

### Rate Source-of-Truth proof

For any Best Rate, Rate Browser, selected-rate proof, label-purchase rate, Billing rate,
or Shipped-rate display change:

- **Backend canonical rate authority used:** <!-- file + symbol -->
- **Proof `npm run test:rate-source-of-truth` passed:** yes / N/A — explain
- **Frontend only displays or sends intent:** yes / N/A — explain
- **No frontend/router wrapper ranks, selects, mints, or persists official bestRate:** yes / N/A — explain
- **Billing/Shipped use selected/purchased shipment rate truth:** yes / N/A — explain

Rate Source-of-Truth proof must name the backend canonical rate authority and explain how
selected/purchased shipment rate truth is preserved when those paths are touched.

## Final Review closure packet

- **Packet path:** `docs/final-review/packets/<TASK-ID>.json` / N/A - explain
- **Exact reviewed SHA** (40 characters):
- **Selected risk profiles:**
- **Closure validator:** `npm run test:final-review-closure` pass / N/A - explain
- **Hermes eligibility:** complete + score cap 100 + claimed score above 90 / not eligible

The packet must be committed after the reviewed implementation SHA, with no non-packet
changes after that SHA. See [docs/final-review/README.md](../docs/final-review/README.md).

For any source-of-truth, backend-truth, no-wrapper, rate, Rate Browser, Orders shell,
label, queue, marketplace, billing, inventory, auth/scope, or shipped/cancelled-adjacent
change, run the mandatory Hermes/CI guard pack:

- **SOT/no-wrapper guard pack passed:** `npm run test:sot-guard-pack` yes / N/A — explain

## Safety checklist

- [ ] No secrets, tokens, customer PII, raw provider payloads, full tracking numbers,
      addresses, or raw label URLs in code, tests, logs, or this PR.
- [ ] No real postage bought, no real/void labels, no live marketplace notifications in
      tests (mocked/offline/sandbox fixtures only).
- [ ] No production shipped/cancelled order or shipment-history mutation (the AGENTS.md
      `unlock shipped data` override is quoted in the commit if any locked surface was
      touched).
- [ ] Auth/RBAC, client/store scope, selected-rate proof, secret redaction, and
      billing/inventory correctness are preserved (not weakened).
- [ ] Backend truth / no-wrapper law checked: no backend-owned business logic was added to
      frontend/UI, and no wrapper/helper/adapter became a second source of truth. New wrappers
      are thin, necessary, traceable, and delegate to the canonical owner (see
      [ARCHITECTURE.md](../ARCHITECTURE.md) → *Backend Truth & No Source-of-Truth Bypass Law*).

## Testing

<!-- Exact commands run with pass/fail. State plainly if anything was skipped or failed. -->

```
npm run test:sot-guard-pack
npm run typecheck
# guards / build:web / browser / workflow checks relevant to this change
```

## Boundary tests

- **Source-of-truth / boundary test at the owner:** <!-- path -->
- **Operator-visible symptom test** (workflow/API/browser): <!-- path -->

## Remaining debt / follow-up

<!-- Known gaps, duplicate logic left in place, or follow-up tasks. "None" is a valid answer. -->
