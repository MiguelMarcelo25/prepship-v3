# PS-340 - Rate Browser frontend bridge audit

Goal: Separate acceptable display-only Rate Browser helpers from backend-critical local authority.

Current known acceptable display-only helpers:
- `sortRateRowsByBackendDisplayRank(...)` may sort visible rows if it consumes backend rank/display facts and never emits/persists Best Rate.
- Test-mode seeded-rate sorting is acceptable only inside `testMode`.
- Manual estimates may display only as not label-safe.

Current known risky bridges:
- Any client-side fallback that emits or persists a cheapest/best rate when backend canonical best is absent.
- Any local markup/rank/eligibility math used for Create Label, Print Queue, Apply Best Rate, or saved Best Rate.
- Any new helper that searches multiple backend object shapes without a removal plan.
