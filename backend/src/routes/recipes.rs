use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::routing::get;
use axum::Router;
use serde::Deserialize;
use utoipa::IntoParams;
use uuid::Uuid;
use validator::Validate;

use crate::auth::CurrentUser;
use crate::domain::nutrients::Nutrients;
use crate::domain::recipe::{
    Recipe, RecipeItem, RecipeItemRow, RecipeRow, RecipeSummary, UpsertRecipeRequest,
};
use crate::error::{ApiError, ApiResult};
use crate::extract::Json;
use crate::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/", get(list).post(create))
        .route("/{id}", get(get_one).put(update).delete(delete))
}

const RECIPE_COLUMNS: &str =
    "id, user_id, name, description, instructions, servings, is_public, created_at, updated_at";

#[derive(Debug, Default, Deserialize, IntoParams)]
#[serde(default)]
pub struct ListQuery {
    pub q: Option<String>,
    /// `mine` (default) lists only your recipes; `public` lists everyone's
    /// shared ones; `all` lists both.
    pub scope: Option<String>,
}

#[utoipa::path(
    get, path = "/api/v1/recipes", tag = "recipes",
    security(("bearer" = [])),
    params(ListQuery),
    responses((status = 200, body = Vec<RecipeSummary>))
)]
pub async fn list(
    State(state): State<AppState>,
    user: CurrentUser,
    Query(q): Query<ListQuery>,
) -> ApiResult<Json<Vec<RecipeSummary>>> {
    let term = q.q.as_deref().map(str::trim).filter(|s| !s.is_empty());
    let scope = match q.scope.as_deref() {
        Some("public") => "public",
        Some("all") => "all",
        _ => "mine",
    };

    // Aggregate the macros in SQL rather than fetching every ingredient row:
    // the list view only needs totals, and this keeps it to a single query
    // regardless of how many recipes or ingredients exist.
    #[derive(sqlx::FromRow)]
    struct Row {
        id: Uuid,
        user_id: Uuid,
        name: String,
        description: Option<String>,
        servings: f64,
        is_public: bool,
        author: Option<String>,
        created_at: chrono::DateTime<chrono::Utc>,
        updated_at: chrono::DateTime<chrono::Utc>,
        item_count: i64,
        total_weight_g: f64,
        calories_kcal: f64,
        protein_g: f64,
        carbs_g: f64,
        fat_g: f64,
        fiber_g: f64,
        sugar_g: f64,
        saturated_fat_g: f64,
        sodium_mg: f64,
    }

    let rows: Vec<Row> = sqlx::query_as(
        r#"
        SELECT r.id, r.user_id, r.name, r.description, r.servings, r.is_public,
               u.display_name AS author, r.created_at, r.updated_at,
               COALESCE(t.item_count, 0)      AS item_count,
               COALESCE(t.total_weight_g, 0)  AS total_weight_g,
               COALESCE(t.calories_kcal, 0)   AS calories_kcal,
               COALESCE(t.protein_g, 0)       AS protein_g,
               COALESCE(t.carbs_g, 0)         AS carbs_g,
               COALESCE(t.fat_g, 0)           AS fat_g,
               COALESCE(t.fiber_g, 0)         AS fiber_g,
               COALESCE(t.sugar_g, 0)         AS sugar_g,
               COALESCE(t.saturated_fat_g, 0) AS saturated_fat_g,
               COALESCE(t.sodium_mg, 0)       AS sodium_mg
        FROM recipes r
        JOIN users u ON u.id = r.user_id
        LEFT JOIN LATERAL (
            SELECT count(*)                                       AS item_count,
                   sum(ri.quantity_g)                             AS total_weight_g,
                   sum(f.calories_kcal   * ri.quantity_g / 100.0) AS calories_kcal,
                   sum(f.protein_g       * ri.quantity_g / 100.0) AS protein_g,
                   sum(f.carbs_g         * ri.quantity_g / 100.0) AS carbs_g,
                   sum(f.fat_g           * ri.quantity_g / 100.0) AS fat_g,
                   sum(COALESCE(f.fiber_g, 0)         * ri.quantity_g / 100.0) AS fiber_g,
                   sum(COALESCE(f.sugar_g, 0)         * ri.quantity_g / 100.0) AS sugar_g,
                   sum(COALESCE(f.saturated_fat_g, 0) * ri.quantity_g / 100.0) AS saturated_fat_g,
                   sum(COALESCE(f.sodium_mg, 0)       * ri.quantity_g / 100.0) AS sodium_mg
            FROM recipe_items ri
            JOIN foods f ON f.id = ri.food_id
            WHERE ri.recipe_id = r.id
        ) t ON TRUE
        WHERE CASE $3::text
                WHEN 'public' THEN r.is_public
                WHEN 'all'    THEN (r.user_id = $1 OR r.is_public)
                ELSE r.user_id = $1
              END
          AND ($2::text IS NULL OR r.name ILIKE '%' || $2 || '%')
        -- Your own first, then everyone's shared ones, newest first within each.
        ORDER BY (r.user_id = $1) DESC, r.updated_at DESC
        "#,
    )
    .bind(user.id)
    .bind(term)
    .bind(scope)
    .fetch_all(&state.db)
    .await?;

    let summaries = rows
        .into_iter()
        .map(|r| {
            let total = Nutrients {
                calories_kcal: r.calories_kcal,
                protein_g: r.protein_g,
                carbs_g: r.carbs_g,
                fat_g: r.fat_g,
                fiber_g: r.fiber_g,
                sugar_g: r.sugar_g,
                saturated_fat_g: r.saturated_fat_g,
                sodium_mg: r.sodium_mg,
            };
            RecipeSummary {
                id: r.id,
                is_owner: r.user_id == user.id,
                author: (r.user_id != user.id).then_some(r.author).flatten(),
                is_public: r.is_public,
                name: r.name,
                description: r.description,
                servings: r.servings,
                total_weight_g: round2(r.total_weight_g),
                item_count: r.item_count,
                per_serving: total.scaled(1.0 / r.servings).rounded(),
                created_at: r.created_at,
                updated_at: r.updated_at,
            }
        })
        .collect();

    Ok(Json(summaries))
}

#[utoipa::path(
    get, path = "/api/v1/recipes/{id}", tag = "recipes",
    security(("bearer" = [])),
    params(("id" = Uuid, Path, description = "Recipe id")),
    responses((status = 200, body = Recipe), (status = 404, body = crate::error::ErrorBody))
)]
pub async fn get_one(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<Recipe>> {
    Ok(Json(load_recipe(&state, user.id, id).await?))
}

#[utoipa::path(
    post, path = "/api/v1/recipes", tag = "recipes",
    security(("bearer" = [])),
    request_body = UpsertRecipeRequest,
    responses((status = 201, body = Recipe), (status = 400, body = crate::error::ErrorBody))
)]
pub async fn create(
    State(state): State<AppState>,
    user: CurrentUser,
    Json(body): Json<UpsertRecipeRequest>,
) -> ApiResult<(StatusCode, Json<Recipe>)> {
    body.validate()?;

    // Header and ingredients are written in one transaction: a recipe that
    // exists with half its ingredients would silently misreport its macros.
    let mut tx = state.db.begin().await?;

    let recipe: RecipeRow = sqlx::query_as(&format!(
        "INSERT INTO recipes (user_id, name, description, instructions, servings, is_public)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING {RECIPE_COLUMNS}"
    ))
    .bind(user.id)
    .bind(body.name.trim())
    .bind(body.description.as_deref())
    .bind(body.instructions.as_deref())
    .bind(body.servings)
    .bind(body.is_public)
    .fetch_one(&mut *tx)
    .await?;

    insert_items(&mut tx, recipe.id, &body).await?;
    tx.commit().await?;

    let full = load_recipe(&state, user.id, recipe.id).await?;
    Ok((StatusCode::CREATED, Json(full)))
}

#[utoipa::path(
    put, path = "/api/v1/recipes/{id}", tag = "recipes",
    security(("bearer" = [])),
    params(("id" = Uuid, Path, description = "Recipe id")),
    request_body = UpsertRecipeRequest,
    responses((status = 200, body = Recipe), (status = 404, body = crate::error::ErrorBody))
)]
pub async fn update(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<Uuid>,
    Json(body): Json<UpsertRecipeRequest>,
) -> ApiResult<Json<Recipe>> {
    body.validate()?;

    let mut tx = state.db.begin().await?;

    let updated: Option<RecipeRow> = sqlx::query_as(&format!(
        "UPDATE recipes SET name = $3, description = $4, instructions = $5, servings = $6,
                            is_public = $7, updated_at = now()
         WHERE id = $1 AND user_id = $2
         RETURNING {RECIPE_COLUMNS}"
    ))
    .bind(id)
    .bind(user.id)
    .bind(body.name.trim())
    .bind(body.description.as_deref())
    .bind(body.instructions.as_deref())
    .bind(body.servings)
    .bind(body.is_public)
    .fetch_optional(&mut *tx)
    .await?;

    if updated.is_none() {
        return Err(ApiError::NotFound("recipe"));
    }

    // Ingredient list is replaced wholesale — simpler and less error-prone than
    // diffing, and the list is small enough that the rewrite cost is irrelevant.
    sqlx::query("DELETE FROM recipe_items WHERE recipe_id = $1")
        .bind(id)
        .execute(&mut *tx)
        .await?;

    insert_items(&mut tx, id, &body).await?;
    tx.commit().await?;

    Ok(Json(load_recipe(&state, user.id, id).await?))
}

#[utoipa::path(
    delete, path = "/api/v1/recipes/{id}", tag = "recipes",
    security(("bearer" = [])),
    params(("id" = Uuid, Path, description = "Recipe id")),
    responses(
        (status = 204, description = "Deleted"),
        (status = 400, description = "Still referenced by a diary entry", body = crate::error::ErrorBody),
        (status = 404, body = crate::error::ErrorBody),
    )
)]
pub async fn delete(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<Uuid>,
) -> ApiResult<StatusCode> {
    let result = sqlx::query("DELETE FROM recipes WHERE id = $1 AND user_id = $2")
        .bind(id)
        .bind(user.id)
        .execute(&state.db)
        .await
        .map_err(|e| match e {
            sqlx::Error::Database(ref db) if db.is_foreign_key_violation() => {
                ApiError::bad_request("this recipe is logged in your diary and cannot be deleted")
            }
            other => other.into(),
        })?;

    if result.rows_affected() == 0 {
        return Err(ApiError::NotFound("recipe"));
    }
    Ok(StatusCode::NO_CONTENT)
}

async fn insert_items(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    recipe_id: Uuid,
    body: &UpsertRecipeRequest,
) -> ApiResult<()> {
    let food_ids: Vec<Uuid> = body.items.iter().map(|i| i.food_id).collect();
    let quantities: Vec<f64> = body.items.iter().map(|i| i.quantity_g).collect();
    let notes: Vec<Option<String>> = body.items.iter().map(|i| i.note.clone()).collect();
    let orders: Vec<i32> = (0..body.items.len() as i32).collect();

    // Validate every ingredient in one query rather than one per item. Checking
    // explicitly (instead of relying on the foreign key) is what lets an unknown
    // id come back as a clear 400 naming the id rather than an opaque
    // constraint error. Foods are global, so there is no visibility test.
    let known: Vec<Uuid> = sqlx::query_scalar("SELECT id FROM foods WHERE id = ANY($1)")
        .bind(&food_ids)
        .fetch_all(&mut **tx)
        .await?;

    if let Some(missing) = food_ids.iter().find(|id| !known.contains(id)) {
        return Err(ApiError::bad_request(format!("unknown food id {missing}")));
    }

    // One INSERT for the whole ingredient list: UNNEST turns the parallel
    // arrays into rows, so a 20-ingredient recipe is a single round trip.
    sqlx::query(
        "INSERT INTO recipe_items (recipe_id, food_id, quantity_g, note, sort_order)
         SELECT $1, * FROM UNNEST($2::uuid[], $3::float8[], $4::text[], $5::int[])",
    )
    .bind(recipe_id)
    .bind(&food_ids)
    .bind(&quantities)
    .bind(&notes)
    .bind(&orders)
    .execute(&mut **tx)
    .await?;

    Ok(())
}

pub async fn load_recipe(state: &AppState, user_id: Uuid, id: Uuid) -> ApiResult<Recipe> {
    // Visible when you own it or its author shared it. Editing stays owner-only
    // and is checked separately by the handlers that write.
    // The author's name is only needed here, so it rides along on a local row
    // type rather than widening RecipeRow, which the write paths also use and
    // which never joins `users`.
    #[derive(sqlx::FromRow)]
    struct Row {
        id: Uuid,
        user_id: Uuid,
        name: String,
        description: Option<String>,
        instructions: Option<String>,
        servings: f64,
        is_public: bool,
        author: String,
        created_at: chrono::DateTime<chrono::Utc>,
        updated_at: chrono::DateTime<chrono::Utc>,
    }

    let recipe: Row = sqlx::query_as(
        "SELECT r.id, r.user_id, r.name, r.description, r.instructions, r.servings,
                r.is_public, u.display_name AS author, r.created_at, r.updated_at
         FROM recipes r JOIN users u ON u.id = r.user_id
         WHERE r.id = $1 AND (r.user_id = $2 OR r.is_public)",
    )
    .bind(id)
    .bind(user_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or(ApiError::NotFound("recipe"))?;

    let author = recipe.author.clone();

    let item_rows: Vec<RecipeItemRow> = sqlx::query_as(
        r#"
        SELECT ri.id, ri.recipe_id, ri.food_id, ri.quantity_g, ri.note, ri.sort_order,
               f.name AS food_name, f.brand AS food_brand,
               f.calories_kcal, f.protein_g, f.carbs_g, f.fat_g,
               f.fiber_g, f.sugar_g, f.saturated_fat_g, f.sodium_mg
        FROM recipe_items ri
        JOIN foods f ON f.id = ri.food_id
        WHERE ri.recipe_id = $1
        ORDER BY ri.sort_order ASC
        "#,
    )
    .bind(id)
    .fetch_all(&state.db)
    .await?;

    let total: Nutrients = item_rows.iter().map(|r| r.nutrients()).sum();
    let total_weight_g = item_rows.iter().map(|r| r.quantity_g).sum::<f64>();

    let items = item_rows
        .into_iter()
        .map(|r| RecipeItem {
            nutrients: r.nutrients().rounded(),
            id: r.id,
            food_id: r.food_id,
            food_name: r.food_name,
            food_brand: r.food_brand,
            quantity_g: r.quantity_g,
            note: r.note,
            sort_order: r.sort_order,
        })
        .collect();

    let is_owner = recipe.user_id == user_id;

    Ok(Recipe {
        id: recipe.id,
        is_owner,
        is_public: recipe.is_public,
        author: (!is_owner).then_some(author),
        name: recipe.name,
        description: recipe.description,
        instructions: recipe.instructions,
        servings: recipe.servings,
        total_weight_g: round2(total_weight_g),
        items,
        total: total.rounded(),
        per_serving: total.scaled(1.0 / recipe.servings).rounded(),
        created_at: recipe.created_at,
        updated_at: recipe.updated_at,
    })
}

fn round2(v: f64) -> f64 {
    (v * 100.0).round() / 100.0
}
