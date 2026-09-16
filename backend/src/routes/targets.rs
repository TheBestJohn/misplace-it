use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::get;
use axum::Router;
use uuid::Uuid;
use validator::Validate;

use crate::auth::CurrentUser;
use crate::domain::target::{Nutrient, NutritionTarget, ReplaceTargetsRequest, TargetKind};
use crate::error::{ApiError, ApiResult};
use crate::extract::Json;
use crate::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/", get(list).put(replace))
        .route("/{nutrient}", get(get_one).delete(delete))
}

#[utoipa::path(
    get, path = "/api/v1/targets", tag = "targets",
    security(("bearer" = [])),
    responses((status = 200, description = "Targets you have set", body = Vec<NutritionTarget>))
)]
pub async fn list(
    State(state): State<AppState>,
    user: CurrentUser,
) -> ApiResult<Json<Vec<NutritionTarget>>> {
    Ok(Json(load_targets(&state, user.id).await?))
}

#[utoipa::path(
    get, path = "/api/v1/targets/{nutrient}", tag = "targets",
    security(("bearer" = [])),
    params(("nutrient" = String, Path, description = "e.g. calories_kcal, protein_g")),
    responses(
        (status = 200, body = NutritionTarget),
        (status = 404, description = "No target set for that nutrient", body = crate::error::ErrorBody),
    )
)]
pub async fn get_one(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(nutrient): Path<String>,
) -> ApiResult<Json<NutritionTarget>> {
    let nutrient = Nutrient::from_key(&nutrient)
        .ok_or_else(|| ApiError::bad_request(format!("unknown nutrient '{nutrient}'")))?;

    load_targets(&state, user.id)
        .await?
        .into_iter()
        .find(|t| t.nutrient == nutrient)
        .map(Json)
        .ok_or(ApiError::NotFound("target"))
}

#[utoipa::path(
    put, path = "/api/v1/targets", tag = "targets",
    security(("bearer" = [])),
    request_body = ReplaceTargetsRequest,
    responses(
        (status = 200, description = "The full set after replacement", body = Vec<NutritionTarget>),
        (status = 400, body = crate::error::ErrorBody),
    )
)]
pub async fn replace(
    State(state): State<AppState>,
    user: CurrentUser,
    Json(body): Json<ReplaceTargetsRequest>,
) -> ApiResult<Json<Vec<NutritionTarget>>> {
    body.validate()?;

    // The settings screen edits the whole set at once, so PUT replaces it
    // wholesale: a nutrient left out of the body is a target the user cleared.
    // Rejecting duplicates here keeps "last one wins" from silently discarding
    // an entry the caller thought it had sent.
    let mut seen = Vec::with_capacity(body.targets.len());
    for t in &body.targets {
        if seen.contains(&t.nutrient) {
            return Err(ApiError::bad_request(format!(
                "duplicate target for '{}'",
                t.nutrient.key()
            )));
        }
        seen.push(t.nutrient);
    }

    let nutrients: Vec<String> = body
        .targets
        .iter()
        .map(|t| t.nutrient.key().into())
        .collect();
    let amounts: Vec<f64> = body.targets.iter().map(|t| t.amount).collect();
    let kinds: Vec<String> = body
        .targets
        .iter()
        .map(|t| {
            t.kind
                .unwrap_or_else(|| t.nutrient.default_kind())
                .as_str()
                .into()
        })
        .collect();

    let mut tx = state.db.begin().await?;

    // Delete-then-insert inside one transaction, so a failed write cannot
    // leave the user with half a set of targets.
    sqlx::query("DELETE FROM nutrition_targets WHERE user_id = $1")
        .bind(user.id)
        .execute(&mut *tx)
        .await?;

    if !nutrients.is_empty() {
        sqlx::query(
            "INSERT INTO nutrition_targets (user_id, nutrient, amount, kind)
             SELECT $1, * FROM UNNEST($2::text[], $3::float8[], $4::text[])",
        )
        .bind(user.id)
        .bind(&nutrients)
        .bind(&amounts)
        .bind(&kinds)
        .execute(&mut *tx)
        .await?;
    }

    tx.commit().await?;

    Ok(Json(load_targets(&state, user.id).await?))
}

#[utoipa::path(
    delete, path = "/api/v1/targets/{nutrient}", tag = "targets",
    security(("bearer" = [])),
    params(("nutrient" = String, Path, description = "e.g. calories_kcal, protein_g")),
    responses(
        (status = 204, description = "Target cleared"),
        (status = 404, body = crate::error::ErrorBody),
    )
)]
pub async fn delete(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(nutrient): Path<String>,
) -> ApiResult<StatusCode> {
    let nutrient = Nutrient::from_key(&nutrient)
        .ok_or_else(|| ApiError::bad_request(format!("unknown nutrient '{nutrient}'")))?;

    let result = sqlx::query("DELETE FROM nutrition_targets WHERE user_id = $1 AND nutrient = $2")
        .bind(user.id)
        .bind(nutrient.key())
        .execute(&state.db)
        .await?;

    if result.rows_affected() == 0 {
        return Err(ApiError::NotFound("target"));
    }
    Ok(StatusCode::NO_CONTENT)
}

/// Load a user's targets, ordered for display (calories, macros, then the rest).
pub async fn load_targets(state: &AppState, user_id: Uuid) -> ApiResult<Vec<NutritionTarget>> {
    let rows: Vec<(String, f64, String)> =
        sqlx::query_as("SELECT nutrient, amount, kind FROM nutrition_targets WHERE user_id = $1")
            .bind(user_id)
            .fetch_all(&state.db)
            .await?;

    let mut targets: Vec<NutritionTarget> = rows
        .into_iter()
        .filter_map(|(nutrient, amount, kind)| {
            // A row whose vocabulary this build does not know is skipped rather
            // than failing the request — a rolled-back deploy still serves.
            let nutrient = Nutrient::from_key(&nutrient)?;
            let kind = TargetKind::from_str(&kind)?;
            Some(NutritionTarget {
                nutrient,
                amount,
                kind,
                label: nutrient.label(),
                unit: nutrient.unit(),
            })
        })
        .collect();

    targets.sort_by_key(|t| {
        crate::domain::target::ALL_NUTRIENTS
            .iter()
            .position(|n| *n == t.nutrient)
            .unwrap_or(usize::MAX)
    });

    Ok(targets)
}
