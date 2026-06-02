-- ============================================================================
-- 0038 — Pin search_path on app-owned function (advisor: Function Search Path
--        Mutable)
-- ============================================================================
-- public.prepship_refresh_order_items_for_order() is a trigger function on
-- public.orders that refreshes public.order_items. It currently has no fixed
-- search_path, so the advisor flags it as mutable (a search_path-hijack risk).
--
-- This pins the resolution path WITHOUT changing the function body or behavior:
-- unqualified `order_items` still resolves via `public`, and built-ins
-- (coalesce, jsonb_array_elements, now, ...) resolve from pg_catalog, which is
-- always searched first implicitly. `pg_temp` is placed last so temp objects
-- cannot shadow real ones.
--
-- pgboss.* "Function Search Path Mutable" advisories are intentionally NOT
-- touched here — those functions are owned/managed by the pg-boss library.
--
-- Idempotent and reversible (ALTER FUNCTION ... RESET search_path).
-- ============================================================================

ALTER FUNCTION public.prepship_refresh_order_items_for_order()
  SET search_path = public, pg_temp;
