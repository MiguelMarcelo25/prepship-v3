# Site Action Testing

PS-022 makes site-action testing a workflow certification gate. Every new user-facing button/action must update `docs/site-action-functionality-matrix.md` and add automated coverage or document why the action is manual-gated/blocked.

## Required Action Checklist

- selector or stable role/name
- intended user outcome
- allowed and denied role/scope expectation
- fixture state before action
- backend/API dependency
- expected HTTP method/path
- required request payload fields
- loading state
- success state
- failure state
- expected state transition
- side-effect classification
- mocked/sandbox/manual-gated test mode
- covered spec/test name or explicit uncovered reason

## Request Ledger

Browser certification tests must keep a request ledger for each workflow. The ledger records method, URL, path, post body, and response status for mocked API calls.

Each critical workflow should assert:

- expected API requests fired
- expected method/path matched
- important payload fields are present
- payloads do not contain `[object Object]`
- unexpected live provider hosts were blocked
- secrets, tokens, raw labels, base64 PDFs, customer PII, and provider payloads are not shown in visible UI errors

## Mocked, Sandbox, And Live-Gated Modes

Mocked mode is the default for `npm run test:full-site-certification`. It uses controlled fixtures and route interception.

Sandbox mode may be used only when credentials and data are explicitly sandboxed and the command is separate from the default certification suite.

Live-gated mode is manual. The live-gated path must require an explicit approval flag such as `--live-approved`, explicit order/client/provider inputs, and DJ coordination at the moment of the test.

## Forbidden Side Effects

Automated tests must not buy postage, create real labels, send marketplace notifications, mutate live production orders, update shipped/cancelled records, generate real invoices/charges, call live external providers, or expose secrets/PII/raw labels.

Blocked live hosts include Walmart Marketplace, eBay APIs, ShipStation APIs, and live carrier APIs unless a specific test has an explicit mocked route interception proving no live traffic leaves the browser.

## Full automated pass means

A full automated pass means:

- app shell loads
- auth/session works under fixture
- critical pages render
- critical actions exist or are correctly hidden by role/status
- expected API requests fire
- request payload contracts match
- loading/success/failure UI states work
- role/scope restrictions work
- forbidden external calls do not happen
- no secrets/PII/raw labels leak
- shipping workflow works against controlled fixtures

## Full automated pass does NOT mean

A full automated pass does NOT mean:

- every live carrier works right now
- every live marketplace credential is valid
- production DB has no bad data
- live postage was purchased successfully
- live marketplace notification was tested
- production printer/browser popup behavior was fully validated

Those require separate gated live/sandbox certification with DJ approval.

## Adding A New Action

1. Add a row to `docs/site-action-functionality-matrix.md`.
2. Add or reuse a stable selector.
3. Add request ledger expectations for every API call.
4. Add loading, success, and failure assertions.
5. Classify side effects.
6. Keep live/provider behavior mocked or manual-gated.
7. Run `npm run test:full-site-certification`.
