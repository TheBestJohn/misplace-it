# misplace-it

Self-hosted nutrition tracking: weight, calories, macros, recipes, and a food
database that looks foods up from government and open data sources — including
by UPC/EAN barcode.

Rust (Axum) API + Postgres + React SPA, all behind one `docker compose up`.

---

## Features

| | |
|---|---|
| **Weight tracking** | One weigh-in per day with optional body-fat %, trend chart, 7-entry moving average, kg/lb toggle, target line |
| **Calorie & macro diary** | Log foods by weight or recipes by serving, grouped into breakfast/lunch/dinner/snack, with progress against your daily targets |
| **Recipes** | Build from any food in your library; totals and per-serving macros are computed for you and recalculate live as you edit |
| **Food database** | Global and shared: custom foods plus anything imported from USDA or Open Food Facts. Only a food's author can edit it |
| **Instant search** | Streams results over SSE as you type, tier by tier, and tolerates typos — "chikn brest" finds chicken breast |
| **Recipe sharing** | Private by default; mark one public and everyone can read and log it, while only you can change it |
| **Barcode lookup** | Type or scan a UPC/EAN and import the product in one click |
| **Goals & budgets** | Per-nutrient daily targets that point in a direction: a **budget** is a ceiling to stay under, a **goal** is a floor to reach. Covers calories, the three macros, fibre, sugar, saturated fat and sodium |
| **Accounts** | Email + password sign-up, Argon2id hashing, closable once your accounts exist |
| **OpenAPI 3.1** | Generated from the handlers, served at `/api/v1/openapi.json` |

### Where the food data comes from

- **[USDA FoodData Central](https://fdc.nal.usda.gov/)** — the US government's
  food composition database (Foundation Foods, SR Legacy, and Branded).
  Needs a [free API key](https://fdc.nal.usda.gov/api-key-signup). Optional:
  without one, USDA search is skipped and everything else still works.
- **[Open Food Facts](https://world.openfoodfacts.org/)** — open, crowd-sourced
  product data, keyed by barcode. No API key. This is the barcode source, since
  USDA carries GTINs but has no lookup-by-barcode endpoint.

Neither provider is required at runtime — if one is down or rate-limited, the
search returns what the other found plus a note saying which was unavailable.

---

## Quick start

```bash
git clone https://github.com/TheBestJohn/misplace-it.git
cd misplace-it

cp .env.example .env
# Required: set POSTGRES_PASSWORD and JWT_SECRET.
#   openssl rand -base64 48   # good source for JWT_SECRET
# Optional: set USDA_API_KEY to enable USDA search.

docker compose up -d --build
```

Open <http://localhost:8088> and create your account.

Once your accounts exist, set `ALLOW_REGISTRATION=false` in `.env` and
`docker compose up -d` again to stop further sign-ups.

### Services

| Service | Image | Purpose |
|---|---|---|
| `db` | `postgres:16-alpine` | Data. Persisted in the `db-data` volume. |
| `api` | built from `./backend` | Rust API. Not published to the host. |
| `web` | built from `./frontend` | nginx serving the SPA and proxying `/api` to `api`. The only published port. |

The API runs its migrations at startup, so there is no separate migration step,
and `db` has a healthcheck that `api` waits on — it never starts against a
Postgres that isn't accepting connections yet.

### Backups

Everything lives in Postgres:

```bash
docker compose exec -T db pg_dump -U misplaceit misplaceit | gzip > backup.sql.gz
gunzip -c backup.sql.gz | docker compose exec -T db psql -U misplaceit misplaceit
```

---

## Configuration

Set in `.env` (see `.env.example`).

| Variable | Default | Notes |
|---|---|---|
| `POSTGRES_PASSWORD` | — | **Required.** |
| `JWT_SECRET` | — | **Required.** Anyone holding this can mint a token for any account. |
| `POSTGRES_USER` / `POSTGRES_DB` | `misplaceit` | |
| `WEB_PORT` | `8088` | Host port for the UI. |
| `JWT_TTL_HOURS` | `168` | Session length. |
| `USDA_API_KEY` | _empty_ | Enables USDA search. |
| `ALLOW_REGISTRATION` | `true` | Set `false` to close sign-ups. |
| `TRGM_WORD_THRESHOLD` | `0.4` | Fuzzy-search strictness, 0–1. Lower matches more typos and more noise. |
| `RUST_LOG` | `misplace_it=info,…` | `tracing-subscriber` filter. |

The API also reads `BIND_ADDR` and `CORS_ORIGINS`; both only matter outside
Docker, where the SPA is served from a different origin than the API.

---

## Design notes

**Nutrients are stored per 100 g.** Both upstream sources publish that basis,
so importing is lossless, and every derived figure — a serving, a recipe row, a
diary entry, a day — is one multiplication by `grams / 100`. Storing per-serving
values instead would mean a conversion on every import and a second one on every
read.

**Diary entries are a strict XOR.** An entry is either *a food, in grams* or *a
recipe, in servings*, enforced by a database `CHECK` as well as by the handler,
so the two quantity columns can never both be set.

**A recipe's macros are never stored.** They are derived from its ingredients on
read, which means correcting a food's nutrition retroactively fixes every recipe
using it, instead of leaving stale copies behind.

**Foods are global; recipes are private by default.** These pull in opposite
directions deliberately. A food is a fact about a product — "oats are 379 kcal
per 100 g" is true for everyone, so making each account re-import the same
barcode is pure duplication. A recipe is authorship: yours until you share it.
Editing follows creation in both cases: anyone can *use* a food, only its author
can change it.

**Search streams instead of ranking once.** Logging a meal is the hottest path,
and a single ranked query is slow twice over — an exact hit waits behind a
trigram scan, and a typo returns nothing. So the search runs as progressively
looser tiers (`exact` → `prefix` → `contains` → `fuzzy` → `fuzzy_words`), each
flushed over Server-Sent Events the moment it returns. The first lands in single
-digit milliseconds, so the list is populated while the fuzzy scan is still
running.

**Fuzzy matching uses word similarity, not whole-string similarity.** "chikn"
against "Chicken breast, raw" scores 0.14 by `similarity()` — diluted by the
length of the whole name — but 0.50 by `word_similarity()`, which compares the
query against the best-matching word. Both use the GIN trigram indexes. Postgres
defaults the threshold to 0.6, tuned for whole documents and too strict for
autocomplete, so it is lowered to 0.4 (see `TRGM_WORD_THRESHOLD`).

**Identical foods are collapsed in search, before the limit.** A global table
accumulates the same product entered by several people. Rows matching on name,
brand and macros are collapsed to the oldest; two foods that merely share a name
but differ nutritionally are different things and both stay. Collapsing after
the limit would let five copies of one food consume the entire result budget.

**Targets are standing settings, never set up daily.** A target belongs to you,
not to a date: set it once and it is evaluated against every day, including past
days and days with nothing logged.

**A target carries a direction, not just a number.** A budget and a goal are
the same arithmetic read in opposite directions: 120% of a calorie budget is a
problem, 120% of a protein goal is a success. Storing the direction is what lets
the server say `over` for one and `met` for the other, so every client agrees
instead of each re-deriving it. Protein and fibre default to goals and the rest
to budgets, and any of them can be flipped — carbs are a budget when cutting and
a goal when bulking.

**Targets live in their own table rather than as columns on `users`.** With a
direction, each nutrient needs an amount and a kind; eight nutrients would mean
sixteen nullable columns, and adding a ninth would mean another `ALTER TABLE`.
One row per target makes "which targets are set" a query, and adding a nutrient
a data concern rather than a schema change.

**Days with nothing logged are excluded from averages.** An unlogged day is
missing data, not a zero-calorie day; averaging it in would drag every average
down and misrepresent the week.

**Imported foods are read-only; your own are editable.** An imported row mirrors
an upstream record, so letting it be edited would silently diverge from the
source it claims to come from. Imported foods are shared across accounts —
reference data is useful to everyone — while your custom foods stay yours.

**Imports are idempotent** on `(source, source_id)`, so scanning the same
barcode twice refreshes the existing food rather than creating a duplicate.

---

## API

Base path `/api/v1`. All endpoints except `/health`, `/auth/register` and
`/auth/login` require `Authorization: Bearer <token>`.

The full spec is generated from the handlers and served at
<http://localhost:8088/api/v1/openapi.json> — load it into Swagger UI, Insomnia,
Bruno or Postman for a browsable reference.

<details>
<summary>Endpoint summary</summary>

```
GET    /health

POST   /auth/register            POST   /auth/login             GET  /auth/me
GET    /profile                  PATCH  /profile
GET    /search/foods                     # SSE: tiered, fuzzy, streams as it finds
GET    /targets                  PUT    /targets          # replaces the whole set
GET    /targets/{nutrient}       DELETE /targets/{nutrient}

GET    /weights                  POST   /weights                GET  /weights/stats
GET    /weights/{id}             PATCH  /weights/{id}           DELETE /weights/{id}

GET    /foods                    POST   /foods
GET    /foods/{id}               PUT    /foods/{id}             DELETE /foods/{id}
GET    /foods/search/external            # USDA + Open Food Facts
GET    /foods/barcode/{upc}              # local hit and/or importable candidate
GET    /foods/external/{source}/{id}     # full upstream record
POST   /foods/import                     # idempotent on (source, source_id)

GET    /recipes                  POST   /recipes
GET    /recipes/{id}             PUT    /recipes/{id}           DELETE /recipes/{id}

GET    /diary                    POST   /diary
GET    /diary/day                        # one day, grouped by meal, vs targets
GET    /diary/summary                    # per-day totals over a range
GET    /diary/{id}               PATCH  /diary/{id}             DELETE /diary/{id}
```

</details>

Errors are uniform — including malformed request bodies, which are routed
through the same error type rather than Axum's plain-text rejection:

```json
{ "error": "not_found", "message": "food not found" }
{ "error": "bad_request", "message": "targets[0].amount must be between 0.1 and 100000" }
```

A day's targets come back already evaluated, so clients render rather than
compute:

```json
{ "nutrient": "protein_g", "label": "Protein", "unit": "g", "kind": "goal",
  "amount": 160, "consumed": 190, "remaining": -30, "percent": 118.75,
  "status": "met" }
```

`remaining` is always `amount - consumed`, signed. `status` is `under`/`over`
for a budget and `short`/`met` for a goal.

---

## Development

Requires Rust (stable), Node 22+, and a Postgres you can point at.

```bash
# database
createdb misplaceit

# API — migrations run on startup
cd backend
cp .env.example .env          # set DATABASE_URL and JWT_SECRET
cargo run

# SPA — proxies /api to localhost:8080, so the browser sees one origin
cd frontend
npm install
npm run dev                   # http://localhost:5173
```

Checks:

```bash
cd backend  && cargo test && cargo clippy --all-targets && cargo fmt --check
cd frontend && npm run build   # tsc -b && vite build
```

### Layout

```
backend/
  migrations/         SQL migrations, embedded into the binary
  src/
    domain/           request/response types and the nutrient arithmetic
    routes/           one module per resource
    services/         USDA and Open Food Facts clients
    auth.rs           password hashing, JWT, the CurrentUser extractor
    error.rs          the one place an error becomes an HTTP response
    openapi.rs        the generated spec
frontend/
  src/
    api/              typed client mirroring the API
    components/ui/    shadcn/ui primitives (Radix + Tailwind), owned in-tree
    components/       app components, including the three-source food picker
    lib/useFoodSearch parses the SSE search stream
    pages/            one per route
    index.css         the Tailwind v4 theme — every colour token lives here
```

The UI is **React 19 + Tailwind v4 + shadcn/ui** on Radix primitives. shadcn
components are copied into the repo rather than installed, so they are ordinary
source files you can edit. Theme tokens live in `src/index.css`; light and dark
are the same variables with different values, so retheming is one file.

`useFoodSearch` reads the SSE stream with `fetch` rather than `EventSource`,
because `EventSource` cannot send an `Authorization` header and the alternative
— putting the token in the query string — writes it into every proxy and access
log on the way.

Queries are runtime-checked rather than `sqlx::query!`-checked, so neither
`cargo build` nor the Docker build needs a live database.

---

## Security

- Passwords are hashed with Argon2id.
- Sign-in returns the same error whether the account is unknown or the password
  is wrong.
- Every user-owned query filters on the authenticated user id; `CurrentUser` is
  an extractor, so a handler that forgets authorization doesn't compile.
- The API is not published to the host by Docker Compose — only nginx is.
- There is no TLS here. Put it behind a reverse proxy (Caddy, Traefik, nginx)
  before exposing it to the internet.
