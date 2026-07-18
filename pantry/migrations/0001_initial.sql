-- Pantry module initial schema
-- Schema: module_pantry (set by Core before running this file via SET search_path)

-- Categories (e.g. "Canned goods", "Dairy", "Spices"). No seed rows
-- (2026-07-18 user request) - admins build their own list from scratch via
-- the Categories tab, same as they now do for locations below.
CREATE TABLE IF NOT EXISTS categories (
    id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    name        TEXT        NOT NULL UNIQUE,
    sort_order  INT         NOT NULL DEFAULT 0,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Storage locations within the one household (cellar, fridge, pantry shelf) -
-- managed the same way as categories (2026-07-18 user request: was a free-
-- text field on pantry_items, now its own admin-managed list, so it can't
-- drift into a dozen near-duplicate spellings of "fridge"). Not a ModuLab
-- location/scope concept (see single-location decision, project memory) -
-- purely "where in the house is this stored."
CREATE TABLE IF NOT EXISTS locations (
    id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    name        TEXT        NOT NULL UNIQUE,
    sort_order  INT         NOT NULL DEFAULT 0,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Pantry items: ITEM = PRODUCT (2026-07-18 redesign). One row per distinct
-- product ("Steaks"), never duplicated - quantity, expiry date, and storage
-- location live on pantry_item_batches below instead, because a household
-- routinely buys the same product more than once with a different
-- best-before date each time (bought steaks on Jan 1 with a Jan-1 date, then
-- more steaks on Apr 1 with an Apr-1 date - same product, two batches, not
-- two pantry items). min_stock/is_low_stock is evaluated against the SUM of
-- all of an item's batch quantities (see handlers/index.ts listItems).
CREATE TABLE IF NOT EXISTS pantry_items (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    name            TEXT        NOT NULL,
    category_id     UUID        REFERENCES categories(id) ON DELETE SET NULL,
    unit            TEXT,                              -- free text, e.g. "pcs"/"kg" - UI offers a translated datalist
    min_stock       NUMERIC(10,3),                      -- null = no low-stock alert for this item
    notes           TEXT,
    image_path      TEXT,                               -- relative path in module storage (item photo)
    created_by      TEXT        NOT NULL,               -- user ID from auth context
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Case-insensitive uniqueness on the product name - the whole point of this
-- redesign is exactly one row per distinct product, so "Steaks" and "steaks"
-- must collide rather than silently becoming two items again.
CREATE UNIQUE INDEX IF NOT EXISTS pantry_items_name_lower_idx ON pantry_items (lower(name));
CREATE INDEX IF NOT EXISTS pantry_items_category_id_idx ON pantry_items(category_id);
CREATE INDEX IF NOT EXISTS pantry_items_created_by_idx  ON pantry_items(created_by);

-- One row per physical batch/lot of an item - this is where quantity,
-- expiry date, and storage location actually live. Deleting the parent item
-- deletes all its batches (there is no meaningful "batch with no product").
CREATE TABLE IF NOT EXISTS pantry_item_batches (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    item_id         UUID        NOT NULL REFERENCES pantry_items(id) ON DELETE CASCADE,
    quantity        NUMERIC(10,3) NOT NULL DEFAULT 0,
    expiry_date     DATE,
    location_id     UUID        REFERENCES locations(id) ON DELETE SET NULL,
    added_via       TEXT        NOT NULL DEFAULT 'manual' CHECK (added_via IN ('manual', 'ai_scan')),
    created_by      TEXT        NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS pantry_item_batches_item_id_idx     ON pantry_item_batches(item_id);
CREATE INDEX IF NOT EXISTS pantry_item_batches_location_id_idx ON pantry_item_batches(location_id);
CREATE INDEX IF NOT EXISTS pantry_item_batches_expiry_date_idx ON pantry_item_batches(expiry_date);

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
