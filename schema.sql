-- ══════════════════════════════════════════════
-- MAGGIE'S DASHBOARD v2 — Full Schema
-- Run this in your Supabase SQL Editor
-- ══════════════════════════════════════════════

-- Tasks
CREATE TABLE IF NOT EXISTS tasks (
  id          BIGSERIAL PRIMARY KEY,
  text        TEXT NOT NULL,
  tag         TEXT NOT NULL DEFAULT 'personal',
  done        BOOLEAN NOT NULL DEFAULT false,
  date        DATE NOT NULL DEFAULT CURRENT_DATE,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Habits
CREATE TABLE IF NOT EXISTS habits (
  id          BIGSERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  emoji       TEXT NOT NULL DEFAULT '✅',
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS habit_completions (
  id          BIGSERIAL PRIMARY KEY,
  habit_id    BIGINT REFERENCES habits(id) ON DELETE CASCADE,
  date        DATE NOT NULL DEFAULT CURRENT_DATE,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(habit_id, date)
);

-- Pipeline leads
CREATE TABLE IF NOT EXISTS leads (
  id          BIGSERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  company     TEXT,
  status      TEXT NOT NULL DEFAULT 'lead',
  value       INTEGER NOT NULL DEFAULT 0,
  followup    TEXT NOT NULL DEFAULT 'week',
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ── GOALS ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS goals (
  id          BIGSERIAL PRIMARY KEY,
  title       TEXT NOT NULL,
  description TEXT,
  category    TEXT NOT NULL DEFAULT 'personal', -- 'pr' | 'personal' | 'revenue'
  period_type TEXT NOT NULL,                    -- 'monthly' | 'quarterly'
  period_key  TEXT NOT NULL,                    -- '2026-06' | '2026-Q2'
  target      NUMERIC,                          -- numeric target (optional)
  unit        TEXT,                             -- 'AED' | '%' | 'clients' etc
  progress    NUMERIC NOT NULL DEFAULT 0,
  done        BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ── WEEKLY REFLECTIONS ─────────────────────────
CREATE TABLE IF NOT EXISTS reflections (
  id              BIGSERIAL PRIMARY KEY,
  week_key        TEXT NOT NULL UNIQUE, -- 'YYYY-Www' e.g. '2026-W24'
  week_start      DATE NOT NULL,
  wins            TEXT,
  slipped         TEXT,
  next_focus      TEXT,
  showed_up       TEXT,
  pipeline_notes  TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ── REALTIME ───────────────────────────────────
ALTER PUBLICATION supabase_realtime ADD TABLE tasks;
ALTER PUBLICATION supabase_realtime ADD TABLE leads;
ALTER PUBLICATION supabase_realtime ADD TABLE habit_completions;
ALTER PUBLICATION supabase_realtime ADD TABLE goals;
ALTER PUBLICATION supabase_realtime ADD TABLE reflections;

-- ── TRIGGERS ───────────────────────────────────
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER tasks_updated_at    BEFORE UPDATE ON tasks    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER leads_updated_at    BEFORE UPDATE ON leads    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER goals_updated_at    BEFORE UPDATE ON goals    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER reflections_updated BEFORE UPDATE ON reflections FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ── SEED DATA ──────────────────────────────────
INSERT INTO habits (name, emoji) VALUES
  ('Exercise / Move', '🏃‍♀️'),
  ('Read / Learn', '📖');

INSERT INTO leads (name, company, status, value, followup) VALUES
  ('Layla Al Mansouri', 'Bloom Studio',   'proposal', 12000, 'today'),
  ('Ahmed Rauf',        'Rauf Ventures',  'lead',      8000, 'week'),
  ('Sara Ghosn',        'The Edit Media', 'followup',  6500, 'today'),
  ('Tariq Osman',       'Desert Brands',  'closed',    9000, 'done');

-- Sample monthly goals (June 2026)
INSERT INTO goals (title, category, period_type, period_key, target, unit, progress) VALUES
  ('Sign 3 new PR retainer clients', 'pr',       'monthly',   '2026-06', 3,     'clients', 1),
  ('Hit AED 50,000 pipeline value',  'revenue',  'monthly',   '2026-06', 50000, 'AED',     35500),
  ('Publish 4 LinkedIn posts',       'personal', 'monthly',   '2026-06', 4,     'posts',   1);

-- Sample quarterly goals (Q2 2026)
INSERT INTO goals (title, category, period_type, period_key, target, unit, progress) VALUES
  ('Launch PR agency brand + website', 'pr',      'quarterly', '2026-Q2', null,  null,      0),
  ('Close AED 150,000 in PR revenue',  'revenue', 'quarterly', '2026-Q2', 150000,'AED',     35500),
  ('Build a roster of 5 retainers',    'pr',      'quarterly', '2026-Q2', 5,     'clients', 1);
