-- Vacation Spots module initial schema
-- Schema: module_vacation_spots (set by Core before running this file via SET search_path)

-- Categories (e.g. "Restaurant", "Beach", "Sight")
CREATE TABLE IF NOT EXISTS categories (
    id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    name        TEXT        NOT NULL UNIQUE,
    color       TEXT        NOT NULL DEFAULT '#888780',  -- hex color for map marker
    icon        TEXT        NOT NULL DEFAULT 'ti-map-pin', -- Tabler icon name
    sort_order  INT         NOT NULL DEFAULT 0,
    created_by  TEXT        NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Trips (e.g. "Sardinia 2025")
CREATE TABLE IF NOT EXISTS trips (
    id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    name        TEXT        NOT NULL,
    year        SMALLINT,
    description TEXT        NOT NULL DEFAULT '',
    created_by  TEXT        NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Spots — core table
CREATE TABLE IF NOT EXISTS spots (
    id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    trip_id     UUID        REFERENCES trips(id) ON DELETE SET NULL,
    category_id UUID        REFERENCES categories(id) ON DELETE SET NULL,
    name_enc    TEXT        NOT NULL,   -- AES-256-GCM encrypted spot name (base64)
    note_enc    TEXT,                   -- AES-256-GCM encrypted free-text note (base64)
    lat         DOUBLE PRECISION NOT NULL,
    lng         DOUBLE PRECISION NOT NULL,
    rating      SMALLINT    CHECK (rating BETWEEN 1 AND 5),
    created_by  TEXT        NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS spots_trip_id_idx     ON spots(trip_id);
CREATE INDEX IF NOT EXISTS spots_category_id_idx ON spots(category_id);
CREATE INDEX IF NOT EXISTS spots_created_by_idx  ON spots(created_by);

-- Photos per spot (multiple allowed)
CREATE TABLE IF NOT EXISTS spot_photos (
    id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    spot_id     UUID        NOT NULL REFERENCES spots(id) ON DELETE CASCADE,
    file_path   TEXT        NOT NULL,   -- relative path in module storage
    position    INT         NOT NULL DEFAULT 0,
    created_by  TEXT        NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS spot_photos_spot_id_idx ON spot_photos(spot_id);

-- Seed default categories — REMOVED 2026-07-03 (0003_remove_seed_categories.sql
-- deletes them again for already-installed instances). Users build their own
-- category list from scratch instead of starting from these five defaults.
-- Left as a comment (not deleted outright) so the history of what a fresh
-- 0001 install used to create is still visible in this file.
-- INSERT INTO categories (name, color, icon, sort_order, created_by) VALUES
--     ('Restaurant', '#D85A30', 'ti-tools-kitchen-2', 10, 'system'),
--     ('Beach',      '#1D9E75', 'ti-umbrella',         20, 'system'),
--     ('Sight',      '#7F77DD', 'ti-camera',           30, 'system'),
--     ('Hotel',      '#185FA5', 'ti-bed',              40, 'system'),
--     ('Other',      '#888780', 'ti-map-pin',          50, 'system')
-- ON CONFLICT (name) DO NOTHING;
