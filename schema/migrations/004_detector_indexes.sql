-- Detector-friendly indexes for mint-scoped transfer scans + fee payer grouping.
-- Safe to apply repeatedly.

CREATE INDEX IF NOT EXISTS idx_transfers_scope_mint ON transfers (scope_address, mint);

CREATE INDEX IF NOT EXISTS idx_events_scope_fee_payer ON events (scope_address, fee_payer);
