#!/usr/bin/env bash
#
# End-to-end exercise of every endpoint against a running API.
#
# Queries are runtime-checked rather than compile-time-checked, so a typo in a
# SQL string only shows up when it executes. This runs each one and asserts the
# arithmetic, which a `cargo build` cannot do.
#
# Usage: scripts/smoke.sh [base-url]        (default http://127.0.0.1:8080)

set -euo pipefail

BASE="${1:-http://127.0.0.1:8080}/api/v1"
EMAIL="smoke-$(date +%s)-$RANDOM@example.test"
PASSWORD="smoke-test-password"
failures=0

# Extract a value from a JSON body on stdin, e.g.  j "['id']"
j() { EXPR="$1" python3 -c 'import sys,json,os;print(eval("d"+os.environ["EXPR"],{"d":json.load(sys.stdin)}))'; }

pass() { printf '  \033[32m✓\033[0m %s\n' "$1"; }
fail() { printf '  \033[31m✗\033[0m %s\n' "$1"; failures=$((failures + 1)); }

expect() { # expect <label> <actual> <wanted>
  if [ "$2" = "$3" ]; then pass "$1 ($3)"; else fail "$1: got '$2', wanted '$3'"; fi
}

status() { # status <label> <wanted-code> <curl args...>
  local label="$1" want="$2"; shift 2
  local got; got=$(curl -s -o /dev/null -w '%{http_code}' "$@")
  expect "$label" "$got" "$want"
}

echo "== health"
expect "database reachable" "$(curl -fsS "$BASE/health" | j "['database']")" "ok"

echo "== auth"
TOKEN=$(curl -fsS -X POST "$BASE/auth/register" -H 'content-type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\",\"display_name\":\"Smoke\"}" | j "['access_token']")
AUTH="Authorization: Bearer $TOKEN"
expect "registered and signed in" "$(curl -fsS "$BASE/auth/me" -H "$AUTH" | j "['email']")" "$EMAIL"

status "reject duplicate email"  409 -X POST "$BASE/auth/register" -H 'content-type: application/json' -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\",\"display_name\":\"Dup\"}"
status "reject short password"   400 -X POST "$BASE/auth/register" -H 'content-type: application/json' -d '{"email":"short@example.test","password":"short","display_name":"S"}'
status "reject wrong password"   401 -X POST "$BASE/auth/login"    -H 'content-type: application/json' -d "{\"email\":\"$EMAIL\",\"password\":\"definitely-wrong\"}"
status "reject missing token"    401 "$BASE/weights"

echo "== profile"
expect "update profile" \
  "$(curl -fsS -X PATCH "$BASE/profile" -H "$AUTH" -H 'content-type: application/json' \
      -d '{"height_cm":180,"target_weight_kg":78}' | j "['height_cm']")" \
  "180.0"

echo "== goals and budgets"
# A budget is a ceiling, a goal is a floor. The same arithmetic, read in
# opposite directions -- which is the whole point of storing the direction.
curl -fsS -X PUT "$BASE/targets" -H "$AUTH" -H 'content-type: application/json' -d '{"targets":[
  {"nutrient":"calories_kcal","amount":2200,"kind":"budget"},
  {"nutrient":"protein_g","amount":160,"kind":"goal"},
  {"nutrient":"fiber_g","amount":30}]}' >/dev/null
expect "targets stored"              "$(curl -fsS "$BASE/targets" -H "$AUTH" | j ".__len__()")" "3"
expect "kind defaults per nutrient"  "$(curl -fsS "$BASE/targets/fiber_g" -H "$AUTH" | j "['kind']")" "goal"
expect "calories default to budget"  "$(curl -fsS "$BASE/targets/calories_kcal" -H "$AUTH" | j "['kind']")" "budget"

status "reject a duplicate nutrient" 400 -X PUT "$BASE/targets" -H "$AUTH" -H 'content-type: application/json' -d '{"targets":[{"nutrient":"protein_g","amount":1},{"nutrient":"protein_g","amount":2}]}'
status "reject a negative amount"    400 -X PUT "$BASE/targets" -H "$AUTH" -H 'content-type: application/json' -d '{"targets":[{"nutrient":"protein_g","amount":-5}]}'
status "reject an unknown nutrient"  400 -X PUT "$BASE/targets" -H "$AUTH" -H 'content-type: application/json' -d '{"targets":[{"nutrient":"vitamin_q","amount":5}]}'
status "reject an unknown kind"      400 -X PUT "$BASE/targets" -H "$AUTH" -H 'content-type: application/json' -d '{"targets":[{"nutrient":"protein_g","amount":5,"kind":"wish"}]}'

# Every error, including a body the server could not deserialize, uses the
# same JSON shape. Axum's own rejection would be plain text with a 422.
expect "malformed bodies use the standard error shape" \
  "$(curl -s -X POST "$BASE/weights" -H "$AUTH" -H 'content-type: application/json' -d '{"weight_kg":' | j "['error']")" \
  "bad_request"

echo "== weights"
curl -fsS -X POST "$BASE/weights" -H "$AUTH" -H 'content-type: application/json' -d '{"recorded_on":"2026-01-01","weight_kg":84.2}' >/dev/null
curl -fsS -X POST "$BASE/weights" -H "$AUTH" -H 'content-type: application/json' -d '{"recorded_on":"2026-01-01","weight_kg":84.0}' >/dev/null
curl -fsS -X POST "$BASE/weights" -H "$AUTH" -H 'content-type: application/json' -d '{"recorded_on":"2026-01-15","weight_kg":82.5,"body_fat_pct":18.4}' >/dev/null
expect "same date upserts, not duplicates" "$(curl -fsS "$BASE/weights" -H "$AUTH" | j ".__len__()")" "2"
expect "change over the window"            "$(curl -fsS "$BASE/weights/stats" -H "$AUTH" | j "['change_kg']")" "-1.5"
WID=$(curl -fsS "$BASE/weights" -H "$AUTH" | j "[0]['id']")
expect "patch an entry" "$(curl -fsS -X PATCH "$BASE/weights/$WID" -H "$AUTH" -H 'content-type: application/json' -d '{"weight_kg":82.7}' | j "['weight_kg']")" "82.7"
status "delete an entry" 204 -X DELETE "$BASE/weights/$WID" -H "$AUTH"
status "deleted entry is gone" 404 "$BASE/weights/$WID" -H "$AUTH"

echo "== foods"
OATS=$(curl -fsS -X POST "$BASE/foods" -H "$AUTH" -H 'content-type: application/json' \
  -d '{"name":"Rolled oats","calories_kcal":379,"protein_g":13.2,"carbs_g":67.7,"fat_g":6.5,"fiber_g":10.1,"serving_size_g":40}' | j "['id']")
MILK=$(curl -fsS -X POST "$BASE/foods" -H "$AUTH" -H 'content-type: application/json' \
  -d '{"name":"Whole milk","calories_kcal":61,"protein_g":3.2,"carbs_g":4.8,"fat_g":3.3,"serving_size_g":244}' | j "['id']")
# 379 kcal/100g x 40 g = 151.6
expect "per-serving scaling" "$(curl -fsS "$BASE/foods/$OATS" -H "$AUTH" | j "['per_serving']['calories_kcal']")" "151.6"
expect "search by name"      "$(curl -fsS "$BASE/foods?q=oat" -H "$AUTH" | j " and ('Rolled oats' in [f['name'] for f in d])")" "True"

BAN=$(curl -fsS -X POST "$BASE/foods/import" -H "$AUTH" -H 'content-type: application/json' \
  -d '{"source":"usda","source_id":"173944","name":"Bananas, raw","calories_kcal":89,"protein_g":1.09,"carbs_g":22.84,"fat_g":0.33,"serving_size_g":118}' | j "['id']")
BAN2=$(curl -fsS -X POST "$BASE/foods/import" -H "$AUTH" -H 'content-type: application/json' \
  -d '{"source":"usda","source_id":"173944","name":"Bananas, raw","calories_kcal":89,"protein_g":1.09,"carbs_g":22.84,"fat_g":0.33,"serving_size_g":118}' | j "['id']")
expect "re-import is idempotent" "$BAN2" "$BAN"
status "reject unknown import source" 400 -X POST "$BASE/foods/import" -H "$AUTH" -H 'content-type: application/json' -d '{"source":"nope","source_id":"1","name":"x","calories_kcal":0,"protein_g":0,"carbs_g":0,"fat_g":0,"serving_size_g":100}'
status "imported foods are read-only"  403 -X PUT "$BASE/foods/$BAN" -H "$AUTH" -H 'content-type: application/json' -d '{"name":"Tampered","calories_kcal":1,"protein_g":0,"carbs_g":0,"fat_g":0,"serving_size_g":100}'

echo "== recipes"
# 100g oats (379) + 300g milk (183) + 118g banana (105.02) = 667.02 over 2 servings
REC=$(curl -fsS -X POST "$BASE/recipes" -H "$AUTH" -H 'content-type: application/json' -d "{
  \"name\":\"Oatmeal bowl\",\"servings\":2,
  \"items\":[{\"food_id\":\"$OATS\",\"quantity_g\":100},{\"food_id\":\"$MILK\",\"quantity_g\":300},{\"food_id\":\"$BAN\",\"quantity_g\":118}]}")
RID=$(echo "$REC" | j "['id']")
expect "recipe total"       "$(echo "$REC" | j "['total']['calories_kcal']")"       "667.02"
expect "recipe per serving" "$(echo "$REC" | j "['per_serving']['calories_kcal']")" "333.51"
expect "list view agrees"   "$(curl -fsS "$BASE/recipes" -H "$AUTH" | j "[0]['per_serving']['calories_kcal']")" "333.51"
status "reject unknown ingredient" 400 -X POST "$BASE/recipes" -H "$AUTH" -H 'content-type: application/json' \
  -d '{"name":"x","servings":1,"items":[{"food_id":"00000000-0000-0000-0000-000000000000","quantity_g":10}]}'
status "reject empty ingredient list" 400 -X POST "$BASE/recipes" -H "$AUTH" -H 'content-type: application/json' -d '{"name":"x","servings":1,"items":[]}'

echo "== diary"
curl -fsS -X POST "$BASE/diary" -H "$AUTH" -H 'content-type: application/json' \
  -d "{\"logged_on\":\"2026-01-15\",\"meal\":\"breakfast\",\"recipe_id\":\"$RID\",\"recipe_servings\":1}" >/dev/null
curl -fsS -X POST "$BASE/diary" -H "$AUTH" -H 'content-type: application/json' \
  -d "{\"logged_on\":\"2026-01-15\",\"meal\":\"lunch\",\"food_id\":\"$BAN\",\"quantity_g\":118}" >/dev/null

DAY=$(curl -fsS "$BASE/diary/day?date=2026-01-15" -H "$AUTH")
expect "day total (recipe + food)" "$(echo "$DAY" | j "['total']['calories_kcal']")" "438.53"
expect "grouped into four meals"   "$(echo "$DAY" | j " and len(d['meals'])")"        "4"

# 438.53 kcal against a 2200 budget: under, with 1761.47 left.
expect "calorie budget reports what is left" \
  "$(echo "$DAY" | j " and [t for t in d['targets'] if t['nutrient']=='calories_kcal'][0]['remaining']")" "1761.47"
expect "calorie budget is under"   "$(echo "$DAY" | j " and [t for t in d['targets'] if t['nutrient']=='calories_kcal'][0]['status']")" "under"
# 13.33 g protein (12.04 from the recipe serving + 1.29 from the banana)
# against a 160 g goal: short, 146.67 g still needed.
expect "protein goal reports what is still needed" \
  "$(echo "$DAY" | j " and [t for t in d['targets'] if t['nutrient']=='protein_g'][0]['remaining']")" "146.67"
expect "protein goal is short"     "$(echo "$DAY" | j " and [t for t in d['targets'] if t['nutrient']=='protein_g'][0]['status']")" "short"

# The distinction that matters: blow a budget and it is over; pass a goal and
# it is met, not flagged.
curl -fsS -X PUT "$BASE/targets" -H "$AUTH" -H 'content-type: application/json' \
  -d '{"targets":[{"nutrient":"calories_kcal","amount":300,"kind":"budget"},{"nutrient":"protein_g","amount":5,"kind":"goal"}]}' >/dev/null
DAY=$(curl -fsS "$BASE/diary/day?date=2026-01-15" -H "$AUTH")
expect "an exceeded budget is over" "$(echo "$DAY" | j " and [t for t in d['targets'] if t['nutrient']=='calories_kcal'][0]['status']")" "over"
expect "an exceeded goal is met"    "$(echo "$DAY" | j " and [t for t in d['targets'] if t['nutrient']=='protein_g'][0]['status']")"     "met"

# Targets are standing settings: set once, they apply to every day, including
# days in the past and days with nothing logged. Nothing is ever set up daily.
expect "targets apply to an untouched past day" \
  "$(curl -fsS "$BASE/diary/day?date=2025-06-30" -H "$AUTH" | j " and [t['nutrient'] for t in d['targets']]")" \
  "['calories_kcal', 'protein_g']"
expect "and to a day with no entries at all" \
  "$(curl -fsS "$BASE/diary/day?date=2025-06-30" -H "$AUTH" | j " and [t['status'] for t in d['targets']]")" \
  "['under', 'short']"

status "clear one target"        204 -X DELETE "$BASE/targets/protein_g" -H "$AUTH"
status "clearing it twice 404s"  404 -X DELETE "$BASE/targets/protein_g" -H "$AUTH"

SUM=$(curl -fsS "$BASE/diary/summary?from=2026-01-01&to=2026-01-31" -H "$AUTH")
expect "summary counts logged days only" "$(echo "$SUM" | j "['logged_day_count']")" "1"
expect "summary day total matches"       "$(echo "$SUM" | j "['days'][0]['total']['calories_kcal']")" "438.53"

DID=$(curl -fsS "$BASE/diary?from=2026-01-15" -H "$AUTH" | j "[0]['id']")
expect "patch recipe servings rescales" \
  "$(curl -fsS -X PATCH "$BASE/diary/$DID" -H "$AUTH" -H 'content-type: application/json' -d '{"recipe_servings":2}' | j "['nutrients']['calories_kcal']")" \
  "667.02"
status "reject both food_id and recipe_id" 400 -X POST "$BASE/diary" -H "$AUTH" -H 'content-type: application/json' -d "{\"food_id\":\"$BAN\",\"recipe_id\":\"$RID\",\"quantity_g\":10}"
status "reject neither food_id nor recipe_id" 400 -X POST "$BASE/diary" -H "$AUTH" -H 'content-type: application/json' -d '{"quantity_g":10}'

echo "== global foods and recipe visibility"
# A second account, to check what crosses the boundary between users.
OTHER_EMAIL="smoke-other-$(date +%s)-$RANDOM@example.test"
OTHER=$(curl -fsS -X POST "$BASE/auth/register" -H 'content-type: application/json' \
  -d "{\"email\":\"$OTHER_EMAIL\",\"password\":\"$PASSWORD\",\"display_name\":\"Other\"}" | j "['access_token']")
OAUTH="Authorization: Bearer $OTHER"

# Foods are global: a food is a fact about a product, so everyone sees it...
expect "another account sees your custom food" \
  "$(curl -fsS "$BASE/foods?q=Rolled%20oats" -H "$OAUTH" | j "[0]['name']")" "Rolled oats"
# ...but only its author may change it.
status "another account cannot edit your food" 403 -X PUT "$BASE/foods/$OATS" -H "$OAUTH" \
  -H 'content-type: application/json' -d '{"name":"Hijacked","calories_kcal":1,"protein_g":0,"carbs_g":0,"fat_g":0,"serving_size_g":100}'

# Recipes are the opposite: private until shared.
PUB=$(curl -fsS -X POST "$BASE/recipes" -H "$AUTH" -H 'content-type: application/json' \
  -d "{\"name\":\"Shared bowl\",\"servings\":1,\"is_public\":true,\"items\":[{\"food_id\":\"$OATS\",\"quantity_g\":50}]}" | j "['id']")

status "a private recipe is invisible to others"  404 "$BASE/recipes/$RID" -H "$OAUTH"
status "a public recipe is visible to others"     200 "$BASE/recipes/$PUB" -H "$OAUTH"
expect "a public recipe names its author"         "$(curl -fsS "$BASE/recipes/$PUB" -H "$OAUTH" | j "['author']")" "Smoke"
expect "and is not owned by the reader"           "$(curl -fsS "$BASE/recipes/$PUB" -H "$OAUTH" | j "['is_owner']")" "False"
status "others cannot edit a public recipe"       404 -X PUT "$BASE/recipes/$PUB" -H "$OAUTH" \
  -H 'content-type: application/json' -d "{\"name\":\"Hijacked\",\"servings\":1,\"items\":[{\"food_id\":\"$OATS\",\"quantity_g\":1}]}"
status "others cannot delete a public recipe"     404 -X DELETE "$BASE/recipes/$PUB" -H "$OAUTH"
expect "scope=mine excludes others' recipes"      "$(curl -fsS "$BASE/recipes?scope=mine" -H "$OAUTH" | j ".__len__()")" "0"
expect "scope=public includes them"               "$(curl -fsS "$BASE/recipes?scope=public" -H "$OAUTH" | j " and ('Shared bowl' in [r['name'] for r in d])")" "True"

echo "== streaming fuzzy search"
# Each tier is flushed as it completes, so the response is a sequence of SSE
# events rather than one JSON body.
sse() { curl -fsSN "$BASE/search/foods?q=$1&limit=5" -H "$AUTH"; }
expect "responds as an event stream" \
  "$(curl -fsSI -o /dev/null -w '%{content_type}' "$BASE/search/foods?q=oats" -H "$AUTH" 2>/dev/null | cut -d';' -f1)" \
  "text/event-stream"
expect "an exact name hits the exact tier"    "$(sse 'Rolled%20oats' | grep -c 'tier":"exact"')"    "1"
expect "a prefix hits the prefix tier"        "$(sse 'Rolled' | grep -c 'tier":"prefix"')"          "1"
# Whole-string similarity scores this pair at 0.14 and would miss it; word
# similarity scores the best-matching word and finds it.
expect "a typo still finds the food"          "$(sse 'Rolld%20oatz' | grep -c '"tier"')"            "1"
# A multi-word typo must still resolve. Which tier catches it is an
# implementation detail — the indexed one often does — so assert that it is
# found, and separately that the scanning per-word tier is never run for a
# single-word query, where the index alone is enough.
expect "a multi-word typo finds it too"       "$(sse 'rolld%20oatts' | grep -c '\"tier\"')"        "1"
expect "per-word tier is skipped when unneeded" "$(sse 'oatz' | grep -c 'fuzzy_words')"             "0"

# A global food table accumulates the same product added by different people.
# The probe name is scoped to this run: the table is global AND persistent, so
# a previous run's rows are legitimately still there and would be counted.
PROBE="Smoke dupe probe $(date +%s)-$RANDOM"
DUPE="{\"name\":\"$PROBE\",\"calories_kcal\":100,\"protein_g\":5,\"carbs_g\":10,\"fat_g\":2,\"serving_size_g\":100}"
PROBE_Q=$(python3 -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.argv[1]))' "$PROBE")
curl -fsS -X POST "$BASE/foods" -H "$AUTH" -H 'content-type: application/json' -d "$DUPE" >/dev/null
curl -fsS -X POST "$BASE/foods" -H "$OAUTH" -H 'content-type: application/json' -d "$DUPE" >/dev/null
expect "identical foods collapse to one result" \
  "$(sse "$PROBE_Q" | grep -o "\"name\":\"$PROBE\"" | wc -l | tr -d ' ')" "1"

# ...but two foods that merely share a name are different things, and both stay.
curl -fsS -X POST "$BASE/foods" -H "$OAUTH" -H 'content-type: application/json' \
  -d "{\"name\":\"$PROBE\",\"calories_kcal\":250,\"protein_g\":9,\"carbs_g\":30,\"fat_g\":8,\"serving_size_g\":100}" >/dev/null
expect "a nutritionally different namesake is kept" \
  "$(sse "$PROBE_Q" | grep -o "\"name\":\"$PROBE\"" | wc -l | tr -d ' ')" "2"
expect "the stream always ends with done"     "$(sse 'oats' | grep -c 'event: done')"               "1"
expect "an empty query ends cleanly"          "$(sse '' | grep -c 'event: done')"                   "1"
expect "a miss returns no tiers"              "$(sse 'zzzzznotafood' | grep -c '"tier"')"           "0"

echo "== progress photos"
# A real PNG, built without third-party libraries so this script keeps its
# only dependency on python3 itself.
PHOTO=$(mktemp /tmp/smoke-photo-XXXXXX.png)
python3 - "$PHOTO" <<'PYEOF'
import struct, sys, zlib
W = H = 600
raw = b"".join(b"\x00" + bytes([(x * 7) % 256, (y * 5) % 256, 128][c % 3] for x in range(W) for c in range(3)) for y in range(H))
def chunk(tag, data):
    body = tag + data
    return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)
png = (b"\x89PNG\r\n\x1a\n"
       + chunk(b"IHDR", struct.pack(">IIBBBBB", W, H, 8, 2, 0, 0, 0))
       + chunk(b"IDAT", zlib.compress(raw, 6))
       + chunk(b"IEND", b""))
open(sys.argv[1], "wb").write(png)
PYEOF

PHOTO_ENTRY=$(curl -fsS -X POST "$BASE/weights" -H "$AUTH" -H 'content-type: application/json' \
  -d '{"recorded_on":"2026-05-05","weight_kg":81.1}' | j "['id']")
UPLOADED=$(curl -fsS -X POST "$BASE/weights/$PHOTO_ENTRY/photos" -H "$AUTH" \
  -F "file=@$PHOTO" -F "caption=Week one")

expect "photo attaches to the weigh-in" "$(echo "$UPLOADED" | j "['weight_entry_id']")" "$PHOTO_ENTRY"
expect "caption is kept"                "$(echo "$UPLOADED" | j "['caption']")"          "Week one"
# Uploads are re-encoded, which is what bounds their size and drops EXIF.
expect "re-encoded as jpeg"             "$(echo "$UPLOADED" | j "['content_type']")"     "image/jpeg"
PHOTO_ID=$(echo "$UPLOADED" | j "['id']")

SERVED=$(mktemp /tmp/smoke-served-XXXXXX.jpg)
curl -fsS "$BASE/photos/$PHOTO_ID" -H "$AUTH" -o "$SERVED"
expect "served bytes are a jpeg" "$(od -An -tx1 -N2 "$SERVED" | tr -d ' \n')" "ffd8"
expect "and carry no EXIF segment" "$(grep -c Exif "$SERVED" || true)" "0"
rm -f "$SERVED"

status "another account cannot read the photo" 404 "$BASE/photos/$PHOTO_ID" -H "$OAUTH"
status "an unauthenticated request cannot"     401 "$BASE/photos/$PHOTO_ID"
status "another account cannot attach one"     404 -X POST "$BASE/weights/$PHOTO_ENTRY/photos" -H "$OAUTH" -F "file=@$PHOTO"

# Anything that does not decode is rejected rather than stored and served back.
NOTAPHOTO=$(mktemp /tmp/smoke-notaphoto-XXXXXX.jpg)
printf '#!/bin/sh\necho not a photo\n' > "$NOTAPHOTO"
status "a non-image is rejected" 400 -X POST "$BASE/weights/$PHOTO_ENTRY/photos" -H "$AUTH" -F "file=@$NOTAPHOTO"

status "deleting the weigh-in succeeds"   204 -X DELETE "$BASE/weights/$PHOTO_ENTRY" -H "$AUTH"
status "and takes its photos with it"     404 "$BASE/photos/$PHOTO_ID" -H "$AUTH"
rm -f "$PHOTO" "$NOTAPHOTO"

echo "== reminders"
# Reminders store a cadence; being overdue is derived from your own records,
# so there is no scheduler and nothing to catch up.
expect "every kind is offered"     "$(curl -fsS "$BASE/reminders" -H "$AUTH" | j ".__len__()")" "3"
expect "and each is off until set" "$(curl -fsS "$BASE/reminders" -H "$AUTH" | j " and [r['enabled'] for r in d]")" "[False, False, False]"

curl -fsS -X PUT "$BASE/reminders" -H "$AUTH" -H 'content-type: application/json' \
  -d '{"reminders":[{"kind":"weigh_in","every_days":7,"enabled":true}]}' >/dev/null
expect "a disabled kind is absent from status" "$(curl -fsS "$BASE/reminders/status" -H "$AUTH" | j ".__len__()")" "1"

# The account has weigh-ins from earlier in this run, all far in the past.
expect "an old weigh-in reads as due" \
  "$(curl -fsS "$BASE/reminders/status" -H "$AUTH" | j "[0]['due']")" "True"

# Weighing in today clears it, with no separate state to update.
curl -fsS -X POST "$BASE/weights" -H "$AUTH" -H 'content-type: application/json' -d '{"weight_kg":80.0}' >/dev/null
expect "weighing in today clears it"  "$(curl -fsS "$BASE/reminders/status" -H "$AUTH" | j "[0]['due']")"     "False"
expect "and says so"                  "$(curl -fsS "$BASE/reminders/status" -H "$AUTH" | j "[0]['message']")" "Weigh in — done today."

status "reject a zero cadence"     400 -X PUT "$BASE/reminders" -H "$AUTH" -H 'content-type: application/json' -d '{"reminders":[{"kind":"weigh_in","every_days":0}]}'
status "reject an unknown kind"    400 -X PUT "$BASE/reminders" -H "$AUTH" -H 'content-type: application/json' -d '{"reminders":[{"kind":"floss","every_days":1}]}'
status "reject a duplicate kind"   400 -X PUT "$BASE/reminders" -H "$AUTH" -H 'content-type: application/json' -d '{"reminders":[{"kind":"weigh_in","every_days":7},{"kind":"weigh_in","every_days":3}]}'

echo "== referential integrity"
status "food in use cannot be deleted"   400 -X DELETE "$BASE/foods/$OATS" -H "$AUTH"
status "recipe in use cannot be deleted" 400 -X DELETE "$BASE/recipes/$RID" -H "$AUTH"

echo "== openapi"
PATHS=$(curl -fsS "${BASE%/api/v1}/api/v1/openapi.json" | j " and len(d['paths'])")
if [ "$PATHS" -ge 28 ]; then pass "spec documents $PATHS paths"; else fail "spec only documents $PATHS paths"; fi

echo
if [ "$failures" -eq 0 ]; then
  echo "All checks passed."
else
  echo "$failures check(s) failed."
  exit 1
fi
