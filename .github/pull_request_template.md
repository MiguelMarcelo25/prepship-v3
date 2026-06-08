<!--
PrepShip V4 PR. Read ARCHITECTURE.md (Architecture-First Development Standard) and
AGENTS.md (shipped/cancelled lockdown) before opening. Fill every section; delete the
"N/A" lines that don't apply and say why.
-->

## Summary

<!-- What changed and why, in 2-4 sentences. -->

## Architecture Placement

> Fix the source of truth, not the symptom. See [ARCHITECTURE.md](../ARCHITECTURE.md).

- **Business rule / workflow changed:**
- **Canonical owner / source of truth** (file + symbol):
- **Why this layer:**
- **Callers updated to delegate:**
- **Duplicate logic removed** (or explicitly left as follow-up debt):
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
