//! Eager, tiered food search over Server-Sent Events.
//!
//! Logging a meal is the app's hottest path, and a single ranked query makes it
//! feel slow twice over: an exact hit waits behind a trigram scan of the whole
//! table, and a typo returns nothing at all.
//!
//! So the search runs as a sequence of progressively looser tiers, each flushed
//! to the client the moment it returns:
//!
//!   1. `exact`    — the name is the query
//!   2. `prefix`   — the name starts with the query
//!   3. `contains` — the name or brand contains the query
//!   4. `fuzzy`    — trigram similarity, which survives typos ("chikn")
//!
//! The first tier typically lands in single-digit milliseconds, so the list is
//! populated before the fuzzy scan has finished. SSE is what makes that
//! visible: with one JSON response the client waits for the slowest tier.
//!
//! Tiers are deduplicated as they go, so a food already sent is never repeated
//! in a looser tier.

use std::collections::HashSet;
use std::time::Instant;

use async_stream::stream;
use axum::extract::{Query, State};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::routing::get;
use axum::Router;
use futures::stream::Stream;
use serde::{Deserialize, Serialize};
use utoipa::IntoParams;
use uuid::Uuid;

use crate::auth::CurrentUser;
use crate::domain::food::Food;
use crate::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new().route("/foods", get(stream_foods))
}

const COLUMNS: &str = r#"
    id, source, source_id, name, brand, upc, calories_kcal, protein_g, carbs_g, fat_g,
    fiber_g, sugar_g, saturated_fat_g, sodium_mg, serving_size_g, serving_label,
    created_by, created_at, updated_at
"#;

#[derive(Debug, Deserialize, IntoParams)]
pub struct StreamQuery {
    /// Search terms.
    pub q: String,
    /// Maximum foods per tier (1–50, default 10).
    pub limit: Option<i64>,
}

/// One flush of results. `tier` says how the match was found, so the client can
/// label or group them ("exact" hits above "did you mean" hits).
#[derive(Debug, Serialize)]
struct TierPayload {
    tier: &'static str,
    results: Vec<Food>,
}

#[derive(Debug, Serialize)]
struct DonePayload {
    total: usize,
    elapsed_ms: u128,
}

#[derive(Debug, Serialize)]
struct ErrorPayload {
    message: String,
}

#[utoipa::path(
    get, path = "/api/v1/search/foods", tag = "search",
    security(("bearer" = [])),
    params(StreamQuery),
    responses((status = 200, description = "text/event-stream of `tier`, `done` and `error` events", content_type = "text/event-stream"))
)]
pub async fn stream_foods(
    State(state): State<AppState>,
    _user: CurrentUser,
    Query(query): Query<StreamQuery>,
) -> Sse<impl Stream<Item = Result<Event, std::convert::Infallible>>> {
    let term = query.q.trim().to_string();
    let limit = query.limit.unwrap_or(10).clamp(1, 50);

    let stream = stream! {
        let started = Instant::now();

        if term.is_empty() {
            yield Ok(done_event(0, started));
            return;
        }

        // Ids already sent, so each tier only adds what the tighter ones missed.
        let mut seen: HashSet<Uuid> = HashSet::new();
        let mut total = 0usize;

        for (tier, sql) in tiers() {
            let rows: Result<Vec<Food>, _> = sqlx::query_as(sql)
                .bind(&term)
                .bind(limit)
                .fetch_all(&state.db)
                .await;

            match rows {
                Ok(rows) => {
                    let fresh: Vec<Food> =
                        rows.into_iter().filter(|f| seen.insert(f.id)).collect();

                    if fresh.is_empty() {
                        continue;
                    }
                    total += fresh.len();

                    // Flush this tier before running the next one — that is the
                    // whole point of streaming rather than collecting.
                    match Event::default().event("tier").json_data(TierPayload { tier, results: fresh }) {
                        Ok(event) => yield Ok(event),
                        Err(e) => {
                            tracing::error!(error = %e, "failed to encode search tier");
                        }
                    }
                }
                Err(e) => {
                    // A failed tier is reported and the rest still run: partial
                    // results beat an empty list.
                    tracing::error!(error = %e, tier, "search tier failed");
                    if let Ok(event) = Event::default()
                        .event("error")
                        .json_data(ErrorPayload { message: format!("{tier} search failed") })
                    {
                        yield Ok(event);
                    }
                }
            }
        }

        yield Ok(done_event(total, started));
    };

    // A comment every 15s keeps proxies and load balancers from culling an
    // idle connection mid-search.
    Sse::new(stream).keep_alive(KeepAlive::default())
}

fn done_event(total: usize, started: Instant) -> Event {
    Event::default()
        .event("done")
        .json_data(DonePayload {
            total,
            elapsed_ms: started.elapsed().as_millis(),
        })
        .unwrap_or_else(|_| Event::default().event("done").data("{}"))
}

/// The tiers, tightest first. Each takes the search term as `$1` and a row
/// limit as `$2`.
fn tiers() -> [(&'static str, &'static str); 4] {
    [
        ("exact", const_format::exact()),
        ("prefix", const_format::prefix()),
        ("contains", const_format::contains()),
        ("fuzzy", const_format::fuzzy()),
    ]
}

/// The SQL lives here rather than inline so each tier reads as one idea.
mod const_format {
    use super::COLUMNS;
    use std::sync::OnceLock;

    macro_rules! cached {
        ($name:ident, $body:expr) => {
            pub fn $name() -> &'static str {
                static SQL: OnceLock<String> = OnceLock::new();
                SQL.get_or_init(|| format!($body, cols = COLUMNS))
            }
        };
    }

    cached!(
        exact,
        "SELECT {cols} FROM foods WHERE lower(name) = lower($1) ORDER BY name LIMIT $2"
    );

    cached!(
        prefix,
        "SELECT {cols} FROM foods WHERE name ILIKE $1 || '%' ORDER BY length(name), name LIMIT $2"
    );

    cached!(
        contains,
        "SELECT {cols} FROM foods
         WHERE name ILIKE '%' || $1 || '%' OR brand ILIKE '%' || $1 || '%'
         ORDER BY length(name), name LIMIT $2"
    );

    // `<%` is pg_trgm's WORD similarity operator, and the choice matters.
    // Whole-string `similarity()` divides by the length of the whole name, so
    // "chikn" against "Chicken breast, raw" scores 0.14 and is missed, while
    // word similarity compares the query against the best-matching word extent
    // and scores 0.50. Both operators use the GIN trigram indexes; spelling it
    // as `word_similarity(...) > x` instead would force a sequential scan.
    //
    // The threshold lives on the connection (see `Config::trgm_word_threshold`)
    // because `<%` reads it from a GUC rather than taking it inline.
    cached!(
        fuzzy,
        "SELECT {cols} FROM foods
         WHERE $1 <% name OR $1 <% COALESCE(brand, '')
         ORDER BY GREATEST(word_similarity($1, name),
                           word_similarity($1, COALESCE(brand, ''))) DESC,
                  length(name), name
         LIMIT $2"
    );
}
