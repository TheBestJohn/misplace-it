-- Instance settings an administrator can change without a redeploy.
--
-- The verification quorum started life as an environment variable, which is the
-- wrong home for it: it is a policy decision about how this community works, it
-- is visible in the admin area, and changing it meant shell access and a
-- restart. It belongs in the database, where the people who can already see it
-- can also change it.

-- One row, enforced by the primary key: `id` can only be TRUE, so a second row
-- is a duplicate key. That means every reader can assume the row exists and
-- nothing needs an "if unset" branch.
CREATE TABLE instance_settings (
    id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),

    -- Net confirmations a food revision needs before it counts as verified.
    -- The ceiling is not a real limit, just a guard against a typo setting it
    -- to a number nothing could ever reach.
    food_quorum INTEGER NOT NULL DEFAULT 2 CHECK (food_quorum BETWEEN 1 AND 50),

    -- NULL means "never configured from the admin area", which is what lets
    -- FOOD_QUORUM still seed a fresh install. Once an administrator saves a
    -- value the environment stops steering it, because otherwise every restart
    -- would silently undo them.
    updated_at TIMESTAMPTZ,
    updated_by UUID REFERENCES users(id) ON DELETE SET NULL
);

INSERT INTO instance_settings (id) VALUES (TRUE);

-- The single definition of the quorum, so no query has to be told what it is
-- and none of them can be left behind when it changes.
CREATE FUNCTION food_quorum() RETURNS BIGINT
LANGUAGE sql STABLE AS $$
    SELECT food_quorum::bigint FROM instance_settings;
$$;

-- Whether a food's current revision has cleared the quorum.
--
-- Extracted from the handler that recomputed it after a vote, because the
-- quorum can now move underneath foods that were settled under the old one.
-- Both the per-vote update and the resettle that follows a settings change call
-- this, so the two cannot drift apart.
CREATE FUNCTION food_is_verified(f_id UUID, f_revision INTEGER) RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
    SELECT count(*) FILTER (WHERE verdict = 'confirm')
         - count(*) FILTER (WHERE verdict = 'dispute') >= food_quorum()
       AND count(*) FILTER (WHERE verdict = 'dispute') = 0
    FROM food_verifications
    WHERE food_id = f_id AND revision = f_revision;
$$;

-- ---------------------------------------------------------------------------
-- Disputed foods, visible without an aggregate
-- ---------------------------------------------------------------------------

-- `verified_at IS NULL` covers two opposite situations: nobody has looked, and
-- somebody looked and objected. A list that renders both as "unverified" hides
-- the one that actually needs attention.
--
-- Counting votes per row would mean an aggregate on every list, and worse, on
-- the tiered streaming search, which exists to be fast. So this follows
-- `verified_at`: a cached answer on the row, recomputed by the same code that
-- recomputes verification and cleared by the same edit trigger.
ALTER TABLE foods ADD COLUMN disputed_at TIMESTAMPTZ;

CREATE INDEX foods_disputed_idx ON foods (disputed_at) WHERE disputed_at IS NOT NULL;

CREATE FUNCTION food_is_disputed(f_id UUID, f_revision INTEGER) RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
    SELECT count(*) FILTER (WHERE verdict = 'dispute') > 0
       AND count(*) FILTER (WHERE verdict = 'confirm')
        <= count(*) FILTER (WHERE verdict = 'dispute')
    FROM food_verifications
    WHERE food_id = f_id AND revision = f_revision;
$$;

-- Both caches are bookkeeping, not content: they must not appear in a revision
-- snapshot, or every diff would list them and the no-op check would think a
-- settled vote was an edit.
CREATE OR REPLACE FUNCTION food_snapshot(f foods) RETURNS JSONB
LANGUAGE sql IMMUTABLE AS $$
    SELECT to_jsonb(f)
         - 'id' - 'created_at' - 'updated_at' - 'revision'
         - 'verified_at' - 'disputed_at' - 'created_by';
$$;

-- An edit invalidates an objection exactly as it invalidates agreement: both
-- were about the numbers that just changed.
CREATE OR REPLACE FUNCTION foods_bump_revision() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF food_snapshot(NEW) IS DISTINCT FROM food_snapshot(OLD) THEN
        NEW.revision    := OLD.revision + 1;
        NEW.updated_at  := now();
        NEW.verified_at := NULL;
        NEW.disputed_at := NULL;
    ELSE
        NEW.revision := OLD.revision;
    END IF;
    RETURN NEW;
END $$;

UPDATE foods SET disputed_at = now() WHERE food_is_disputed(id, revision);
