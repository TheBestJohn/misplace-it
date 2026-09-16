use axum::extract::{Path, Query, State};
use axum::routing::get;
use axum::Router;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use utoipa::ToSchema;
use uuid::Uuid;
use validator::Validate;

use crate::auth::AdminUser;
use crate::error::{ApiError, ApiResult};
use crate::extract::Json;
use crate::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/stats", get(stats))
        .route("/users", get(users))
        .route("/users/{id}", axum::routing::patch(patch_user))
}

/// A user as an administrator sees them: identity, standing, and enough
/// activity to tell an abandoned account from a live one.
#[derive(Debug, Serialize, FromRow, ToSchema)]
pub struct AdminUserRow {
    pub id: Uuid,
    pub email: String,
    pub display_name: String,
    pub is_admin: bool,
    pub disabled_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    pub diary_entries: i64,
    pub weigh_ins: i64,
    pub foods_created: i64,
    pub food_edits: i64,
    pub active_api_keys: i64,
    pub last_activity_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct AdminUserQuery {
    /// Substring match on email or display name.
    pub q: Option<String>,
    #[serde(default)]
    pub include_disabled: bool,
}

#[utoipa::path(
    get, path = "/api/v1/admin/users", tag = "admin",
    security(("bearer" = [])),
    params(
        ("q" = Option<String>, Query, description = "Match on email or display name"),
        ("include_disabled" = Option<bool>, Query, description = "Include suspended accounts"),
    ),
    responses(
        (status = 200, body = Vec<AdminUserRow>),
        (status = 403, description = "Not an administrator", body = crate::error::ErrorBody),
    )
)]
pub async fn users(
    State(state): State<AppState>,
    _admin: AdminUser,
    Query(q): Query<AdminUserQuery>,
) -> ApiResult<Json<Vec<AdminUserRow>>> {
    let term = q.q.as_deref().map(str::trim).filter(|s| !s.is_empty());

    // Counted with scalar subqueries rather than a chain of LEFT JOINs: joining
    // five one-to-many tables multiplies the rows together and every count
    // comes out wrong unless each is wrapped in its own DISTINCT, which is both
    // slower and easier to get subtly wrong than just asking five questions.
    let rows: Vec<AdminUserRow> = sqlx::query_as(
        "SELECT u.id, u.email, u.display_name, u.is_admin, u.disabled_at, u.created_at,
                (SELECT count(*) FROM diary_entries  WHERE user_id  = u.id) AS diary_entries,
                (SELECT count(*) FROM weight_entries WHERE user_id  = u.id) AS weigh_ins,
                (SELECT count(*) FROM foods          WHERE created_by = u.id) AS foods_created,
                (SELECT count(*) FROM food_revisions WHERE edited_by = u.id) AS food_edits,
                (SELECT count(*) FROM api_keys
                  WHERE user_id = u.id AND revoked_at IS NULL
                    AND (expires_at IS NULL OR expires_at > now())) AS active_api_keys,
                GREATEST(
                    (SELECT max(created_at) FROM diary_entries  WHERE user_id = u.id),
                    (SELECT max(created_at) FROM weight_entries WHERE user_id = u.id),
                    (SELECT max(created_at) FROM food_revisions WHERE edited_by = u.id)
                ) AS last_activity_at
         FROM users u
         WHERE ($1::text IS NULL OR u.email ILIKE '%' || $1 || '%'
                                 OR u.display_name ILIKE '%' || $1 || '%')
           AND ($2::bool IS TRUE OR u.disabled_at IS NULL)
         ORDER BY u.is_admin DESC, u.created_at ASC",
    )
    .bind(term)
    .bind(q.include_disabled)
    .fetch_all(&state.db)
    .await?;

    Ok(Json(rows))
}

#[derive(Debug, Default, Deserialize, Validate, ToSchema)]
#[serde(default)]
pub struct PatchUserRequest {
    pub is_admin: Option<bool>,
    /// True suspends the account, false restores it.
    pub disabled: Option<bool>,
}

#[utoipa::path(
    patch, path = "/api/v1/admin/users/{id}", tag = "admin",
    security(("bearer" = [])),
    params(("id" = Uuid, Path, description = "User id")),
    request_body = PatchUserRequest,
    responses(
        (status = 200, body = AdminUserRow),
        (status = 400, description = "Would leave the instance with no administrator", body = crate::error::ErrorBody),
        (status = 403, body = crate::error::ErrorBody),
        (status = 404, body = crate::error::ErrorBody),
    )
)]
pub async fn patch_user(
    State(state): State<AppState>,
    admin: AdminUser,
    Path(id): Path<Uuid>,
    Json(body): Json<PatchUserRequest>,
) -> ApiResult<Json<AdminUserRow>> {
    body.validate()?;

    // Locking yourself out is the one mistake here that cannot be undone from
    // inside the application, so both shapes of it are refused: demoting
    // yourself and disabling yourself.
    if id == admin.id {
        if body.is_admin == Some(false) {
            return Err(ApiError::bad_request(
                "you cannot remove your own administrator access; ask another administrator to do it",
            ));
        }
        if body.disabled == Some(true) {
            return Err(ApiError::bad_request("you cannot disable your own account"));
        }
    }

    let mut tx = state.db.begin().await?;

    // Serialises concurrent changes to the administrator set so the
    // last-administrator check below cannot be raced by two simultaneous
    // demotions that each see the other as still holding the role.
    sqlx::query("SELECT pg_advisory_xact_lock(hashtext('nom_inal.admins'))")
        .execute(&mut *tx)
        .await?;

    let exists: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM users WHERE id = $1)")
        .bind(id)
        .fetch_one(&mut *tx)
        .await?;
    if !exists {
        return Err(ApiError::NotFound("user"));
    }

    sqlx::query(
        "UPDATE users SET
            is_admin    = coalesce($2, is_admin),
            disabled_at = CASE
                WHEN $3::bool IS NULL THEN disabled_at
                WHEN $3 THEN coalesce(disabled_at, now())
                ELSE NULL
              END,
            updated_at = now()
         WHERE id = $1",
    )
    .bind(id)
    .bind(body.is_admin)
    .bind(body.disabled)
    .execute(&mut *tx)
    .await?;

    let remaining: i64 =
        sqlx::query_scalar("SELECT count(*) FROM users WHERE is_admin AND disabled_at IS NULL")
            .fetch_one(&mut *tx)
            .await?;

    if remaining == 0 {
        // Rolling back is the whole point: the check runs against the result of
        // the change rather than trying to predict it, which stays correct as
        // more ways to lose an administrator get added.
        tx.rollback().await?;
        return Err(ApiError::bad_request(
            "that would leave the instance with no active administrator",
        ));
    }

    tx.commit().await?;

    let row: AdminUserRow = one_user(&state, id).await?;
    Ok(Json(row))
}

async fn one_user(state: &AppState, id: Uuid) -> ApiResult<AdminUserRow> {
    sqlx::query_as(
        "SELECT u.id, u.email, u.display_name, u.is_admin, u.disabled_at, u.created_at,
                (SELECT count(*) FROM diary_entries  WHERE user_id  = u.id) AS diary_entries,
                (SELECT count(*) FROM weight_entries WHERE user_id  = u.id) AS weigh_ins,
                (SELECT count(*) FROM foods          WHERE created_by = u.id) AS foods_created,
                (SELECT count(*) FROM food_revisions WHERE edited_by = u.id) AS food_edits,
                (SELECT count(*) FROM api_keys
                  WHERE user_id = u.id AND revoked_at IS NULL
                    AND (expires_at IS NULL OR expires_at > now())) AS active_api_keys,
                GREATEST(
                    (SELECT max(created_at) FROM diary_entries  WHERE user_id = u.id),
                    (SELECT max(created_at) FROM weight_entries WHERE user_id = u.id),
                    (SELECT max(created_at) FROM food_revisions WHERE edited_by = u.id)
                ) AS last_activity_at
         FROM users u WHERE u.id = $1",
    )
    .bind(id)
    .fetch_optional(&state.db)
    .await?
    .ok_or(ApiError::NotFound("user"))
}

/// Instance-wide counts, with the food database broken down by editorial state
/// so an administrator can see how much of it has actually been checked.
#[derive(Debug, Serialize, FromRow, ToSchema)]
pub struct AdminStats {
    pub users: i64,
    pub admins: i64,
    pub disabled_users: i64,
    pub foods: i64,
    pub food_variants: i64,
    pub foods_verified: i64,
    pub foods_disputed: i64,
    pub food_revisions: i64,
    pub recipes: i64,
    pub public_recipes: i64,
    pub diary_entries: i64,
    pub weigh_ins: i64,
    pub photos: i64,
    pub active_api_keys: i64,
    /// The quorum this instance is configured with, so the verified count above
    /// can be read without guessing what it was measured against.
    pub food_quorum: i64,
}

#[utoipa::path(
    get, path = "/api/v1/admin/stats", tag = "admin",
    security(("bearer" = [])),
    responses(
        (status = 200, body = AdminStats),
        (status = 403, body = crate::error::ErrorBody),
    )
)]
pub async fn stats(
    State(state): State<AppState>,
    _admin: AdminUser,
) -> ApiResult<Json<AdminStats>> {
    let quorum = state.config.food_quorum;

    let mut row: AdminStats = sqlx::query_as(
        "SELECT
            (SELECT count(*) FROM users) AS users,
            (SELECT count(*) FROM users WHERE is_admin) AS admins,
            (SELECT count(*) FROM users WHERE disabled_at IS NOT NULL) AS disabled_users,
            (SELECT count(*) FROM foods) AS foods,
            (SELECT count(*) FROM foods WHERE variant_of IS NOT NULL) AS food_variants,
            (SELECT count(*) FROM foods WHERE verified_at IS NOT NULL) AS foods_verified,
            (SELECT count(DISTINCT f.id) FROM foods f
               JOIN food_verifications v
                 ON v.food_id = f.id AND v.revision = f.revision AND v.verdict = 'dispute'
            ) AS foods_disputed,
            (SELECT count(*) FROM food_revisions) AS food_revisions,
            (SELECT count(*) FROM recipes) AS recipes,
            (SELECT count(*) FROM recipes WHERE is_public) AS public_recipes,
            (SELECT count(*) FROM diary_entries) AS diary_entries,
            (SELECT count(*) FROM weight_entries) AS weigh_ins,
            (SELECT count(*) FROM weigh_in_photos) AS photos,
            (SELECT count(*) FROM api_keys
              WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())
            ) AS active_api_keys,
            0::bigint AS food_quorum",
    )
    .fetch_one(&state.db)
    .await?;

    row.food_quorum = quorum;
    Ok(Json(row))
}
