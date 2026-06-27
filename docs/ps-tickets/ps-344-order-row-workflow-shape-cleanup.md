# PS-344 - Order Row Workflow Shape Cleanup

## Goal

Remove the frontend action reader's fallback into nested wrapper workflow shapes.
Order row actions must consume the backend-stamped top-level `bestRateWorkflow`
DTO only.

## Source Of Truth

- Backend owner: `src/services/shipping-workflow/best-rate-workflow-dto.ts`
  builds the workflow verdict and row action facts.
- API owner: `src/routes/orders.ts` stamps `bestRateWorkflow` onto the order row
  as a top-level DTO field.
- Frontend reader: `web/src/components/Views/orders/order-row-actions.ts` is a
  thin consumer. It may read top-level `order.bestRateWorkflow`; it must not
  search nested wrappers such as `shippingModel.bestRateWorkflow`.

## Imperfect Data Injection

The bad input is a wrapper-shaped frontend row where a nested
`shippingModel.bestRateWorkflow` can be stale or disagree with the row DTO. The
previous helper tolerated that shape as a deploy bridge. That bridge is now
removed so action gating cannot be sourced from a stale nested object.

## Guard

Run:

```bash
npm run test:ps-344-order-row-workflow-shape-cleanup
```

The guard proves:

- top-level `bestRateWorkflow` still drives allowed actions, state axes, and
  blocked reasons;
- nested-only `shippingModel.bestRateWorkflow` is ignored;
- the backend route still stamps `bestRateWorkflow` top-level;
- the orders hook preserves the backend row field.
