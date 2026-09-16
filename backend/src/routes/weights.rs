use axum::extract::{Path, Query, State};
use axum::routing::get;
use axum::{Json, Router};
use chrono::{NaiveDate, Utc};
use serde::Deserialize;
use utoipa::IntoParams;
use uuid::Uuid;
use validator::Validate;

use crate::auth::CurrentUser;
use crate::domain::weight::{PatchWeightRequest, UpsertWeightRequest, WeightEntry, WeightStats};
use crate::error::{ApiError, ApiResult};
use crate::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/", get(list).post(upsert))
        .route("/stats", get(stats))
        .route("/{id}", get(get_one).patch(patch).delete(delete))
}

const COLUMNS: &str = "id, recorded_on, weight_kg, body_fat_pct, note, created_at, updated_at";

#[derive(Debug, Deserialize, IntoParams)]
#[serde(default)]
pub struct ListQuery {
    pub from: Option<NaiveDate>,
    pub to: Option<NaiveDate>,
    pub limit: Option<i64>,
}

impl Default for ListQuery {
    fn default() -> Self {
        Self {
            from: None,
            to: None,
            limit: Some(365),
        }
    }
}

#[utoipa::path(
    get, path = "/api/v1/weights", tag = "weights",
    security(("bearer" = [])),
    params(ListQuery),
    responses((status = 200, body = Vec<WeightEntry>))
)]
pub async fn list(
    State(state): State<AppState>,
    user: CurrentUser,
    Query(q): Query<ListQuery>,
) -> ApiResult<Json<Vec<WeightEntry>>> {
    let limit = q.limit.unwrap_or(365).clamp(1, 5000);

    let rows: Vec<WeightEntry> = sqlx::query_as(&format!(
        "SELECT {COLUMNS} FROM weight_entries
         WHERE user_id = $1
           AND ($2::date IS NULL OR recorded_on >= $2)
           AND ($3::date IS NULL OR recorded_on <= $3)
         ORDER BY recorded_on DESC
         LIMIT $4"
    ))
    .bind(user.id)
    .bind(q.from)
    .bind(q.to)
    .bind(limit)
    .fetch_all(&state.db)
    .await?;

    Ok(Json(rows))
}

#[utoipa::path(
    post, path = "/api/v1/weights", tag = "weights",
    security(("bearer" = [])),
    request_body = UpsertWeightRequest,
    responses(
        (status = 200, description = "Entry created or replaced for that date", body = WeightEntry),
        (status = 400, body = crate::error::ErrorBody),
    )
)]
pub async fn upsert(
    State(state): State<AppState>,
    user: CurrentUser,
    Json(body): Json<UpsertWeightRequest>,
) -> ApiResult<Json<WeightEntry>> {
    body.validate()?;
    let date = body.recorded_on.unwrap_or_else(|| Utc::now().date_naive());

    // One weigh-in per day is the model, so re-posting the same date updates
    // rather than erroring — that is what a "log today's weight" button wants.
    let row: WeightEntry = sqlx::query_as(&format!(
        "INSERT INTO weight_entries (user_id, recorded_on, weight_kg, body_fat_pct, note)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (user_id, recorded_on) DO UPDATE SET
            weight_kg = EXCLUDED.weight_kg,
            body_fat_pct = EXCLUDED.body_fat_pct,
            note = EXCLUDED.note,
            updated_at = now()
         RETURNING {COLUMNS}"
    ))
    .bind(user.id)
    .bind(date)
    .bind(body.weight_kg)
    .bind(body.body_fat_pct)
    .bind(body.note.as_deref())
    .fetch_one(&state.db)
    .await?;

    Ok(Json(row))
}

#[utoipa::path(
    get, path = "/api/v1/weights/{id}", tag = "weights",
    security(("bearer" = [])),
    params(("id" = Uuid, Path, description = "Weight entry id")),
    responses((status = 200, body = WeightEntry), (status = 404, body = crate::error::ErrorBody))
)]
pub async fn get_one(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<WeightEntry>> {
    let row: WeightEntry = sqlx::query_as(&format!(
        "SELECT {COLUMNS} FROM weight_entries WHERE id = $1 AND user_id = $2"
    ))
    .bind(id)
    .bind(user.id)
    .fetch_optional(&state.db)
    .await?
    .ok_or(ApiError::NotFound("weight entry"))?;
    Ok(Json(row))
}

#[utoipa::path(
    patch, path = "/api/v1/weights/{id}", tag = "weights",
    security(("bearer" = [])),
    params(("id" = Uuid, Path, description = "Weight entry id")),
    request_body = PatchWeightRequest,
    responses((status = 200, body = WeightEntry), (status = 404, body = crate::error::ErrorBody))
)]
pub async fn patch(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<Uuid>,
    Json(body): Json<PatchWeightRequest>,
) -> ApiResult<Json<WeightEntry>> {
    body.validate()?;

    let row: WeightEntry = sqlx::query_as(&format!(
        "UPDATE weight_entries SET
            weight_kg = COALESCE($3, weight_kg),
            body_fat_pct = COALESCE($4, body_fat_pct),
            note = COALESCE($5, note),
            updated_at = now()
         WHERE id = $1 AND user_id = $2
         RETURNING {COLUMNS}"
    ))
    .bind(id)
    .bind(user.id)
    .bind(body.weight_kg)
    .bind(body.body_fat_pct)
    .bind(body.note.as_deref())
    .fetch_optional(&state.db)
    .await?
    .ok_or(ApiError::NotFound("weight entry"))?;

    Ok(Json(row))
}

#[utoipa::path(
    delete, path = "/api/v1/weights/{id}", tag = "weights",
    security(("bearer" = [])),
    params(("id" = Uuid, Path, description = "Weight entry id")),
    responses((status = 204, description = "Deleted"), (status = 404, body = crate::error::ErrorBody))
)]
pub async fn delete(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<Uuid>,
) -> ApiResult<axum::http::StatusCode> {
    let result = sqlx::query("DELETE FROM weight_entries WHERE id = $1 AND user_id = $2")
        .bind(id)
        .bind(user.id)
        .execute(&state.db)
        .await?;

    if result.rows_affected() == 0 {
        return Err(ApiError::NotFound("weight entry"));
    }
    Ok(axum::http::StatusCode::NO_CONTENT)
}

#[utoipa::path(
    get, path = "/api/v1/weights/stats", tag = "weights",
    security(("bearer" = [])),
    params(ListQuery),
    responses((status = 200, body = WeightStats))
)]
pub async fn stats(
    State(state): State<AppState>,
    user: CurrentUser,
    Query(q): Query<ListQuery>,
) -> ApiResult<Json<WeightStats>> {
    // Ordered ascending so "earliest vs latest" is unambiguous.
    let rows: Vec<(NaiveDate, f64)> = sqlx::query_as(
        "SELECT recorded_on, weight_kg FROM weight_entries
         WHERE user_id = $1
           AND ($2::date IS NULL OR recorded_on >= $2)
           AND ($3::date IS NULL OR recorded_on <= $3)
         ORDER BY recorded_on ASC",
    )
    .bind(user.id)
    .bind(q.from)
    .bind(q.to)
    .fetch_all(&state.db)
    .await?;

    let weights: Vec<f64> = rows.iter().map(|(_, w)| *w).collect();
    let earliest = weights.first().copied();
    let latest = weights.last().copied();

    let moving_average_7_kg = if weights.is_empty() {
        None
    } else {
        let tail = &weights[weights.len().saturating_sub(7)..];
        Some(round2(tail.iter().sum::<f64>() / tail.len() as f64))
    };

    Ok(Json(WeightStats {
        count: weights.len() as i64,
        latest_kg: latest,
        earliest_kg: earliest,
        change_kg: match (latest, earliest) {
            (Some(l), Some(e)) => Some(round2(l - e)),
            _ => None,
        },
        min_kg: weights.iter().copied().reduce(f64::min),
        max_kg: weights.iter().copied().reduce(f64::max),
        moving_average_7_kg,
    }))
}

fn round2(v: f64) -> f64 {
    (v * 100.0).round() / 100.0
}
