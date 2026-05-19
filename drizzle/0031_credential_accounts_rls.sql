-- Credential account RLS source of truth.
-- Runtime credential routes verify these tables are ready instead of enabling
-- RLS during user requests.

ALTER TABLE "carrier_accounts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "store_accounts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "carrier_account_clients" ENABLE ROW LEVEL SECURITY;
