# PrepShip JWT Session Expiration Plan

## Executive Summary

Phase 13 adds a formal authentication session-expiration policy for PrepShip: all users should be forced to re-authenticate after a maximum of 7 days.

This is a Supabase Auth session-lifetime policy, not a 7-day access-token policy. Access JWTs should stay short-lived, preferably the current/default 1-hour lifetime, while Supabase time-boxed sessions enforce the 7-day maximum login window.

Primary Supabase reference: https://supabase.com/docs/guides/auth/sessions

## Critical Blockers

| Blocker | Risk | Required Outcome | Verification |
|---|---|---|---|
| Supabase session time-box is not configured | Users can remain signed in longer than the desired 7-day business policy | Supabase Auth time-box user sessions is set to 7 days | Supabase dashboard screenshot or owner confirmation |
| Access JWT lifetime is confused with session lifetime | Long-lived bearer tokens increase risk if a token leaks | Access JWT expiry remains short-lived; 7-day limit is enforced through session settings | Auth settings review and this guard |
| Expired-session UX is not verified | Operators may see stale local auth or confusing failures after session expiry | Expired refresh/session returns user to login cleanly | Staging short-timebox test |
| Strict JWT claims rollout is not verified | Enabling issuer/audience checks without token compatibility testing could break login | `STRICT_JWT_CLAIMS` remains staged until tested | Login smoke test before enabling strict mode |

## High-Risk Issues

| Area | Current Status | Risk | Recommended Patch |
|---|---|---|---|
| Backend JWT validation | `jose` verifies token signature and JWT `exp`; optional strict issuer/audience exists | backend cannot enforce original 7-day session age from access-token `iat` alone because tokens refresh | keep backend validation as-is; enforce 7-day limit in Supabase session settings |
| Frontend session handling | Supabase client persists sessions and auto-refreshes tokens | stale refresh failures must not leave the app looking authenticated | keep local stale-session cleanup and verify expired-session redirect behavior |
| Production rollout | Supabase dashboard change requires admin access | code deploy alone cannot complete this phase | assign DJ/admin to set session time-box to 7 days |
| Documentation drift | future devs may set access JWT to 7 days by mistake | longer token exposure and stale authorization claims | guard docs and phase tracker with `npm run test:jwt-session-policy` |

## Medium-Risk Issues

| Area | Concern | Recommendation |
|---|---|---|
| Role/permission claim freshness | JWT app metadata claims can remain stale until token refresh | keep access JWT short and avoid relying on `user_metadata` for authorization |
| User deletion/session revocation | deleting a user does not instantly invalidate existing access tokens | for sensitive future actions, consider validating `session_id` against Supabase sessions |
| Staging proof | waiting 7 days to prove production behavior is slow | test with a short staging time-box, then restore/set production to 7 days |
| Support communication | operators may be surprised by forced re-login | document expected 7-day re-login behavior in runbook/support notes |

## Phase 13 Checklist

- [x] Policy chosen: 7-day maximum Supabase session lifetime.
- [x] Access JWTs remain short-lived.
- [x] Create `JWT_SESSION_EXPIRATION_PLAN.md`.
- [x] Update `DEV_TASKS_README.md`.
- [x] Update `SECURITY_PATCH_PLAN.md`.
- [x] Update `ENTERPRISE_READINESS_AUDIT.md`.
- [x] Add `npm run test:jwt-session-policy`.
- [ ] Configure Supabase Auth time-box user sessions to 7 days.
- [ ] Verify expired-session behavior in staging with a short temporary time-box.
- [ ] Verify production login and forced re-login behavior after rollout.
- [ ] Decide when to enable `STRICT_JWT_CLAIMS=true` in production.

## Recommended Patches

- [x] Keep current backend JWT `exp` validation through `jose`.
- [x] Keep `STRICT_JWT_CLAIMS` behind an environment flag.
- [x] Document Supabase Auth time-box session setting as the 7-day enforcement point.
- [x] Add a guard test so future changes do not convert this into a 7-day access-token policy.
- [ ] In Supabase Auth settings, set time-box user sessions to 7 days.
- [ ] Keep or set access token / JWT expiry to a short value, preferably 1 hour.
- [ ] Run a staging short-timebox test to confirm expired sessions send users back to login.
- [ ] Add production evidence to `PRODUCTION_READINESS_SIGNOFF.md` after DJ/admin configures Supabase.

## Test Plan

- `npm run test:jwt-session-policy`
- `npm run test:auth-coverage`
- `npm run typecheck`
- `npm run build:web`
- `npm run test:orders-ux`

Manual Supabase verification:

- In staging, set a short time-box value temporarily and confirm the app forces re-login after expiry.
- In production, set Supabase Auth time-box user sessions to 7 days.
- Confirm access JWT expiry remains short-lived and is not set to 7 days.
- Confirm normal login works after the setting change.
- Confirm expired-session refresh failure clears local session and returns the user to login.

## Deployment / Rollback Notes

- This phase does not require a backend/frontend runtime behavior change to enforce the 7-day policy.
- The actual 7-day enforcement is a Supabase Auth configuration change and must be performed by someone with Supabase project admin access.
- Rollback is to restore the previous Supabase Auth session setting.
- If users are unexpectedly logged out too frequently, revert the Supabase time-box value and re-test staging behavior.
- If strict JWT claims break login, set `STRICT_JWT_CLAIMS=false` and restart the API.

## Recommended Implementation Order

1. Land this documentation and static guard.
2. Have DJ/admin configure staging with a short time-box and validate forced re-login.
3. Configure production Supabase Auth time-box user sessions to 7 days.
4. Run login, API auth, and browser smoke tests.
5. Add evidence to production signoff.
6. Separately test `STRICT_JWT_CLAIMS=true` before enabling it in production.

