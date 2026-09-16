use axum::extract::State;
use axum::routing::{get, post};
use axum::Router;
use validator::Validate;

use crate::auth::{hash_password, issue_token, verify_password, CurrentUser};
use crate::domain::user::{AuthResponse, LoginRequest, Profile, RegisterRequest, UserRow};
use crate::error::{ApiError, ApiResult};
use crate::extract::Json;
use crate::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/register", post(register))
        .route("/login", post(login))
        .route("/me", get(me))
}

use crate::domain::user::USER_COLUMNS;

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

    let mut tx = state.db.begin().await?;

    // Whoever installs a self-hosted instance owns it: there is no outside
    // authority to appoint the first administrator, so the first account to
    // exist becomes one. The advisory lock makes that literally true — without
    // it, two people registering at the same instant could both observe an
    // empty table and both be promoted.
    sqlx::query("SELECT pg_advisory_xact_lock(hashtext('nom_inal.admins'))")
        .execute(&mut *tx)
        .await?;

    let first: bool = sqlx::query_scalar("SELECT NOT EXISTS (SELECT 1 FROM users)")
        .fetch_one(&mut *tx)
        .await?;

    let user: UserRow = sqlx::query_as(&format!(
        "INSERT INTO users (email, password_hash, display_name, is_admin)
         VALUES ($1, $2, $3, $4)
         RETURNING {USER_COLUMNS}"
    ))
    .bind(&email)
    .bind(&hash)
    .bind(body.display_name.trim())
    .bind(first)
    .fetch_one(&mut *tx)
    .await
    .map_err(|e| match e {
        sqlx::Error::Database(ref db) if db.is_unique_violation() => {
            ApiError::Conflict("that email is already registered".into())
        }
        other => other.into(),
    })?;

    tx.commit().await?;

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
    // Checked after the password so a suspended account is not distinguishable
    // from a wrong password to someone who does not already know the password.
    if user.disabled_at.is_some() {
        return Err(ApiError::forbidden("this account has been disabled"));
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
