-- Foods become global; recipes become private-by-default with opt-in sharing.
--
-- These two pull in opposite directions on purpose. A food is a fact about a
-- product — "oats are 379 kcal per 100 g" is true for everyone, and making each
-- account re-import the same barcode is pure duplication. A recipe is
-- authorship: yours until you choose to share it.

-- Foods need no column change to go global — visibility was only ever enforced
-- in the queries. But `created_by` stays: it still decides who may EDIT a food,
-- and it drives the "mine" filter.
--
-- Brand gets its own trigram index so a fuzzy search can match "kelogs" against
-- the brand as well as the product name.
CREATE INDEX foods_brand_trgm_idx ON foods USING GIN (brand gin_trgm_ops)
    WHERE brand IS NOT NULL;

-- Recipes are visible to their owner, or to everyone once marked public.
ALTER TABLE recipes ADD COLUMN is_public BOOLEAN NOT NULL DEFAULT FALSE;

-- Partial index: the overwhelming majority of rows are private, so indexing
-- only the public ones keeps the browse-public-recipes query cheap.
CREATE INDEX recipes_public_idx ON recipes (is_public, name) WHERE is_public;
