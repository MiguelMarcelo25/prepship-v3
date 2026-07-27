-- PS-465: allow the prepship_test hazmat profile in the immutable snapshot.
--
-- The snapshot profile CHECK was created by 0078 with the five real carrier
-- profiles. The test-fixture profile added alongside it is rejected by that
-- constraint, so a hazmat test label passed rating, purchase authorization and
-- shipment persistence, then failed on the final snapshot insert with
-- summary_profile = 'prepship_test'.
--
-- Widening, not weakening: every existing profile stays allowed and the
-- constraint still rejects anything unrecognised. prepship_test is reachable
-- only for clients.is_test, and PS-186 forces mock labels for those clients,
-- so no real postage can ever be recorded under it.
--
-- Existing snapshot rows are untouched; the table remains append-only and its
-- UPDATE/DELETE/TRUNCATE blocking triggers are unchanged.

ALTER TABLE shipment_hazmat_snapshots
  DROP CONSTRAINT IF EXISTS shipment_hazmat_snapshots_profile_chk;

ALTER TABLE shipment_hazmat_snapshots
  ADD CONSTRAINT shipment_hazmat_snapshots_profile_chk
  CHECK (summary_profile = ANY (ARRAY[
    'shipstation_usps'::text,
    'shipstation_ups_dry_ice'::text,
    'shipstation_ups_dangerous_goods'::text,
    'ups_direct'::text,
    'walmart'::text,
    'prepship_test'::text
  ]));
