-- Core schema for nom-inal.
--
-- Nutrient design note: every food stores its nutrients on a canonical
-- "per 100 g" basis. Both of the external sources we import from (USDA
-- FoodData Central and Open Food Facts) publish per-100g values, so importing
-- is lossless, and every derived number (a serving, a recipe row, a diary
-- entry) is a single multiplication by grams/100.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

CREATE TABLE users (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email           TEXT NOT NULL UNIQUE,
    password_hash   TEXT NOT NULL,
    display_name    TEXT NOT NULL,

    -- profile / goals
    sex             TEXT,
    birth_date      DATE,
    height_cm       DOUBLE PRECISION,
    activity_level  TEXT NOT NULL DEFAULT 'moderate',
    goal            TEXT NOT NULL DEFAULT 'maintain',
    target_weight_kg    DOUBLE PRECISION,
    daily_calorie_target DOUBLE PRECISION,
    daily_protein_target_g DOUBLE PRECISION,
    daily_carbs_target_g   DOUBLE PRECISION,
    daily_fat_target_g     DOUBLE PRECISION,

    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX users_email_lower_idx ON users (lower(email));

CREATE TABLE weight_entries (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    recorded_on   DATE NOT NULL,
    weight_kg     DOUBLE PRECISION NOT NULL CHECK (weight_kg > 0 AND weight_kg < 700),
    body_fat_pct  DOUBLE PRECISION CHECK (body_fat_pct >= 0 AND body_fat_pct <= 100),
    note          TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (user_id, recorded_on)
);

CREATE INDEX weight_entries_user_date_idx ON weight_entries (user_id, recorded_on DESC);

CREATE TABLE foods (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- 'custom' = user authored, 'usda' = FoodData Central, 'off' = Open Food Facts
    source          TEXT NOT NULL DEFAULT 'custom',
    source_id       TEXT,

    name            TEXT NOT NULL,
    brand           TEXT,
    upc             TEXT,

    -- nutrients, per 100 g
    calories_kcal   DOUBLE PRECISION NOT NULL DEFAULT 0 CHECK (calories_kcal >= 0),
    protein_g       DOUBLE PRECISION NOT NULL DEFAULT 0 CHECK (protein_g >= 0),
    carbs_g         DOUBLE PRECISION NOT NULL DEFAULT 0 CHECK (carbs_g >= 0),
    fat_g           DOUBLE PRECISION NOT NULL DEFAULT 0 CHECK (fat_g >= 0),
    fiber_g         DOUBLE PRECISION,
    sugar_g         DOUBLE PRECISION,
    saturated_fat_g DOUBLE PRECISION,
    sodium_mg       DOUBLE PRECISION,

    -- what "1 serving" means for this food, in grams
    serving_size_g  DOUBLE PRECISION NOT NULL DEFAULT 100 CHECK (serving_size_g > 0),
    serving_label   TEXT,

    created_by      UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per external item: re-importing the same USDA/OFF food is a no-op.
CREATE UNIQUE INDEX foods_source_unique_idx
    ON foods (source, source_id)
    WHERE source_id IS NOT NULL;

CREATE INDEX foods_upc_idx ON foods (upc) WHERE upc IS NOT NULL;
CREATE INDEX foods_name_trgm_idx ON foods USING GIN (name gin_trgm_ops);
CREATE INDEX foods_created_by_idx ON foods (created_by);

CREATE TABLE recipes (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    description  TEXT,
    instructions TEXT,
    servings     DOUBLE PRECISION NOT NULL DEFAULT 1 CHECK (servings > 0),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX recipes_user_idx ON recipes (user_id, name);

CREATE TABLE recipe_items (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    recipe_id   UUID NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
    food_id     UUID NOT NULL REFERENCES foods(id) ON DELETE RESTRICT,
    quantity_g  DOUBLE PRECISION NOT NULL CHECK (quantity_g > 0),
    note        TEXT,
    sort_order  INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX recipe_items_recipe_idx ON recipe_items (recipe_id, sort_order);

CREATE TABLE diary_entries (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    logged_on   DATE NOT NULL,
    meal        TEXT NOT NULL DEFAULT 'snack',

    food_id     UUID REFERENCES foods(id) ON DELETE RESTRICT,
    recipe_id   UUID REFERENCES recipes(id) ON DELETE RESTRICT,

    -- grams when logging a food, number of recipe servings when logging a recipe
    quantity_g      DOUBLE PRECISION CHECK (quantity_g > 0),
    recipe_servings DOUBLE PRECISION CHECK (recipe_servings > 0),

    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- an entry is exactly one of "a food, in grams" or "a recipe, in servings"
    CONSTRAINT diary_entry_target_xor CHECK (
        (food_id IS NOT NULL AND recipe_id IS NULL AND quantity_g IS NOT NULL AND recipe_servings IS NULL)
        OR
        (recipe_id IS NOT NULL AND food_id IS NULL AND recipe_servings IS NOT NULL AND quantity_g IS NULL)
    )
);

CREATE INDEX diary_entries_user_date_idx ON diary_entries (user_id, logged_on DESC);
