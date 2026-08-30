
CREATE TABLE IF NOT EXISTS users (
  id BIGSERIAL PRIMARY KEY,
  telegram_id BIGINT UNIQUE NOT NULL,
  username TEXT,
  first_name TEXT,
  last_name TEXT,
  photo_url TEXT,
  points NUMERIC(30, 4) NOT NULL DEFAULT 0,
  usdt_balance NUMERIC(30, 8) NOT NULL DEFAULT 0,
  referred_by BIGINT REFERENCES users(telegram_id),
  referral_earnings NUMERIC(30, 4) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS tasks (
  id BIGSERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  reward NUMERIC(30, 4) NOT NULL DEFAULT 0,
  type TEXT NOT NULL DEFAULT 'manual',
  url TEXT,
  daily BOOLEAN NOT NULL DEFAULT FALSE,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS task_claims (
  id BIGSERIAL PRIMARY KEY,
  task_id BIGINT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  telegram_id BIGINT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
  claim_key TEXT NOT NULL,
  reward NUMERIC(30, 4) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(task_id, telegram_id, claim_key)
);

CREATE TABLE IF NOT EXISTS checkins (
  id BIGSERIAL PRIMARY KEY,
  telegram_id BIGINT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
  checkin_date DATE NOT NULL,
  reward NUMERIC(30, 4) NOT NULL,
  streak INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(telegram_id, checkin_date)
);

CREATE TABLE IF NOT EXISTS ledger (
  id BIGSERIAL PRIMARY KEY,
  telegram_id BIGINT REFERENCES users(telegram_id) ON DELETE SET NULL,
  kind TEXT NOT NULL,
  amount NUMERIC(30, 4) NOT NULL,
  reference_id TEXT,
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS withdrawals (
  id BIGSERIAL PRIMARY KEY,
  telegram_id BIGINT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
  points NUMERIC(30, 4) NOT NULL,
  usdt NUMERIC(30, 8) NOT NULL,
  wallet TEXT NOT NULL,
  network TEXT NOT NULL DEFAULT 'TRC20',
  status TEXT NOT NULL DEFAULT 'pending',
  admin_note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT INTO settings(key,value) VALUES
('coin_name','MYCOIN'),
('points_per_usdt','10000'),
('referral_percent','2'),
('checkin_reward','100'),
('min_withdraw_usdt','1'),
('withdraw_network','TRC20')
ON CONFLICT(key) DO NOTHING;

CREATE INDEX IF NOT EXISTS idx_ledger_user ON ledger(telegram_id);
CREATE INDEX IF NOT EXISTS idx_withdrawals_status ON withdrawals(status);
CREATE INDEX IF NOT EXISTS idx_task_claims_user ON task_claims(telegram_id);
