-- Progress photos on weigh-ins, and cadence reminders.

-- Photo bytes live on disk, not in this table. A few hundred kilobytes per
-- row would work, but it would make pg_dump carry every photo and every
-- restore rewrite them. The row is the metadata and the pointer; the file
-- lives under PHOTO_DIR, which is a mounted volume in Docker.
CREATE TABLE weigh_in_photos (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    weight_entry_id UUID NOT NULL REFERENCES weight_entries(id) ON DELETE CASCADE,

    -- Path relative to PHOTO_DIR, so the storage root can move without a
    -- rewrite of every row.
    relative_path   TEXT NOT NULL,
    content_type    TEXT NOT NULL,
    byte_size       BIGINT NOT NULL CHECK (byte_size > 0),
    width           INTEGER NOT NULL CHECK (width > 0),
    height          INTEGER NOT NULL CHECK (height > 0),
    caption         TEXT,

    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX weigh_in_photos_entry_idx ON weigh_in_photos (weight_entry_id, created_at);
CREATE INDEX weigh_in_photos_user_idx  ON weigh_in_photos (user_id, created_at DESC);

-- A reminder is a cadence, not a queue of scheduled jobs. Storing "how often"
-- and deriving "are you overdue" from the data you already have means there is
-- no scheduler to run, nothing to catch up after downtime, and no way for the
-- reminder to disagree with reality.
CREATE TABLE reminders (
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind        TEXT NOT NULL,
    every_days  INTEGER NOT NULL CHECK (every_days BETWEEN 1 AND 365),
    enabled     BOOLEAN NOT NULL DEFAULT TRUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

    PRIMARY KEY (user_id, kind),
    CONSTRAINT reminders_kind_known CHECK (kind IN ('weigh_in', 'food_log', 'progress_photo'))
);
