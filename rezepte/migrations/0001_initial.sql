-- Rezepte module initial schema
-- Schema: module_rezepte (set by Core before running this file via SET search_path)

-- Categories (e.g. "Frühstück", "Hauptgericht", "Dessert")
CREATE TABLE IF NOT EXISTS categories (
    id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    name        TEXT        NOT NULL UNIQUE,
    sort_order  INT         NOT NULL DEFAULT 0,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Tags (free-form labels like "vegan", "schnell", "glutenfrei")
CREATE TABLE IF NOT EXISTS tags (
    id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    name        TEXT        NOT NULL UNIQUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Core recipe table
CREATE TABLE IF NOT EXISTS recipes (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    title           TEXT        NOT NULL,
    description     TEXT        NOT NULL DEFAULT '',
    category_id     UUID        REFERENCES categories(id) ON DELETE SET NULL,
    servings        INT         NOT NULL DEFAULT 4,
    prep_time_min   INT,                             -- Vorbereitungszeit in Minuten
    cook_time_min   INT,                             -- Kochzeit in Minuten
    image_path      TEXT,                            -- relativer Pfad in module storage
    source_url      TEXT,                            -- Original-URL (bei URL-Import)
    -- Nährwerte pro Portion (Quell: Open Food Facts oder manuell)
    kcal_per_serving        NUMERIC(8,2),
    protein_g_per_serving   NUMERIC(8,2),
    fat_g_per_serving       NUMERIC(8,2),
    carbs_g_per_serving     NUMERIC(8,2),
    fiber_g_per_serving     NUMERIC(8,2),
    nutrition_source        TEXT    CHECK (nutrition_source IN ('manual', 'off', 'calculated')),
    created_by      TEXT        NOT NULL,            -- user ID from auth context
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS recipes_category_id_idx ON recipes(category_id);
CREATE INDEX IF NOT EXISTS recipes_created_by_idx  ON recipes(created_by);

-- Ingredients per recipe (ordered by position)
CREATE TABLE IF NOT EXISTS ingredients (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    recipe_id       UUID        NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
    position        INT         NOT NULL DEFAULT 0,
    name            TEXT        NOT NULL,
    amount          NUMERIC(10,3),                   -- null = "nach Geschmack"
    unit            TEXT,                            -- "g", "ml", "EL", "Prise" …
    -- Nährwerte dieser Zutat (aus Open Food Facts, pro 100g Basis)
    off_product_id  TEXT,                            -- Open Food Facts barcode / id
    kcal_per_100g   NUMERIC(8,2),
    protein_per_100g NUMERIC(8,2),
    fat_per_100g    NUMERIC(8,2),
    carbs_per_100g  NUMERIC(8,2),
    fiber_per_100g  NUMERIC(8,2)
);

CREATE INDEX IF NOT EXISTS ingredients_recipe_id_idx ON ingredients(recipe_id);

-- Preparation steps (ordered by step_number)
CREATE TABLE IF NOT EXISTS recipe_steps (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    recipe_id       UUID        NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
    step_number     INT         NOT NULL,
    instruction     TEXT        NOT NULL,
    image_path      TEXT                             -- optionales Schritt-Bild
);

CREATE UNIQUE INDEX IF NOT EXISTS recipe_steps_recipe_step_idx ON recipe_steps(recipe_id, step_number);

-- Many-to-many: recipes ↔ tags
CREATE TABLE IF NOT EXISTS recipe_tags (
    recipe_id   UUID    NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
    tag_id      UUID    NOT NULL REFERENCES tags(id)    ON DELETE CASCADE,
    PRIMARY KEY (recipe_id, tag_id)
);

-- Shared weekly meal plan (one per week, identified by ISO week start date)
CREATE TABLE IF NOT EXISTS meal_plan_entries (
    id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    week_start  DATE        NOT NULL,                -- Montag der Woche (ISO)
    day_of_week SMALLINT    NOT NULL CHECK (day_of_week BETWEEN 1 AND 7), -- 1=Mo, 7=So
    meal_slot   TEXT        NOT NULL CHECK (meal_slot IN ('breakfast', 'lunch', 'dinner', 'snack')),
    recipe_id   UUID        REFERENCES recipes(id) ON DELETE SET NULL,
    note        TEXT,                                -- für freie Einträge ohne Rezept
    created_by  TEXT        NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (week_start, day_of_week, meal_slot)
);

CREATE INDEX IF NOT EXISTS meal_plan_week_idx ON meal_plan_entries(week_start);

-- Seed a few default categories
INSERT INTO categories (name, sort_order) VALUES
    ('Frühstück',   10),
    ('Hauptgericht', 20),
    ('Beilage',      30),
    ('Suppe',        40),
    ('Salat',        50),
    ('Dessert',      60),
    ('Snack',        70),
    ('Getränk',      80)
ON CONFLICT (name) DO NOTHING;
