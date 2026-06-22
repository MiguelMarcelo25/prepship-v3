# PS-295 SHIPP House customer_rate proof status

Date: 2026-06-22

## Current status

Current completion estimate: PS-295 91%.

PS-295 is Final Review-ready after the focused guards pass. The dedicated House
customer_rate proof now covers the live-regression tail that PS-220 and PS-292
left behind: SHIPP House labels freeze a realized customer_rate sidecar, shipped
rows display that customer_rate over DRP cost, and billing/export/invoice
surfaces bill customer_rate instead of the internal SHIPP cost.

This is not a claim of 100% production completion. A read-only operator canary
against one real SHIPP House shipped row and its billing export would make the
evidence stronger, but the code/test proof is enough for Final Review.

## Evidence now wired

- `test:ps-220-house-margin`
- `test:ps-292-house-tuple-display`
- `test:ps-292-final-review-closeout`
- `test:ps-295-house-customer-rate-proof`
- `test:ps-295-house-customer-rate-closeout`

## What is proven

- `houseMarginFromProjection` freezes the customer_rate from the projected
  next-best non-house rate and keeps DRP cost separate.
- The realized writer gate is opt-in and does not write locked shipments.
- Shipped DTO money reads the realized sidecar and suppresses normal carrier
  markup for House rows.
- The shipped Orders UI renders House shipped money only from backend money
  DTOs.
- Billing generation loads customer_rate by shipment id and writes it as the
  shipping line unit and total cost.
- Billing details expose billed customer_rate and actual SHIPP cost for margin
  review.
- CSV, HTML, and XLSX invoice renderers consume generated billing shipping
  amounts; they do not recompute provider cost.
- The old `test:ps-295-rate-browser-speed-diagnostics` guard remains separate
  and is not treated as House customer_rate proof.

## Missing before 100%

- Read-only production canary: one SHIPP House shipped row showing backend House
  tuple, matching billing detail, and matching invoice/export shipping amount.
- Trello move/comment only after explicit `task update`.

## Safety

This proof is offline-only. It does not run live labels, buy postage, mutate
queues, send marketplace notifications, update production orders, or mutate
shipped/cancelled data.
