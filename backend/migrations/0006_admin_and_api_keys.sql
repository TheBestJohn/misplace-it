-- Administration and machine access.
--
-- Two related gaps: nobody could act on behalf of the instance (approve, clean
-- up, look at the whole picture), and nothing but a browser could talk to the
-- API, because the only credential was a short-lived JWT obtained by typing a
-- password. This adds an administrator flag and per-user API keys.

-- ---------------------------------------------------------------------------
-- Administrators
-- ---------------------------------------------------------------------------

ALTER TABLE users
    ADD COLUMN is_admin    BOOLEAN NOT NULL DEFAULT FALSE,
    -- A disabled account keeps all its data and simply cannot sign in. Deleting
    -- a user would cascade away their diary, weights and photos, which is not
    -- what "suspend this account" should mean.
    ADD COLUMN disabled_at TIMESTAMPTZ;

CREATE INDEX users_admin_idx ON users (id) WHERE is_admin;

-- Bootstrap: the account that already exists, or the first one created, owns
-- the instance. A self-hosted deployment has no external authority to hand out
-- the first administrator, so the act of installing it is the authority.
UPDATE users SET is_admin = TRUE
 WHERE id = (SELECT id FROM users ORDER BY created_at, id LIMIT 1);

-- ---------------------------------------------------------------------------
-- API keys
-- ---------------------------------------------------------------------------

CREATE TABLE api_keys (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name         TEXT NOT NULL,

    -- The leading, non-secret part of the token, kept so the UI can say which
    -- key is which. Without it a revoke screen is a list of indistinguishable
    -- rows and people revoke the wrong one.
    prefix       TEXT NOT NULL,

    -- SHA-256 of the whole token, hex.
    --
    -- Deliberately not Argon2, which is what passwords in this schema use. A
    -- slow hash exists to make guessing a low-entropy human-chosen secret
    -- expensive. These tokens are 256 bits from the OS random source, so there
    -- is nothing to guess, and a slow hash would instead add its cost to every
    -- single authenticated request. A fast digest also lets the lookup be an
    -- indexed equality check, where Argon2 would force a scan of every key row
    -- to find which one a token belongs to.
    token_hash   TEXT NOT NULL UNIQUE,

    -- 'read' | 'write'. A read-only key is the one you paste into a dashboard.
    scopes       TEXT[] NOT NULL DEFAULT ARRAY['read']::TEXT[],

    last_used_at TIMESTAMPTZ,
    expires_at   TIMESTAMPTZ,
    revoked_at   TIMESTAMPTZ,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT api_keys_scopes_known CHECK (scopes <@ ARRAY['read', 'write']::TEXT[]),
    CONSTRAINT api_keys_scopes_present CHECK (cardinality(scopes) > 0)
);

CREATE INDEX api_keys_user_idx ON api_keys (user_id, created_at DESC);

-- Names only have to be unique per user, and only among keys still in use:
-- reusing the name of a key you revoked last year is reasonable.
CREATE UNIQUE INDEX api_keys_user_name_idx
    ON api_keys (user_id, lower(btrim(name)))
    WHERE revoked_at IS NULL;
