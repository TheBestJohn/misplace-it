-- Food provenance: variants, revision history and community verification.
--
-- The food table is global and open to editing, which makes it a shared
-- document rather than a personal record. Three things follow from that, and
-- this migration adds them:
--
--   1. Variants. "Chicken breast" raw and cooked are different numbers for the
--      same underlying thing. Modelling them as unrelated rows loses that, and
--      modelling them as one row with a modifier loses the ability to log one
--      of them. A variant is therefore its own food that points at a parent.
--
--   2. History. Every state a food has ever been in is kept, with who put it
--      there. This is what makes an open wiki safe to edit: a bad change is
--      visible and reversible instead of destructive.
--
--   3. Verification. Agreement is tracked per revision, so an edit
--      automatically invalidates the confidence earned by the text it
--      replaced. Nobody has to remember to reset anything.

-- ---------------------------------------------------------------------------
-- Variants
-- ---------------------------------------------------------------------------

ALTER TABLE foods
    ADD COLUMN variant_of    UUID REFERENCES foods(id) ON DELETE CASCADE,
    ADD COLUMN variant_label TEXT,
    -- Monotonic edit counter. Also the "has a human touched this" marker that
    -- re-import consults, so a local correction is never silently overwritten
    -- by a refresh from USDA or Open Food Facts.
    ADD COLUMN revision      INTEGER NOT NULL DEFAULT 1,
    ADD COLUMN verified_at   TIMESTAMPTZ;

ALTER TABLE foods
    ADD CONSTRAINT foods_variant_label_paired
        CHECK ((variant_of IS NULL) = (variant_label IS NULL)),
    ADD CONSTRAINT foods_variant_not_self
        CHECK (variant_of IS DISTINCT FROM id);

-- Two "cooked" variants of the same parent would be a data-entry mistake every
-- time, so the database refuses rather than leaving it to the client.
CREATE UNIQUE INDEX foods_variant_label_unique_idx
    ON foods (variant_of, lower(btrim(variant_label)))
    WHERE variant_of IS NOT NULL;

CREATE INDEX foods_variant_of_idx ON foods (variant_of) WHERE variant_of IS NOT NULL;

-- Variants are one level deep on purpose: "cooked, then diced, then frozen"
-- is a naming problem, not a tree, and an arbitrary hierarchy would make every
-- rollup query recursive for no gain.
CREATE FUNCTION foods_variant_depth() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.variant_of IS NULL THEN
        RETURN NEW;
    END IF;

    IF EXISTS (SELECT 1 FROM foods WHERE id = NEW.variant_of AND variant_of IS NOT NULL) THEN
        RAISE EXCEPTION 'a variant cannot be a variant of another variant'
            USING ERRCODE = 'check_violation';
    END IF;

    IF EXISTS (SELECT 1 FROM foods WHERE variant_of = NEW.id) THEN
        RAISE EXCEPTION 'a food that already has variants cannot become a variant'
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN NEW;
END $$;

CREATE TRIGGER foods_variant_depth_trg
    BEFORE INSERT OR UPDATE OF variant_of ON foods
    FOR EACH ROW EXECUTE FUNCTION foods_variant_depth();

-- ---------------------------------------------------------------------------
-- Revision history
-- ---------------------------------------------------------------------------

-- The snapshot is JSONB rather than a typed mirror of `foods`. The nutrient
-- list is the part of this schema most likely to keep growing, and a mirror
-- table would mean every new nutrient needs two migrations, two INSERT lists
-- and a backfill that can silently disagree. History is written once and read
-- for display and rollback, never joined on, so the structure buys nothing.
CREATE TABLE food_revisions (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    food_id     UUID NOT NULL REFERENCES foods(id) ON DELETE CASCADE,
    revision    INTEGER NOT NULL,
    -- 'create' | 'edit' | 'import' | 'revert' | 'seed'
    change_kind TEXT NOT NULL,
    edited_by   UUID REFERENCES users(id) ON DELETE SET NULL,
    summary     TEXT,
    snapshot    JSONB NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (food_id, revision)
);

CREATE INDEX food_revisions_food_idx ON food_revisions (food_id, revision DESC);
CREATE INDEX food_revisions_editor_idx ON food_revisions (edited_by) WHERE edited_by IS NOT NULL;

-- The editable content of a food, with bookkeeping stripped. Used both to
-- decide whether an UPDATE actually changed anything and as the stored
-- snapshot, so the two can never disagree about what "a change" means.
CREATE FUNCTION food_snapshot(f foods) RETURNS JSONB
LANGUAGE sql IMMUTABLE AS $$
    SELECT to_jsonb(f)
         - 'id' - 'created_at' - 'updated_at' - 'revision' - 'verified_at' - 'created_by';
$$;

CREATE FUNCTION foods_bump_revision() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF food_snapshot(NEW) IS DISTINCT FROM food_snapshot(OLD) THEN
        NEW.revision   := OLD.revision + 1;
        NEW.updated_at := now();
        -- Confidence was earned by the previous numbers, not these ones.
        NEW.verified_at := NULL;
    ELSE
        NEW.revision := OLD.revision;
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER foods_bump_revision_trg
    BEFORE UPDATE ON foods
    FOR EACH ROW EXECUTE FUNCTION foods_bump_revision();

-- Attribution arrives through transaction-local settings rather than a column
-- on the statement, because the alternative is for every write path to
-- remember to append its own history row. With the trigger owning the write,
-- forgetting to set `nom_inal.actor` costs the author's name on one revision;
-- forgetting an explicit INSERT would cost the revision entirely.
CREATE FUNCTION foods_write_revision() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    actor UUID   := nullif(current_setting('nom_inal.actor', true), '')::uuid;
    note  TEXT   := nullif(current_setting('nom_inal.edit_summary', true), '');
    kind  TEXT   := nullif(current_setting('nom_inal.change_kind', true), '');
BEGIN
    INSERT INTO food_revisions (food_id, revision, change_kind, edited_by, summary, snapshot)
    VALUES (
        NEW.id,
        NEW.revision,
        coalesce(kind, CASE WHEN TG_OP = 'INSERT' THEN 'create' ELSE 'edit' END),
        coalesce(actor, NEW.created_by),
        note,
        food_snapshot(NEW)
    );
    RETURN NULL;
END $$;

CREATE TRIGGER foods_write_revision_insert_trg
    AFTER INSERT ON foods
    FOR EACH ROW EXECUTE FUNCTION foods_write_revision();

-- Only fires when the BEFORE trigger above decided something actually changed,
-- so touching `updated_at` or `verified_at` alone does not manufacture history.
CREATE TRIGGER foods_write_revision_update_trg
    AFTER UPDATE ON foods
    FOR EACH ROW
    WHEN (NEW.revision IS DISTINCT FROM OLD.revision)
    EXECUTE FUNCTION foods_write_revision();

-- Existing rows get the revision 1 they would have had if history had always
-- been recorded, backdated to their creation.
INSERT INTO food_revisions (food_id, revision, change_kind, edited_by, summary, snapshot, created_at)
SELECT f.id,
       1,
       CASE WHEN f.source = 'custom' THEN 'create' ELSE 'import' END,
       f.created_by,
       'initial revision, recorded when history tracking was added',
       food_snapshot(f),
       f.created_at
FROM foods f;

-- ---------------------------------------------------------------------------
-- Verification
-- ---------------------------------------------------------------------------

-- Keyed on (food, revision, user). Making the revision part of the key is what
-- gives the quorum its meaning: a vote endorses a specific set of numbers, and
-- an edit produces a new revision with no votes at all, rather than inheriting
-- agreement that was never given to it.
CREATE TABLE food_verifications (
    food_id    UUID NOT NULL REFERENCES foods(id) ON DELETE CASCADE,
    revision   INTEGER NOT NULL,
    user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    verdict    TEXT NOT NULL CHECK (verdict IN ('confirm', 'dispute')),
    note       TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (food_id, revision, user_id)
);

CREATE INDEX food_verifications_food_idx ON food_verifications (food_id, revision);
