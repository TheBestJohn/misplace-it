-- An ingredient that is just words.
--
-- "Salt and pepper to taste", "a squeeze of lemon", "2 cloves garlic" — things
-- a recipe needs to say and nobody wants to create a database entry for. They
-- carry no nutrition, which is the point: inventing a food row for a pinch of
-- salt would put a fake entry in a shared, community-edited database to record
-- something that rounds to nothing.
--
-- One field, not an amount plus a name. Splitting "a squeeze of lemon" into a
-- quantity and a unit means parsing units this application does not model, and
-- the result would be a number that looks meaningful and is not.
ALTER TABLE recipe_items ADD COLUMN label TEXT;

ALTER TABLE recipe_items DROP CONSTRAINT recipe_item_target_xor;

ALTER TABLE recipe_items
    ADD CONSTRAINT recipe_item_target_xor CHECK (
        (food_id IS NOT NULL AND sub_recipe_id IS NULL AND label IS NULL
         AND quantity_g IS NOT NULL AND servings IS NULL)
        OR
        (sub_recipe_id IS NOT NULL AND food_id IS NULL AND label IS NULL
         AND servings IS NOT NULL AND quantity_g IS NULL)
        OR
        -- A label carries no quantity at all. A gram figure next to an
        -- ingredient that contributes nothing would be a number the totals
        -- deliberately ignore, which is worse than no number.
        (label IS NOT NULL AND food_id IS NULL AND sub_recipe_id IS NULL
         AND quantity_g IS NULL AND servings IS NULL)
    ),
    ADD CONSTRAINT recipe_item_label_not_blank
        CHECK (label IS NULL OR btrim(label) <> '');

-- ---------------------------------------------------------------------------
-- Totals, now also reporting what they had to leave out
-- ---------------------------------------------------------------------------

-- Nutrients need no change: a label joins to no food, so it contributes
-- nothing on its own. The count does need adding, and it belongs here rather
-- than beside each caller — a recipe whose macros silently exclude three
-- ingredients is exactly the kind of quiet wrongness this codebase keeps
-- trying to make loud, and the only honest place to notice it is the same
-- walk that produced the numbers.
--
-- Counted through nesting, because a sub-recipe's "salt to taste" leaves the
-- parent's figures just as incomplete. DISTINCT so an ingredient reached by
-- two paths through a diamond is still one ingredient missing its nutrition.
DROP FUNCTION recipe_totals(UUID);

CREATE FUNCTION recipe_totals(root UUID)
RETURNS TABLE (
    calories_kcal   DOUBLE PRECISION,
    protein_g       DOUBLE PRECISION,
    carbs_g         DOUBLE PRECISION,
    fat_g           DOUBLE PRECISION,
    fiber_g         DOUBLE PRECISION,
    sugar_g         DOUBLE PRECISION,
    saturated_fat_g DOUBLE PRECISION,
    sodium_mg       DOUBLE PRECISION,
    weight_g        DOUBLE PRECISION,
    untracked_count BIGINT
)
LANGUAGE sql STABLE AS $$
    WITH RECURSIVE node(recipe_id, multiplier, depth) AS (
        SELECT root, 1.0::double precision, 1
        UNION ALL
        SELECT ri.sub_recipe_id,
               node.multiplier * ri.servings / sub.servings,
               node.depth + 1
        FROM node
        JOIN recipe_items ri
          ON ri.recipe_id = node.recipe_id AND ri.sub_recipe_id IS NOT NULL
        JOIN recipes sub ON sub.id = ri.sub_recipe_id
        WHERE node.depth < recipe_max_depth()
    )
    SELECT
        coalesce(sum(f.calories_kcal              * ri.quantity_g / 100.0 * node.multiplier), 0),
        coalesce(sum(f.protein_g                  * ri.quantity_g / 100.0 * node.multiplier), 0),
        coalesce(sum(f.carbs_g                    * ri.quantity_g / 100.0 * node.multiplier), 0),
        coalesce(sum(f.fat_g                      * ri.quantity_g / 100.0 * node.multiplier), 0),
        coalesce(sum(coalesce(f.fiber_g, 0)         * ri.quantity_g / 100.0 * node.multiplier), 0),
        coalesce(sum(coalesce(f.sugar_g, 0)         * ri.quantity_g / 100.0 * node.multiplier), 0),
        coalesce(sum(coalesce(f.saturated_fat_g, 0) * ri.quantity_g / 100.0 * node.multiplier), 0),
        coalesce(sum(coalesce(f.sodium_mg, 0)       * ri.quantity_g / 100.0 * node.multiplier), 0),
        coalesce(sum(ri.quantity_g * node.multiplier), 0),
        (SELECT count(DISTINCT untracked.id)
           FROM node reached
           JOIN recipe_items untracked
             ON untracked.recipe_id = reached.recipe_id AND untracked.label IS NOT NULL)
    FROM node
    JOIN recipe_items ri ON ri.recipe_id = node.recipe_id AND ri.food_id IS NOT NULL
    JOIN foods f ON f.id = ri.food_id;
$$;
