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
| **Food database** | Your own custom foods plus anything imported from USDA or Open Food Facts |
| **Barcode lookup** | Type or scan a UPC/EAN and import the product in one click |
| **Targets** | Set daily calorie/protein/carb/fat goals, or let it suggest them from Mifflin-St Jeor |
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

Errors are uniform:

```json
{ "error": "not_found", "message": "food not found" }
```

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
    components/       shared UI, including the three-source food picker
    pages/            one per route
```

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
