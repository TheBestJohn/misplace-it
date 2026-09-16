use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::get;
use axum::Router;
use chrono::{Duration, Utc};
use uuid::Uuid;
use validator::Validate;

use crate::auth::{generate_api_key, SessionUser};
use crate::domain::api_key::{ApiKey, ApiKeyScope, CreateApiKeyRequest, CreatedApiKey};
use crate::error::{ApiError, ApiResult};
use crate::extract::Json;
use crate::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/", get(list).post(create))
        .route("/{id}", axum::routing::delete(revoke))
}

const COLUMNS: &str = r#"
    id, name, prefix, scopes, last_used_at, expires_at, revoked_at, created_at
"#;

#[utoipa::path(
    get, path = "/api/v1/keys", tag = "keys",
    security(("bearer" = [])),
    responses((status = 200, body = Vec<ApiKey>))
)]
pub async fn list(
    State(state): State<AppState>,
    user: SessionUser,
) -> ApiResult<Json<Vec<ApiKey>>> {
    // Revoked keys stay in the list rather than disappearing: "when did I turn
    // that off" is a question people actually ask after an incident.
    let rows: Vec<ApiKey> = sqlx::query_as(&format!(
        "SELECT {COLUMNS} FROM api_keys
         WHERE user_id = $1
         ORDER BY revoked_at IS NOT NULL, created_at DESC"
    ))
    .bind(user.id)
    .fetch_all(&state.db)
    .await?;

    Ok(Json(rows))
}

#[utoipa::path(
    post, path = "/api/v1/keys", tag = "keys",
    security(("bearer" = [])),
    request_body = CreateApiKeyRequest,
    responses(
        (status = 201, description = "Created. The token is in this response and nowhere else.", body = CreatedApiKey),
        (status = 409, description = "You already have an active key by that name", body = crate::error::ErrorBody),
    )
)]
pub async fn create(
    State(state): State<AppState>,
    user: SessionUser,
    Json(body): Json<CreateApiKeyRequest>,
) -> ApiResult<(StatusCode, Json<CreatedApiKey>)> {
    body.validate()?;

    let mut scopes: Vec<&str> = body.scopes.iter().map(ApiKeyScope::as_str).collect();
    if scopes.is_empty() {
        scopes.push(ApiKeyScope::Read.as_str());
    }
    // `write` without `read` would be a key that can create a diary entry and
    // not read it back, which nobody wants and which only exists by accident.
    if scopes.contains(&"write") && !scopes.contains(&"read") {
        scopes.push(ApiKeyScope::Read.as_str());
    }
    scopes.sort_unstable();
    scopes.dedup();

    let expires_at = body.expires_in_days.map(|d| Utc::now() + Duration::days(d));

    let (token, digest, prefix) = generate_api_key();

    let key: ApiKey = sqlx::query_as(&format!(
        "INSERT INTO api_keys (user_id, name, prefix, token_hash, scopes, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING {COLUMNS}"
    ))
    .bind(user.id)
    .bind(body.name.trim())
    .bind(&prefix)
    .bind(&digest)
    .bind(&scopes)
    .bind(expires_at)
    .fetch_one(&state.db)
    .await
    .map_err(|e| match e {
        sqlx::Error::Database(ref db) if db.is_unique_violation() => {
            ApiError::Conflict("you already have an active key with that name".into())
        }
        other => other.into(),
    })?;

    // The only time the plaintext token exists outside the caller's request.
    Ok((StatusCode::CREATED, Json(CreatedApiKey { key, token })))
}

#[utoipa::path(
    delete, path = "/api/v1/keys/{id}", tag = "keys",
    security(("bearer" = [])),
    params(("id" = Uuid, Path, description = "API key id")),
    responses(
        (status = 200, body = ApiKey),
        (status = 404, body = crate::error::ErrorBody),
    )
)]
pub async fn revoke(
    State(state): State<AppState>,
    user: SessionUser,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<ApiKey>> {
    // Revoked, not deleted: the row is the only remaining evidence that the key
    // ever existed, and `last_used_at` on it is what tells you whether the key
    // you just turned off had been used by someone else.
    let row: Option<ApiKey> = sqlx::query_as(&format!(
        "UPDATE api_keys SET revoked_at = coalesce(revoked_at, now())
         WHERE id = $1 AND user_id = $2
         RETURNING {COLUMNS}"
    ))
    .bind(id)
    .bind(user.id)
    .fetch_optional(&state.db)
    .await?;

    Ok(Json(row.ok_or(ApiError::NotFound("api key"))?))
}
