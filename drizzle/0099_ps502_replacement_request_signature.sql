-- PS-502 — bind idempotency to the WHOLE request, not just its items.
--
-- HERMES re-audit at b8dd609e, correction 1. The first payload binding compared order id
-- plus sorted line indexes and quantities. It did not compare reason, liability owner,
-- requested billability, the billability reason, or the allowance-override reason — so the
-- same key retried with identical items but materially different MONEY OR LIABILITY INTENT
-- silently returned the earlier replacement, and the caller believed its new intent had been
-- recorded.
--
-- Storing the signature rather than recomputing it from the row is deliberate. The
-- billability reason lives on an activity event and the override reason is only present when
-- an override happened, so a reconstruction would be reassembling the request from its
-- effects — and would silently start comparing fewer fields the moment one of those effects
-- changed shape. One column, written once at creation, compared verbatim on retry.
--
-- Nullable and additive: rows created before this migration have no signature, and the
-- command treats a missing signature as "cannot prove equivalence" rather than as a match.
--
-- Safe to re-run.

alter table replacements
  add column if not exists request_signature text;

comment on column replacements.request_signature is
  'PS-502: canonical signature of the whole creating request. Idempotent retries must match it exactly; NULL means a pre-0099 row whose equivalence cannot be proven.';
