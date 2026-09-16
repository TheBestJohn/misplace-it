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
expect "set daily targets" \
  "$(curl -fsS -X PATCH "$BASE/profile" -H "$AUTH" -H 'content-type: application/json' \
      -d '{"height_cm":180,"daily_calorie_target":2200,"daily_protein_target_g":160}' | j "['daily_calorie_target']")" \
  "2200.0"

echo "== weights"
curl -fsS -X POST "$BASE/weights" -H "$AUTH" -H 'content-type: application/json' -d '{"recorded_on":"2026-01-01","weight_kg":84.2}' >/dev/null
curl -fsS -X POST "$BASE/weights" -H "$AUTH" -H 'content-type: application/json' -d '{"recorded_on":"2026-01-01","weight_kg":84.0}' >/dev/null
curl -fsS -X POST "$BASE/weights" -H "$AUTH" -H 'content-type: application/json' -d '{"recorded_on":"2026-01-15","weight_kg":82.5,"body_fat_pct":18.4}' >/dev/null
expect "same date upserts, not duplicates" "$(curl -fsS "$BASE/weights" -H "$AUTH" | j " and len(d)")" "2"
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
expect "search by name"      "$(curl -fsS "$BASE/foods?q=oat" -H "$AUTH" | j "[0]['name']")" "Rolled oats"

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
expect "remaining against target"  "$(echo "$DAY" | j "['remaining_kcal']")"          "1761.47"
expect "grouped into four meals"   "$(echo "$DAY" | j " and len(d['meals'])")"        "4"

SUM=$(curl -fsS "$BASE/diary/summary?from=2026-01-01&to=2026-01-31" -H "$AUTH")
expect "summary counts logged days only" "$(echo "$SUM" | j "['logged_day_count']")" "1"
expect "summary day total matches"       "$(echo "$SUM" | j "['days'][0]['total']['calories_kcal']")" "438.53"

DID=$(curl -fsS "$BASE/diary?from=2026-01-15" -H "$AUTH" | j "[0]['id']")
expect "patch recipe servings rescales" \
  "$(curl -fsS -X PATCH "$BASE/diary/$DID" -H "$AUTH" -H 'content-type: application/json' -d '{"recipe_servings":2}' | j "['nutrients']['calories_kcal']")" \
  "667.02"
status "reject both food_id and recipe_id" 400 -X POST "$BASE/diary" -H "$AUTH" -H 'content-type: application/json' -d "{\"food_id\":\"$BAN\",\"recipe_id\":\"$RID\",\"quantity_g\":10}"
status "reject neither food_id nor recipe_id" 400 -X POST "$BASE/diary" -H "$AUTH" -H 'content-type: application/json' -d '{"quantity_g":10}'

echo "== referential integrity"
status "food in use cannot be deleted"   400 -X DELETE "$BASE/foods/$OATS" -H "$AUTH"
status "recipe in use cannot be deleted" 400 -X DELETE "$BASE/recipes/$RID" -H "$AUTH"

echo "== openapi"
PATHS=$(curl -fsS "${BASE%/api/v1}/api/v1/openapi.json" | j " and len(d['paths'])")
if [ "$PATHS" -ge 20 ]; then pass "spec documents $PATHS paths"; else fail "spec only documents $PATHS paths"; fi

echo
if [ "$failures" -eq 0 ]; then
  echo "All checks passed."
else
  echo "$failures check(s) failed."
  exit 1
fi
