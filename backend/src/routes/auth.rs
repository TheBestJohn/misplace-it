use axum::extract::State;
use axum::routing::{get, post};
use axum::{Json, Router};
use validator::Validate;

use crate::auth::{hash_password, issue_token, verify_password, CurrentUser};
use crate::domain::user::{AuthResponse, LoginRequest, Profile, RegisterRequest, UserRow};
use crate::error::{ApiError, ApiResult};
use crate::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/register", post(register))
        .route("/login", post(login))
        .route("/me", get(me))
}

const USER_COLUMNS: &str = r#"
    id, email, password_hash, display_name, sex, birth_date, height_cm,
    activity_level, goal, target_weight_kg, daily_calorie_target,
    daily_protein_target_g, daily_carbs_target_g, daily_fat_target_g,
    created_at, updated_at
"#;

#[utoipa::path(
    post, path = "/api/v1/auth/register", tag = "auth",
    request_body = RegisterRequest,
    responses(
        (status = 201, description = "Account created", body = AuthResponse),
        (status = 400, description = "Validation failed", body = crate::error::ErrorBody),
        (status = 409, description = "Email already registered", body = crate::error::ErrorBody),
    )
)]
pub async fn register(
    State(state): State<AppState>,
    Json(body): Json<RegisterRequest>,
) -> ApiResult<(axum::http::StatusCode, Json<AuthResponse>)> {
    if !state.config.allow_registration {
        return Err(ApiError::Forbidden);
    }
    body.validate()?;

    let email = body.email.trim().to_lowercase();
    let hash = hash_password(&body.password)?;

    let user: UserRow = sqlx::query_as(&format!(
        "INSERT INTO users (email, password_hash, display_name)
         VALUES ($1, $2, $3)
         RETURNING {USER_COLUMNS}"
    ))
    .bind(&email)
    .bind(&hash)
    .bind(body.display_name.trim())
    .fetch_one(&state.db)
    .await
    .map_err(|e| match e {
        sqlx::Error::Database(ref db) if db.is_unique_violation() => {
            ApiError::Conflict("that email is already registered".into())
        }
        other => other.into(),
    })?;

    Ok((
        axum::http::StatusCode::CREATED,
        Json(token_response(&state, user)?),
    ))
}

#[utoipa::path(
    post, path = "/api/v1/auth/login", tag = "auth",
    request_body = LoginRequest,
    responses(
        (status = 200, description = "Signed in", body = AuthResponse),
        (status = 401, description = "Bad credentials", body = crate::error::ErrorBody),
    )
)]
pub async fn login(
    State(state): State<AppState>,
    Json(body): Json<LoginRequest>,
) -> ApiResult<Json<AuthResponse>> {
    let email = body.email.trim().to_lowercase();

    let user: Option<UserRow> = sqlx::query_as(&format!(
        "SELECT {USER_COLUMNS} FROM users WHERE lower(email) = $1"
    ))
    .bind(&email)
    .fetch_optional(&state.db)
    .await?;

    // Verify against the stored hash only when the user exists; the generic
    // error keeps "no such account" and "wrong password" indistinguishable.
    let user = user.ok_or(ApiError::Unauthorized)?;
    if !verify_password(&body.password, &user.password_hash) {
        return Err(ApiError::Unauthorized);
    }

    Ok(Json(token_response(&state, user)?))
}

#[utoipa::path(
    get, path = "/api/v1/auth/me", tag = "auth",
    security(("bearer" = [])),
    responses(
        (status = 200, description = "Current user", body = Profile),
        (status = 401, description = "Not signed in", body = crate::error::ErrorBody),
    )
)]
pub async fn me(State(state): State<AppState>, user: CurrentUser) -> ApiResult<Json<Profile>> {
    let row: UserRow = sqlx::query_as(&format!("SELECT {USER_COLUMNS} FROM users WHERE id = $1"))
        .bind(user.id)
        .fetch_optional(&state.db)
        .await?
        .ok_or(ApiError::NotFound("user"))?;
    Ok(Json(row.into()))
}

fn token_response(state: &AppState, user: UserRow) -> ApiResult<AuthResponse> {
    let (access_token, expires_in) = issue_token(
        user.id,
        &user.email,
        &state.config.jwt_secret,
        state.config.jwt_ttl_hours,
    )?;
    Ok(AuthResponse {
        access_token,
        token_type: "Bearer",
        expires_in,
        user: user.into(),
    })
}
