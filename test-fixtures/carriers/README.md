# Carrier harness fixtures

Recorded **real** carrier HTTP responses for the replay tier of the end-to-end
carrier test harness (plan: `zany-spinning-hennessy`). Replaying a fixture drives
the connector's own request-build + response-parse code against genuine bytes — so
the parser is exercised, not bypassed.

## Layout

```
test-fixtures/carriers/<provider>/labels/<serviceCode>.json
```

Each file is a captured fixture envelope:

```json
{
  "provider": "shipp",
  "serviceCode": "shipp_ups_ground",
  "captured": true,
  "capturedAt": "2026-06-06",
  "account": "sandbox",
  "steps": [
    { "name": "shipp.login",  "status": 200, "body": { } },
    { "name": "shipp.rates",  "status": 200, "body": { } },
    { "name": "shipp.labels", "status": 200, "body": { } }
  ]
}
```

`steps[].name` matches the `timedFetch(name, …)` label the connector uses, so each
recorded response is returned for the exact call that produced it (in order).

## Capturing (do NOT hand-write these)

Fixtures must be **recorded from real carrier traffic**, never fabricated — a
fabricated body that doesn't match the carrier's real shape would prove nothing.

Capture by running the harness once with real sandbox/test credentials:

```bash
CARRIER_HARNESS_EASYPOST_TEST_KEY=EZTK... \
  npm run carrier-harness:capture
```

The capture sink (`withCaptureFixture` in `src/services/carrier-test-mode.ts`)
records every `timedFetch` response into a fixture envelope and validates it via
`validateCarrierFixture` before saving.

## Validation

`npm run test:carrier-fixture-schema` validates every fixture on disk against the
envelope schema. An empty directory is valid — replay rows simply report
`skipped (no fixture)` until a real capture exists.

## Honest gap

Replay proves our request-build / parse / persist / suppress code is correct
against a **known-good** payload. It does NOT prove the live carrier still accepts
our request today (auth drift, deactivated services, their schema changes).
Fixtures rot — recapture periodically, and run the live-gated
`smoke:carrier-harness:real-label` before trusting a carrier in production.
