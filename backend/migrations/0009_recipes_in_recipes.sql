-- A recipe can be an ingredient of another recipe.
--
-- Modelled as a link, not a copy: a sub-recipe item stores a reference and a
-- number of servings, and the parent's macros are derived from whatever the
-- sub-recipe says today. Copying the ingredients in would freeze them, and the
-- first time someone corrected the base sauce every dish built on it would
-- quietly keep the old numbers.
--
-- The shape is the same XOR the diary already uses for its entries: a row is
-- either *a food, in grams* or *a recipe, in servings*, never both and never
-- neither, enforced by the database rather than by whoever writes the next
-- handler.

ALTER TABLE recipe_items
    ALTER COLUMN food_id DROP NOT NULL,
    ALTER COLUMN quantity_g DROP NOT NULL,
    ADD COLUMN sub_recipe_id UUID REFERENCES recipes(id) ON DELETE RESTRICT,
    ADD COLUMN servings DOUBLE PRECISION CHECK (servings > 0);

ALTER TABLE recipe_items
    ADD CONSTRAINT recipe_item_target_xor CHECK (
        (food_id IS NOT NULL AND sub_recipe_id IS NULL
         AND quantity_g IS NOT NULL AND servings IS NULL)
        OR
        (sub_recipe_id IS NOT NULL AND food_id IS NULL
         AND servings IS NOT NULL AND quantity_g IS NULL)
    ),
    -- The one-step case of the cycle check below. Cheap, and it makes the
    -- obvious mistake fail with a constraint rather than a trigger.
    ADD CONSTRAINT recipe_item_not_self CHECK (sub_recipe_id IS DISTINCT FROM recipe_id);

CREATE INDEX recipe_items_sub_recipe_idx
    ON recipe_items (sub_recipe_id) WHERE sub_recipe_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Keeping the graph sane
-- ---------------------------------------------------------------------------

-- How deep the nesting may go, counting the outermost recipe as 1.
--
-- The cap is not really about people: nobody builds five levels of sub-recipe.
-- It bounds the read below, which expands the graph path by path. A chain of
-- recipes each containing the next twice has 2^depth paths, so an uncapped
-- depth is a way for one account to make every other account's diary slow.
CREATE FUNCTION recipe_max_depth() RETURNS INTEGER
LANGUAGE sql IMMUTABLE AS $$ SELECT 5 $$;

-- Longest chain of recipes at or below `target`, counting `target` as 1.
--
-- `UNION` rather than `UNION ALL` so the walk terminates on repeated nodes, and
-- the depth guard bounds it even if a cycle somehow exists — these run *while*
-- deciding whether to allow an edge, so they cannot assume the graph is already
-- well formed.
CREATE FUNCTION recipe_height(target UUID) RETURNS INTEGER
LANGUAGE sql STABLE AS $$
    WITH RECURSIVE below(id, depth) AS (
        SELECT target, 1
        UNION
        SELECT ri.sub_recipe_id, below.depth + 1
        FROM below
        JOIN recipe_items ri ON ri.recipe_id = below.id AND ri.sub_recipe_id IS NOT NULL
        WHERE below.depth <= recipe_max_depth() + 1
    )
    SELECT coalesce(max(depth), 1) FROM below;
$$;

/** Longest chain of recipes at or above `target`, counting `target` as 1. */
CREATE FUNCTION recipe_depth_above(target UUID) RETURNS INTEGER
LANGUAGE sql STABLE AS $$
    WITH RECURSIVE above(id, depth) AS (
        SELECT target, 1
        UNION
        SELECT ri.recipe_id, above.depth + 1
        FROM above
        JOIN recipe_items ri ON ri.sub_recipe_id = above.id
        WHERE above.depth <= recipe_max_depth() + 1
    )
    SELECT coalesce(max(depth), 1) FROM above;
$$;

CREATE FUNCTION recipe_items_check_graph() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    resulting_depth INTEGER;
BEGIN
    IF NEW.sub_recipe_id IS NULL THEN
        RETURN NEW;
    END IF;

    -- A cycle is checked before depth because it is the more useful error: the
    -- depth check would also reject it, but with a message about nesting that
    -- would leave someone hunting for a level they did not add.
    IF EXISTS (
        WITH RECURSIVE reachable(id) AS (
            SELECT NEW.sub_recipe_id
            UNION
            SELECT ri.sub_recipe_id
            FROM reachable
            JOIN recipe_items ri ON ri.recipe_id = reachable.id AND ri.sub_recipe_id IS NOT NULL
        )
        SELECT 1 FROM reachable WHERE id = NEW.recipe_id
    ) THEN
        RAISE EXCEPTION 'that would make a recipe contain itself'
            USING ERRCODE = 'check_violation';
    END IF;

    resulting_depth := recipe_depth_above(NEW.recipe_id) + recipe_height(NEW.sub_recipe_id);
    IF resulting_depth > recipe_max_depth() THEN
        RAISE EXCEPTION 'recipes may be nested % levels deep, and this would make %',
            recipe_max_depth(), resulting_depth
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN NEW;
END $$;

CREATE TRIGGER recipe_items_check_graph_trg
    BEFORE INSERT OR UPDATE OF sub_recipe_id ON recipe_items
    FOR EACH ROW EXECUTE FUNCTION recipe_items_check_graph();

-- ---------------------------------------------------------------------------
-- One definition of what a recipe adds up to
-- ---------------------------------------------------------------------------

-- The totals for a whole recipe, resolved through any nesting to the foods at
-- the leaves.
--
-- This existed three times before nesting: a lateral in the recipe list, a
-- lateral in the diary, and a fold in Rust for the detail view. Three copies of
-- the same sum were survivable while it was one flat `sum(... * quantity/100)`;
-- teaching only some of them about sub-recipes would have made a diary entry
-- and the recipe page disagree about the same recipe, which is the kind of bug
-- nobody reports because they assume they misread it.
--
-- The walk carries a multiplier instead of aggregating bottom-up, because a
-- recursive CTE cannot aggregate in its recursive term. Each step multiplies by
-- `servings asked for / servings the sub-recipe makes`, so by the time it
-- reaches a food the factor is exactly that food's share of the outermost
-- recipe.
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
    weight_g        DOUBLE PRECISION
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
        -- Belt and braces: the write-time trigger already refuses anything
        -- deeper, so this guard should never be what stops the walk.
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
        coalesce(sum(ri.quantity_g * node.multiplier), 0)
    FROM node
    JOIN recipe_items ri ON ri.recipe_id = node.recipe_id AND ri.food_id IS NOT NULL
    JOIN foods f ON f.id = ri.food_id;
$$;
