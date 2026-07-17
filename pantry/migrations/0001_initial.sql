-- Pantry module initial schema
-- Schema: module_pantry (set by Core before running this file via SET search_path)

-- Categories (e.g. "Canned goods", "Dairy", "Spices")
CREATE TABLE IF NOT EXISTS categories (
    id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    name        TEXT        NOT NULL UNIQUE,
    sort_order  INT         NOT NULL DEFAULT 0,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Core pantry item table. Single-location (project decision 2026-07-18, no
-- more per-location/cross-location scope) - "location" here just means the
-- storage spot within the one household (cellar, fridge, pantry shelf), a
-- free-text field, not a ModuLab location scope.
CREATE TABLE IF NOT EXISTS pantry_items (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    name            TEXT        NOT NULL,
    category_id     UUID        REFERENCES categories(id) ON DELETE SET NULL,
    quantity        NUMERIC(10,3) NOT NULL DEFAULT 0,
    unit            TEXT,                              -- "pcs", "kg", "l", ...
    location        TEXT,                              -- "Cellar", "Fridge", "Pantry shelf", ...
    expiry_date     DATE,
    min_stock       NUMERIC(10,3),                      -- null = no low-stock alert for this item
    notes           TEXT,
    image_path      TEXT,                               -- relative path in module storage (item photo)
    added_via       TEXT        NOT NULL DEFAULT 'manual' CHECK (added_via IN ('manual', 'ai_scan')),
    created_by      TEXT        NOT NULL,               -- user ID from auth context
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS pantry_items_category_id_idx ON pantry_items(category_id);
CREATE INDEX IF NOT EXISTS pantry_items_created_by_idx  ON pantry_items(created_by);
CREATE INDEX IF NOT EXISTS pantry_items_expiry_date_idx ON pantry_items(expiry_date);

-- AI provider config for receipt scanning: per-provider API key, encrypted
-- entirely within this module (same pattern as recipes'
-- ai_nutrition_providers - own schema + own AES-256-GCM encryption via
-- MODULAB_MODULE_PII_KEY, encrypted/decrypted only in handlers/crypto.ts).
-- Only vision-capable providers (see manifest.yaml egress_allowlist comment).
CREATE TABLE IF NOT EXISTS ai_pantry_providers (
    id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    provider       TEXT        NOT NULL UNIQUE CHECK (provider IN ('openai', 'google', 'anthropic')),
    api_key_enc    TEXT        NOT NULL,           -- AES-256-GCM encrypted (base64)
    model          TEXT        NOT NULL,           -- e.g. "gpt-5.6", "gemini-3.1-flash", "claude-haiku-4-5"
    enabled        BOOLEAN     NOT NULL DEFAULT true,
    is_default     BOOLEAN     NOT NULL DEFAULT false,
    created_by_enc TEXT        NOT NULL,           -- AES-256-GCM encrypted (base64), admin's email
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- At most one default provider at a time (used when POST /scan is called
-- without an explicit provider).
CREATE UNIQUE INDEX IF NOT EXISTS ai_pantry_providers_one_default_idx
    ON ai_pantry_providers (is_default) WHERE is_default;

-- Seed a few default categories
INSERT INTO categories (name, sort_order) VALUES
    ('Canned goods', 10),
    ('Dry goods',     20),
    ('Dairy',         30),
    ('Frozen',        40),
    ('Spices',        50),
    ('Beverages',     60),
    ('Household',     70)
ON CONFLICT (name) DO NOTHING;
