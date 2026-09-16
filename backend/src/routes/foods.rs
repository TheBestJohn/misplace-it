use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use uuid::Uuid;
use validator::Validate;

use crate::auth::CurrentUser;
use crate::domain::food::{
    BarcodeLookup, ExternalFood, ExternalSearchQuery, ExternalSearchResponse, Food, FoodDetail,
    FoodSearchQuery, UpsertFoodRequest,
};
use crate::error::{ApiError, ApiResult};
use crate::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/", get(list).post(create))
        .route("/search/external", get(search_external))
        .route("/external/{source}/{source_id}", get(external_detail))
        .route("/barcode/{upc}", get(barcode))
        .route("/import", post(import))
        .route("/{id}", get(get_one).put(update).delete(delete))
}

const COLUMNS: &str = r#"
    id, source, source_id, name, brand, upc, calories_kcal, protein_g, carbs_g, fat_g,
    fiber_g, sugar_g, saturated_fat_g, sodium_mg, serving_size_g, serving_label,
    created_by, created_at, updated_at
"#;

#[utoipa::path(
    get, path = "/api/v1/foods", tag = "foods",
    security(("bearer" = [])),
    params(
        ("q" = Option<String>, Query, description = "Free-text search over name and brand"),
        ("source" = Option<String>, Query, description = "custom | usda | off"),
        ("mine" = Option<bool>, Query, description = "Only foods you created"),
        ("limit" = Option<i64>, Query, description = "Page size, max 100"),
        ("offset" = Option<i64>, Query, description = "Page offset"),
    ),
    responses((status = 200, body = Vec<Food>))
)]
pub async fn list(
    State(state): State<AppState>,
    user: CurrentUser,
    Query(q): Query<FoodSearchQuery>,
) -> ApiResult<Json<Vec<Food>>> {
    let limit = q.limit.clamp(1, 100);
    let offset = q.offset.max(0);
    let term = q.q.as_deref().map(str::trim).filter(|s| !s.is_empty());

    // The local food database is shared (imported reference data is useful to
    // everyone), so visibility is "not user-authored OR authored by me".
    let rows: Vec<Food> = sqlx::query_as(&format!(
        "SELECT {COLUMNS} FROM foods
         WHERE (created_by IS NULL OR created_by = $1)
           AND ($2::text IS NULL OR name ILIKE '%' || $2 || '%' OR brand ILIKE '%' || $2 || '%')
           AND ($3::text IS NULL OR source = $3)
           AND ($4::bool IS FALSE OR created_by = $1)
         ORDER BY
           -- exact prefix matches first, then alphabetically
           CASE WHEN $2::text IS NOT NULL AND name ILIKE $2 || '%' THEN 0 ELSE 1 END,
           name ASC
         LIMIT $5 OFFSET $6"
    ))
    .bind(user.id)
    .bind(term)
    .bind(q.source.as_deref())
    .bind(q.mine)
    .bind(limit)
    .bind(offset)
    .fetch_all(&state.db)
    .await?;

    Ok(Json(rows))
}

#[utoipa::path(
    get, path = "/api/v1/foods/{id}", tag = "foods",
    security(("bearer" = [])),
    params(("id" = Uuid, Path, description = "Food id")),
    responses((status = 200, body = FoodDetail), (status = 404, body = crate::error::ErrorBody))
)]
pub async fn get_one(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<FoodDetail>> {
    Ok(Json(load_food(&state, user.id, id).await?.into()))
}

#[utoipa::path(
    post, path = "/api/v1/foods", tag = "foods",
    security(("bearer" = [])),
    request_body = UpsertFoodRequest,
    responses((status = 201, body = FoodDetail), (status = 400, body = crate::error::ErrorBody))
)]
pub async fn create(
    State(state): State<AppState>,
    user: CurrentUser,
    Json(body): Json<UpsertFoodRequest>,
) -> ApiResult<(StatusCode, Json<FoodDetail>)> {
    body.validate()?;

    let row: Food = sqlx::query_as(&format!(
        "INSERT INTO foods (source, name, brand, upc, calories_kcal, protein_g, carbs_g, fat_g,
                            fiber_g, sugar_g, saturated_fat_g, sodium_mg, serving_size_g,
                            serving_label, created_by)
         VALUES ('custom', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
         RETURNING {COLUMNS}"
    ))
    .bind(body.name.trim())
    .bind(body.brand.as_deref())
    .bind(body.upc.as_deref())
    .bind(body.calories_kcal)
    .bind(body.protein_g)
    .bind(body.carbs_g)
    .bind(body.fat_g)
    .bind(body.fiber_g)
    .bind(body.sugar_g)
    .bind(body.saturated_fat_g)
    .bind(body.sodium_mg)
    .bind(body.serving_size_g)
    .bind(body.serving_label.as_deref())
    .bind(user.id)
    .fetch_one(&state.db)
    .await?;

    Ok((StatusCode::CREATED, Json(row.into())))
}

#[utoipa::path(
    put, path = "/api/v1/foods/{id}", tag = "foods",
    security(("bearer" = [])),
    params(("id" = Uuid, Path, description = "Food id")),
    request_body = UpsertFoodRequest,
    responses(
        (status = 200, body = FoodDetail),
        (status = 403, description = "Imported reference foods are read-only", body = crate::error::ErrorBody),
        (status = 404, body = crate::error::ErrorBody),
    )
)]
pub async fn update(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<Uuid>,
    Json(body): Json<UpsertFoodRequest>,
) -> ApiResult<Json<FoodDetail>> {
    body.validate()?;

    let existing = load_food(&state, user.id, id).await?;
    // Imported rows mirror an upstream record; editing them would silently
    // diverge from the source, so only user-authored foods are writable.
    if existing.created_by != Some(user.id) {
        return Err(ApiError::Forbidden);
    }

    let row: Food = sqlx::query_as(&format!(
        "UPDATE foods SET
            name = $2, brand = $3, upc = $4, calories_kcal = $5, protein_g = $6,
            carbs_g = $7, fat_g = $8, fiber_g = $9, sugar_g = $10, saturated_fat_g = $11,
            sodium_mg = $12, serving_size_g = $13, serving_label = $14, updated_at = now()
         WHERE id = $1
         RETURNING {COLUMNS}"
    ))
    .bind(id)
    .bind(body.name.trim())
    .bind(body.brand.as_deref())
    .bind(body.upc.as_deref())
    .bind(body.calories_kcal)
    .bind(body.protein_g)
    .bind(body.carbs_g)
    .bind(body.fat_g)
    .bind(body.fiber_g)
    .bind(body.sugar_g)
    .bind(body.saturated_fat_g)
    .bind(body.sodium_mg)
    .bind(body.serving_size_g)
    .bind(body.serving_label.as_deref())
    .fetch_one(&state.db)
    .await?;

    Ok(Json(row.into()))
}

#[utoipa::path(
    delete, path = "/api/v1/foods/{id}", tag = "foods",
    security(("bearer" = [])),
    params(("id" = Uuid, Path, description = "Food id")),
    responses(
        (status = 204, description = "Deleted"),
        (status = 400, description = "Still referenced by a recipe or diary entry", body = crate::error::ErrorBody),
        (status = 403, body = crate::error::ErrorBody),
    )
)]
pub async fn delete(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<Uuid>,
) -> ApiResult<StatusCode> {
    let existing = load_food(&state, user.id, id).await?;
    if existing.created_by != Some(user.id) {
        return Err(ApiError::Forbidden);
    }

    // ON DELETE RESTRICT on recipe_items/diary_entries turns this into a
    // foreign-key violation, which the error mapper renders as a 400.
    sqlx::query("DELETE FROM foods WHERE id = $1")
        .bind(id)
        .execute(&state.db)
        .await
        .map_err(|e| match e {
            sqlx::Error::Database(ref db) if db.is_foreign_key_violation() => ApiError::bad_request(
                "this food is used by a recipe or diary entry and cannot be deleted",
            ),
            other => other.into(),
        })?;

    Ok(StatusCode::NO_CONTENT)
}

#[utoipa::path(
    get, path = "/api/v1/foods/search/external", tag = "foods",
    security(("bearer" = [])),
    params(
        ("q" = String, Query, description = "Search terms"),
        ("limit" = Option<i64>, Query, description = "Max results per provider"),
    ),
    responses(
        (status = 200, description = "Candidates from USDA and Open Food Facts", body = ExternalSearchResponse),
        (status = 502, description = "A provider was unreachable", body = crate::error::ErrorBody),
    )
)]
pub async fn search_external(
    State(state): State<AppState>,
    _user: CurrentUser,
    Query(q): Query<ExternalSearchQuery>,
) -> ApiResult<Json<ExternalSearchResponse>> {
    let term = q.q.trim();
    if term.is_empty() {
        return Err(ApiError::bad_request("q must not be empty"));
    }

    // Query both providers concurrently: a slow OFF response should not add to
    // the USDA latency. A provider that fails degrades to a note in
    // `unavailable` rather than failing the whole search.
    let (usda_res, off_res) = tokio::join!(
        state.usda.search(term, q.limit),
        state.off.search(term, q.limit)
    );

    let mut results = Vec::new();
    let mut unavailable = Vec::new();

    match usda_res {
        Ok(Some(mut foods)) => results.append(&mut foods),
        Ok(None) => unavailable.push("usda: no USDA_API_KEY configured".to_string()),
        Err(e) => unavailable.push(format!("usda: {e}")),
    }
    match off_res {
        Ok(mut foods) => results.append(&mut foods),
        Err(e) => unavailable.push(format!("off: {e}")),
    }

    Ok(Json(ExternalSearchResponse {
        results,
        unavailable,
    }))
}

#[utoipa::path(
    get, path = "/api/v1/foods/barcode/{upc}", tag = "foods",
    security(("bearer" = [])),
    params(("upc" = String, Path, description = "UPC/EAN barcode digits")),
    responses(
        (status = 200, description = "Local match and/or an importable candidate", body = BarcodeLookup),
        (status = 404, description = "Barcode unknown locally and upstream", body = crate::error::ErrorBody),
    )
)]
pub async fn barcode(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(upc): Path<String>,
) -> ApiResult<Json<BarcodeLookup>> {
    let upc = upc.trim().to_string();
    if upc.is_empty() || !upc.chars().all(|c| c.is_ascii_digit()) {
        return Err(ApiError::bad_request("barcode must be digits only"));
    }

    // Local hit first — once a barcode has been imported there is no reason to
    // call out to the network again.
    let local: Option<Food> = sqlx::query_as(&format!(
        "SELECT {COLUMNS} FROM foods
         WHERE upc = $1 AND (created_by IS NULL OR created_by = $2)
         ORDER BY created_by NULLS LAST
         LIMIT 1"
    ))
    .bind(&upc)
    .bind(user.id)
    .fetch_optional(&state.db)
    .await?;

    let external = match state.off.by_barcode(&upc).await {
        Ok(found) => found,
        // If we already have it locally, an upstream hiccup is not fatal.
        Err(e) if local.is_some() => {
            tracing::warn!(error = %e, "barcode lookup upstream failed, serving local match");
            None
        }
        Err(e) => return Err(e),
    };

    if local.is_none() && external.is_none() {
        return Err(ApiError::NotFound("barcode"));
    }

    Ok(Json(BarcodeLookup {
        upc,
        local: local.map(Into::into),
        external,
    }))
}

#[utoipa::path(
    post, path = "/api/v1/foods/import", tag = "foods",
    security(("bearer" = [])),
    request_body = ExternalFood,
    responses(
        (status = 200, description = "Imported, or returned the existing copy", body = FoodDetail),
        (status = 400, body = crate::error::ErrorBody),
    )
)]
pub async fn import(
    State(state): State<AppState>,
    _user: CurrentUser,
    Json(body): Json<ExternalFood>,
) -> ApiResult<Json<FoodDetail>> {
    if !matches!(body.source.as_str(), "usda" | "off") {
        return Err(ApiError::bad_request("source must be 'usda' or 'off'"));
    }
    if body.source_id.trim().is_empty() {
        return Err(ApiError::bad_request("source_id is required"));
    }

    // Idempotent by (source, source_id): importing the same upstream food twice
    // refreshes it in place instead of creating a duplicate.
    let row: Food = sqlx::query_as(&format!(
        "INSERT INTO foods (source, source_id, name, brand, upc, calories_kcal, protein_g,
                            carbs_g, fat_g, fiber_g, sugar_g, saturated_fat_g, sodium_mg,
                            serving_size_g, serving_label)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
         ON CONFLICT (source, source_id) WHERE source_id IS NOT NULL DO UPDATE SET
            name = EXCLUDED.name,
            brand = EXCLUDED.brand,
            upc = EXCLUDED.upc,
            calories_kcal = EXCLUDED.calories_kcal,
            protein_g = EXCLUDED.protein_g,
            carbs_g = EXCLUDED.carbs_g,
            fat_g = EXCLUDED.fat_g,
            fiber_g = EXCLUDED.fiber_g,
            sugar_g = EXCLUDED.sugar_g,
            saturated_fat_g = EXCLUDED.saturated_fat_g,
            sodium_mg = EXCLUDED.sodium_mg,
            serving_size_g = EXCLUDED.serving_size_g,
            serving_label = EXCLUDED.serving_label,
            updated_at = now()
         RETURNING {COLUMNS}"
    ))
    .bind(&body.source)
    .bind(body.source_id.trim())
    .bind(body.name.trim())
    .bind(body.brand.as_deref())
    .bind(body.upc.as_deref())
    .bind(body.calories_kcal.max(0.0))
    .bind(body.protein_g.max(0.0))
    .bind(body.carbs_g.max(0.0))
    .bind(body.fat_g.max(0.0))
    .bind(body.fiber_g)
    .bind(body.sugar_g)
    .bind(body.saturated_fat_g)
    .bind(body.sodium_mg)
    .bind(if body.serving_size_g > 0.0 { body.serving_size_g } else { 100.0 })
    .bind(body.serving_label.as_deref())
    .fetch_one(&state.db)
    .await?;

    Ok(Json(row.into()))
}

#[utoipa::path(
    get, path = "/api/v1/foods/external/{source}/{source_id}", tag = "foods",
    security(("bearer" = [])),
    params(
        ("source" = String, Path, description = "usda | off"),
        ("source_id" = String, Path, description = "FDC id, or barcode for Open Food Facts"),
    ),
    responses(
        (status = 200, description = "Full upstream record, ready to POST to /foods/import", body = ExternalFood),
        (status = 404, body = crate::error::ErrorBody),
    )
)]
pub async fn external_detail(
    State(state): State<AppState>,
    _user: CurrentUser,
    Path((source, source_id)): Path<(String, String)>,
) -> ApiResult<Json<ExternalFood>> {
    // Search results from FDC are abridged; this fetches the full record so an
    // import carries every nutrient the source actually publishes.
    let found = match source.as_str() {
        "usda" => state
            .usda
            .get(&source_id)
            .await?
            .ok_or(ApiError::NotFound("food"))?,
        "off" => state
            .off
            .by_barcode(&source_id)
            .await?
            .ok_or(ApiError::NotFound("food"))?,
        _ => return Err(ApiError::bad_request("source must be 'usda' or 'off'")),
    };

    Ok(Json(found))
}

/// Load a food the caller is allowed to see (shared reference data or their own).
pub async fn load_food(state: &AppState, user_id: Uuid, id: Uuid) -> ApiResult<Food> {
    sqlx::query_as(&format!(
        "SELECT {COLUMNS} FROM foods WHERE id = $1 AND (created_by IS NULL OR created_by = $2)"
    ))
    .bind(id)
    .bind(user_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or(ApiError::NotFound("food"))
}
