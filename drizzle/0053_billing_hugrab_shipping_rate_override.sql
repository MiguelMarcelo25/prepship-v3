-- PS-366 - configurable HUGRAB C. Shipping Rate override.
-- Additive, nullable columns: null means "use backend defaults".
-- HUGRAB defaults to enabled with threshold/amount $6.00 in the service layer;
-- other clients default to disabled.
ALTER TABLE billing_config
  ADD COLUMN IF NOT EXISTS hugrab_shipping_rate_override_enabled boolean,
  ADD COLUMN IF NOT EXISTS hugrab_shipping_rate_override_threshold numeric(10, 2),
  ADD COLUMN IF NOT EXISTS hugrab_shipping_rate_override_amount numeric(10, 2);
