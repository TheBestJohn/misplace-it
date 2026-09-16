use axum::extract::State;
use axum::routing::get;
use axum::Router;
use validator::Validate;

use crate::auth::CurrentUser;
use crate::domain::user::{Profile, UpdateProfileRequest, UserRow};
use crate::error::{ApiError, ApiResult};
use crate::extract::Json;
use crate::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new().route("/", get(get_profile).patch(update_profile))
}

const USER_COLUMNS: &str = r#"
    id, email, password_hash, display_name, sex, birth_date, height_cm,
    activity_level, goal, target_weight_kg, created_at, updated_at
"#;

#[utoipa::path(
    get, path = "/api/v1/profile", tag = "profile",
    security(("bearer" = [])),
    responses((status = 200, body = Profile))
)]
pub async fn get_profile(
    State(state): State<AppState>,
    user: CurrentUser,
) -> ApiResult<Json<Profile>> {
    let row: UserRow = sqlx::query_as(&format!("SELECT {USER_COLUMNS} FROM users WHERE id = $1"))
        .bind(user.id)
        .fetch_optional(&state.db)
        .await?
        .ok_or(ApiError::NotFound("user"))?;
    Ok(Json(row.into()))
}

#[utoipa::path(
    patch, path = "/api/v1/profile", tag = "profile",
    security(("bearer" = [])),
    request_body = UpdateProfileRequest,
    responses((status = 200, body = Profile), (status = 400, body = crate::error::ErrorBody))
)]
pub async fn update_profile(
    State(state): State<AppState>,
    user: CurrentUser,
    Json(body): Json<UpdateProfileRequest>,
) -> ApiResult<Json<Profile>> {
    body.validate()?;

    // COALESCE-style partial update: a field left out of the JSON body arrives
    // as NULL and the existing column value is kept.
    let row: UserRow = sqlx::query_as(&format!(
        "UPDATE users SET
            display_name = COALESCE($2, display_name),
            sex = COALESCE($3, sex),
            birth_date = COALESCE($4, birth_date),
            height_cm = COALESCE($5, height_cm),
            activity_level = COALESCE($6, activity_level),
            goal = COALESCE($7, goal),
            target_weight_kg = COALESCE($8, target_weight_kg),
            updated_at = now()
         WHERE id = $1
         RETURNING {USER_COLUMNS}"
    ))
    .bind(user.id)
    .bind(body.display_name.as_deref().map(str::trim))
    .bind(body.sex.as_deref())
    .bind(body.birth_date)
    .bind(body.height_cm)
    .bind(body.activity_level.as_deref())
    .bind(body.goal.as_deref())
    .bind(body.target_weight_kg)
    .fetch_optional(&state.db)
    .await?
    .ok_or(ApiError::NotFound("user"))?;

    Ok(Json(row.into()))
}
