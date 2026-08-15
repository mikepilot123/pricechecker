-- Price catalog: the app's own store for repair prices, layered over the
-- published Google Sheet that the Prices tab still reads as its base list.
-- Backs the Settings price editor (assets/prices-admin.js) and holds the
-- Pixel line-up, which never had a tab wired into assets/app.js.
--
-- Mirrored idempotently in lib/db.js's ensureSchema() so a deploy that beats a
-- manual migration run still comes up with the tables present.

CREATE TABLE IF NOT EXISTS price_models (
  id          TEXT PRIMARY KEY,
  model_key   TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  brand       TEXT NOT NULL DEFAULT '',
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Soft delete: a sheet-backed model would just come back on the next CSV
  -- sync, so the tombstone has to survive to keep suppressing it.
  deleted_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_price_models_sort ON price_models (sort_order, lower(name));

CREATE TABLE IF NOT EXISTS price_entries (
  id          BIGSERIAL PRIMARY KEY,
  model_id    TEXT NOT NULL REFERENCES price_models (id) ON DELETE CASCADE,
  repair_type TEXT NOT NULL,
  -- Text, not numeric: the sheet's cells can hold notes ("Call to confirm")
  -- as well as amounts, and the Prices tab renders both.
  value       TEXT NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (model_id, repair_type)
);

CREATE INDEX IF NOT EXISTS idx_price_entries_model ON price_entries (model_id);

-- Pixel seed. ON CONFLICT DO NOTHING throughout, so re-running never
-- overwrites a price edited in the app or resurrects a deleted model.
INSERT INTO price_models (id, model_key, name, brand, sort_order) VALUES
  ('PM:pixel 10 pro xl', 'pixel 10 pro xl', 'Pixel 10 Pro XL', 'Pixel', 0),
  ('PM:pixel 9 pro xl',  'pixel 9 pro xl',  'Pixel 9 pro xl',  'Pixel', 1),
  ('PM:pixel 9',         'pixel 9',         'Pixel 9',         'Pixel', 2),
  ('PM:pixel 8',         'pixel 8',         'Pixel 8',         'Pixel', 3),
  ('PM:pixel 7 pro',     'pixel 7 pro',     'Pixel 7 pro',     'Pixel', 4),
  ('PM:pixel 7 a',       'pixel 7 a',       'Pixel 7 A',       'Pixel', 5),
  ('PM:pixel 7',         'pixel 7',         'Pixel 7',         'Pixel', 6),
  ('PM:pixel 6 pro',     'pixel 6 pro',     'Pixel 6 pro',     'Pixel', 7),
  ('PM:pixel 6 a',       'pixel 6 a',       'Pixel 6 A',       'Pixel', 8),
  ('PM:pixel 6',         'pixel 6',         'Pixel 6',         'Pixel', 9),
  ('PM:pixel 5 a',       'pixel 5 a',       'Pixel 5 A',       'Pixel', 10),
  ('PM:pixel 4a',        'pixel 4a',        'Pixel 4a',        'Pixel', 11),
  ('PM:pixel 3a',        'pixel 3a',        'Pixel 3A',        'Pixel', 12),
  ('PM:pixel 3',         'pixel 3',         'Pixel 3',         'Pixel', 13)
ON CONFLICT (model_key) DO NOTHING;

INSERT INTO price_entries (model_id, repair_type, value) VALUES
  ('PM:pixel 10 pro xl', 'Original Screen replacement', '1800'),
  ('PM:pixel 9 pro xl',  'Screen replacement',          '1500'),
  ('PM:pixel 9',         'Screen replacement',          '1300'),
  ('PM:pixel 8',         'Screen replacement',          '1250'),
  ('PM:pixel 8',         'Battery',                     '700'),
  ('PM:pixel 7 pro',     'Screen replacement',          '1100'),
  ('PM:pixel 7 pro',     'Battery',                     '600'),
  ('PM:pixel 7 a',       'Original Screen replacement', '1700'),
  ('PM:pixel 7 a',       'Screen replacement',          '1100'),
  ('PM:pixel 7 a',       'Battery',                     '650'),
  ('PM:pixel 7',         'Screen replacement',          '900'),
  ('PM:pixel 7',         'Battery',                     '600'),
  ('PM:pixel 6 pro',     'Screen replacement',          '950'),
  ('PM:pixel 6 pro',     'Battery',                     '600'),
  ('PM:pixel 6 a',       'Screen replacement',          '1050'),
  ('PM:pixel 6',         'Screen replacement',          '1050'),
  ('PM:pixel 5 a',       'Screen replacement',          '1050'),
  ('PM:pixel 4a',        'Screen replacement',          '850'),
  ('PM:pixel 4a',        'Battery',                     '500'),
  ('PM:pixel 3a',        'Screen replacement',          '675'),
  ('PM:pixel 3',         'Screen replacement',          '750'),
  ('PM:pixel 3',         'Battery',                     '500')
ON CONFLICT (model_id, repair_type) DO NOTHING;
