# Site Action Testing

Every new user-facing button/action must update `docs/site-action-functionality-matrix.md` and add automated coverage or document why the action is manual-only.

Required checklist:

- selector or stable role/name
- intended user outcome
- role/scope expectation
- backend dependency
- loading state
- success state
- failure state
- side-effect classification
- mocked/sandbox/manual test mode

Automated tests must not buy postage, create labels, send marketplace notifications, mutate live orders, update shipped/cancelled records, generate real billing, or run destructive production actions.
