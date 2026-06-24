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
- **Why is this the canonical source-of-truth owner:**
- **Which callers now delegate to it:**
- **What duplicate frontend/route/adapter logic was removed** (or marked as follow-up):
- **What boundary test proves the source-of-truth behavior** (path):
- **Frontend/adapters stay thin consumers** (no money/label/inventory/fulfillment/auth/
  rate/marketplace decision moved into UI or adapter): yes / N/A — explain

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
- [ ] No source-of-truth bypass wrapper introduced — every wrapper/helper/adapter stays thin
      (translate/normalize/forward only) and delegates business rules, authoritative values,
      money/rate/eligibility/inventory/billing truth, and "best"-selection to the canonical
      owner (see [ARCHITECTURE.md](../ARCHITECTURE.md) → *No Source-of-Truth Bypass Wrappers*).

## Testing

<!-- Exact commands run with pass/fail. State plainly if anything was skipped or failed. -->

```
npm run typecheck
# guards / build:web / browser / workflow checks relevant to this change
```

## Boundary tests

- **Source-of-truth / boundary test at the owner:** <!-- path -->
- **Operator-visible symptom test** (workflow/API/browser): <!-- path -->

## Remaining debt / follow-up

<!-- Known gaps, duplicate logic left in place, or follow-up tasks. "None" is a valid answer. -->
