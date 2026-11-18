-- Bot hosting panel schema (PostgreSQL 13+)
BEGIN;

CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  google_id TEXT UNIQUE,
  coins INTEGER NOT NULL DEFAULT 0 CHECK (coins >= 0),
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE plans (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  coin_cost INTEGER NOT NULL CHECK (coin_cost >= 0),
  duration_days INTEGER NOT NULL CHECK (duration_days > 0),
  ram_limit_mb INTEGER NOT NULL DEFAULT 256,
  active BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE coin_packages (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  price INTEGER NOT NULL CHECK (price > 0),
  currency TEXT NOT NULL DEFAULT 'GHS',
  coins INTEGER NOT NULL CHECK (coins > 0),
  active BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE bots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_id INTEGER REFERENCES plans(id),
  name TEXT NOT NULL,
  owner_number TEXT NOT NULL CHECK (owner_number ~ '^[0-9]+$'),
  session_data TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'stopped' CHECK (status IN ('running', 'stopped', 'crashed', 'expired')),
  container_id TEXT,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_bots_user ON bots(user_id);
CREATE INDEX idx_bots_status_expiry ON bots(status, expires_at);

CREATE TABLE payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  package_id INTEGER NOT NULL REFERENCES coin_packages(id),
  provider TEXT NOT NULL DEFAULT 'paystack',
  reference TEXT NOT NULL UNIQUE,
  amount INTEGER NOT NULL CHECK (amount > 0),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'success', 'failed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  paid_at TIMESTAMPTZ
);
CREATE INDEX idx_payments_user ON payments(user_id);

CREATE TABLE transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  type TEXT NOT NULL CHECK (type IN ('purchase', 'rental', 'extend', 'reward', 'coupon', 'admin')),
  amount INTEGER NOT NULL,
  bot_id UUID REFERENCES bots(id) ON DELETE SET NULL,
  payment_id UUID REFERENCES payments(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_transactions_user ON transactions(user_id, created_at DESC);

CREATE TABLE coupons (
  id SERIAL PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  coins INTEGER NOT NULL CHECK (coins > 0),
  max_uses INTEGER NOT NULL DEFAULT 1,
  used_count INTEGER NOT NULL DEFAULT 0,
  expires_at TIMESTAMPTZ
);

CREATE TABLE coupon_redemptions (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  coupon_id INTEGER NOT NULL REFERENCES coupons(id) ON DELETE CASCADE,
  redeemed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, coupon_id)
);

CREATE TABLE bot_commands (
  id SERIAL PRIMARY KEY,
  bot_id UUID NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  command TEXT NOT NULL,
  response TEXT NOT NULL,
  UNIQUE (bot_id, command)
);

INSERT INTO plans (name, coin_cost, duration_days, ram_limit_mb) VALUES
  ('Free - 3 days', 0, 3, 128),
  ('7 days', 50, 7, 256),
  ('30 days', 180, 30, 256);

INSERT INTO coin_packages (name, price, coins) VALUES
  ('Starter', 1000, 100),
  ('Standard', 2500, 280),
  ('Pro', 5000, 600);

COMMIT;
