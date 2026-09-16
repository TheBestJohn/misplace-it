-- How a food's numbers are naturally quoted.
--
-- Everything is still *stored* per 100 g — that invariant is what makes a
-- recipe row, a diary entry and a day's total one multiplication each, and it
-- is not worth giving up. But it is not how the numbers arrive.
--
-- USDA and Open Food Facts publish per 100 g, so an import needs no thought. A
-- person adding a food is almost always reading a nutrition label, and a label
-- states one serving: "Serving size 28 g · Calories 140". Asking them for the
-- per-100 g figure asks them to divide by 0.28 in their head, and getting it
-- wrong does not fail — it silently stores a food that is 3.5x too rich. In a
-- database anyone can edit, the next person then sees 500 kcal, believes the
-- entry is wrong, and "fixes" it.
--
-- So the basis becomes a property of the food: the one it was entered in and
-- should be shown in. Storage does not change; presentation and entry follow
-- the label.
ALTER TABLE foods
    ADD COLUMN nutrient_basis TEXT NOT NULL DEFAULT 'per_100g'
        CHECK (nutrient_basis IN ('per_100g', 'per_serving'));

-- Existing rows keep 'per_100g'. Guessing which of them came off a label would
-- be worse than leaving them as they are: a wrong guess here re-labels correct
-- numbers, which is exactly the confusion this column exists to prevent.
