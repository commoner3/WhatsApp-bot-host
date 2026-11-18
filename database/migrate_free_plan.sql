-- Run this ONLY if you already ran schema.sql before the free plan existed.
BEGIN;
ALTER TABLE plans DROP CONSTRAINT IF EXISTS plans_coin_cost_check;
ALTER TABLE plans ADD CONSTRAINT plans_coin_cost_check CHECK (coin_cost >= 0);
INSERT INTO plans (name, coin_cost, duration_days, ram_limit_mb)
VALUES ('Free - 3 days', 0, 3, 128);
COMMIT;
