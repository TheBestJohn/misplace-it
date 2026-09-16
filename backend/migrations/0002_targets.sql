-- Goals and budgets.
--
-- A target now carries a DIRECTION as well as an amount:
--   * 'budget' is a ceiling  — "stay under 2200 kcal". Exceeding it is bad.
--   * 'goal'   is a floor    — "hit at least 160 g protein". Exceeding it is fine.
--
-- Why a table instead of more columns on `users`: with a direction, every
-- nutrient needs two columns (amount + kind). Covering calories, the three
-- macros, fibre, sugar, saturated fat and sodium would mean sixteen nullable
-- columns on `users`, and adding a ninth nutrient later would mean another
-- ALTER TABLE. One row per target makes "which targets has this user set" a
-- query rather than a sixteen-way null check, and adding a nutrient becomes a
-- data concern rather than a schema change.

CREATE TABLE nutrition_targets (
    user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    nutrient   TEXT NOT NULL,
    amount     DOUBLE PRECISION NOT NULL CHECK (amount > 0),
    kind       TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    PRIMARY KEY (user_id, nutrient),

    CONSTRAINT nutrition_targets_kind_known CHECK (kind IN ('goal', 'budget')),

    -- Keeping the nutrient vocabulary in the database as well as in the API
    -- means a typo cannot quietly create a target nothing will ever total up.
    CONSTRAINT nutrition_targets_nutrient_known CHECK (nutrient IN (
        'calories_kcal', 'protein_g', 'carbs_g', 'fat_g',
        'fiber_g', 'sugar_g', 'saturated_fat_g', 'sodium_mg'
    ))
);

-- Carry existing targets over. Calories, carbs and fat become budgets and
-- protein becomes a goal, which is how they were already being used: the old
-- UI treated every one as "don't exceed", which was only ever right for three
-- of the four.
INSERT INTO nutrition_targets (user_id, nutrient, amount, kind)
SELECT id, 'calories_kcal', daily_calorie_target, 'budget'
  FROM users WHERE daily_calorie_target > 0
UNION ALL
SELECT id, 'protein_g', daily_protein_target_g, 'goal'
  FROM users WHERE daily_protein_target_g > 0
UNION ALL
SELECT id, 'carbs_g', daily_carbs_target_g, 'budget'
  FROM users WHERE daily_carbs_target_g > 0
UNION ALL
SELECT id, 'fat_g', daily_fat_target_g, 'budget'
  FROM users WHERE daily_fat_target_g > 0;

ALTER TABLE users
    DROP COLUMN daily_calorie_target,
    DROP COLUMN daily_protein_target_g,
    DROP COLUMN daily_carbs_target_g,
    DROP COLUMN daily_fat_target_g;
