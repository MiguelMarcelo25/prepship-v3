# PS-099 Completion Report

Status: 100%

Task: Separate Create+Print from Print Queue + Normalize SHIPP 4x6 Label Output

## Summary

PS-099 is complete. The existing Orders UI separation was certified and the SHIPP connector now normalizes SHIPP label output at the carrier boundary so Create+Print and Print-to-Queue receive queueable 4x6 PDF data URLs.

What is now pinned:

- Single-order Print-to-Queue uses queue/recovery and does not open a label popup.
- Single-order Create+Print opens the created label PDF and does not add it to the print queue.
- Batch Print opens labels; batch Queue adds labels to the print queue only in queue mode.
- SHIPP PDF, PNG, and UPS-style GIF label parts are converted into 4x6 PDF pages.
- SHIPP UPS GIF output no longer returns `data:image/gif`; it becomes `data:application/pdf`.

## Exact Files Changed

- `src/connectors/carrier/shipp.ts`
- `scripts/ps-099-create-print-shipp-label-output-guard.ts`
- `package.json`
- `package-lock.json`
- `docs/ps-099-create-print-shipp-label-output-completion-report.md`
- `docs/superpowers/plans/2026-06-05-shipping-purchase-boundary-task-plan.md`

## What Was Intentionally Not Changed

- No provider calls were made.
- No SHIPP rate-shopping behavior was changed.
- No print queue persistence behavior was changed.
- No shipped/cancelled order edit logic was changed.
- No marketplace confirmation behavior was changed.
- No broad UI rewrite was attempted.

## Verification

Passed on 2026-06-05:

```powershell
npm run test:ps-099-create-print-shipp-label-output
npm run test:ps-084-label-size-normalize
npm run typecheck
npm run test:direct-carrier-labels
npm run test:direct-carrier-queue-route
npm run test:print-queue-invalid-label
npm run test:shipping-roundtrip-certification
npm run test:full-site-certification
```

## Safety Confirmation

- No real labels or postage were purchased.
- No labels were voided.
- No live marketplace notifications were sent.
- No production shipped/cancelled order mutations were performed.
- No secrets, raw provider payloads, raw labels, or customer PII were exposed.
- Locked shipped/cancelled files touched for PS-099: none.

## Follow-Up Risks And Blockers

- `npm install` reports existing audit findings: 6 moderate and 3 high. No broad `npm audit fix` was run because that would be unrelated dependency churn.
- PS-087 remains as the final unfinished-task closeout/report ticket.
