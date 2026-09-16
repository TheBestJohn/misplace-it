use axum::body::Body;
use axum::extract::{Multipart, Path, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use uuid::Uuid;

use crate::auth::CurrentUser;
use crate::domain::photo::{Photo, PhotoRow};
use crate::error::{ApiError, ApiResult};
use crate::extract::Json;
use crate::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/{id}", get(serve).delete(delete))
        .route("/{id}/caption", axum::routing::patch(set_caption))
}

/// Mounted under `/weights` so a photo is created against the weigh-in it
/// belongs to.
pub fn weight_photo_router() -> Router<AppState> {
    Router::new().route("/{id}/photos", get(list).post(upload))
}

const COLUMNS: &str = "id, weight_entry_id, relative_path, content_type, byte_size, width, height, caption, created_at";

#[utoipa::path(
    get, path = "/api/v1/weights/{id}/photos", tag = "photos",
    security(("bearer" = [])),
    params(("id" = Uuid, Path, description = "Weight entry id")),
    responses((status = 200, body = Vec<Photo>), (status = 404, body = crate::error::ErrorBody))
)]
pub async fn list(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(entry_id): Path<Uuid>,
) -> ApiResult<Json<Vec<Photo>>> {
    let rows: Vec<PhotoRow> = sqlx::query_as(&format!(
        "SELECT {COLUMNS} FROM weigh_in_photos
         WHERE weight_entry_id = $1 AND user_id = $2
         ORDER BY created_at ASC"
    ))
    .bind(entry_id)
    .bind(user.id)
    .fetch_all(&state.db)
    .await?;

    Ok(Json(rows.into_iter().map(Into::into).collect()))
}

#[utoipa::path(
    post, path = "/api/v1/weights/{id}/photos", tag = "photos",
    security(("bearer" = [])),
    params(("id" = Uuid, Path, description = "Weight entry id")),
    request_body(content = String, description = "multipart/form-data with a `file` part and an optional `caption`", content_type = "multipart/form-data"),
    responses(
        (status = 201, body = Photo),
        (status = 400, description = "Not an image, or too large", body = crate::error::ErrorBody),
        (status = 404, body = crate::error::ErrorBody),
    )
)]
pub async fn upload(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(entry_id): Path<Uuid>,
    mut multipart: Multipart,
) -> ApiResult<(StatusCode, Json<Photo>)> {
    // Confirm the weigh-in is this user's before accepting any bytes.
    let owned: Option<(Uuid,)> =
        sqlx::query_as("SELECT id FROM weight_entries WHERE id = $1 AND user_id = $2")
            .bind(entry_id)
            .bind(user.id)
            .fetch_optional(&state.db)
            .await?;
    if owned.is_none() {
        return Err(ApiError::NotFound("weight entry"));
    }

    let mut file: Option<Vec<u8>> = None;
    let mut caption: Option<String> = None;

    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|e| ApiError::bad_request(format!("malformed upload: {e}")))?
    {
        match field.name() {
            Some("file") => {
                let bytes = field
                    .bytes()
                    .await
                    .map_err(|e| ApiError::bad_request(format!("could not read the file: {e}")))?;
                file = Some(bytes.to_vec());
            }
            Some("caption") => {
                let text = field.text().await.unwrap_or_default();
                let text = text.trim();
                if !text.is_empty() {
                    caption = Some(text.chars().take(500).collect());
                }
            }
            _ => {}
        }
    }

    let bytes = file.ok_or_else(|| ApiError::bad_request("a `file` part is required"))?;
    let stored = state.photos.store(user.id, bytes).await?;

    let inserted: Result<PhotoRow, sqlx::Error> = sqlx::query_as(&format!(
        "INSERT INTO weigh_in_photos
            (user_id, weight_entry_id, relative_path, content_type, byte_size, width, height, caption)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING {COLUMNS}"
    ))
    .bind(user.id)
    .bind(entry_id)
    .bind(&stored.relative_path)
    .bind(stored.content_type)
    .bind(stored.byte_size)
    .bind(stored.width)
    .bind(stored.height)
    .bind(caption.as_deref())
    .fetch_one(&state.db)
    .await;

    let row: PhotoRow = match inserted {
        Ok(row) => row,
        Err(e) => {
            // The file is already written; without this it would linger with
            // nothing pointing at it.
            state.photos.remove(&stored.relative_path).await;
            return Err(ApiError::from(e));
        }
    };

    Ok((StatusCode::CREATED, Json(row.into())))
}

#[utoipa::path(
    get, path = "/api/v1/photos/{id}", tag = "photos",
    security(("bearer" = [])),
    params(("id" = Uuid, Path, description = "Photo id")),
    responses(
        (status = 200, description = "The image bytes", content_type = "image/jpeg"),
        (status = 404, body = crate::error::ErrorBody),
    )
)]
pub async fn serve(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<Uuid>,
) -> ApiResult<Response> {
    // Scoped to the owner: these are progress photos, so a guessable URL must
    // not be enough to read one.
    let row: PhotoRow = sqlx::query_as(&format!(
        "SELECT {COLUMNS} FROM weigh_in_photos WHERE id = $1 AND user_id = $2"
    ))
    .bind(id)
    .bind(user.id)
    .fetch_optional(&state.db)
    .await?
    .ok_or(ApiError::NotFound("photo"))?;

    let bytes = state.photos.read(&row.relative_path).await?;

    let mut headers = HeaderMap::new();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_str(&row.content_type)
            .unwrap_or_else(|_| HeaderValue::from_static("image/jpeg")),
    );
    // The bytes at a given id never change, and the response is per-user, so
    // it can be cached hard but only in that user's own browser.
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, max-age=31536000, immutable"),
    );

    Ok((headers, Body::from(bytes)).into_response())
}

#[derive(Debug, serde::Deserialize, utoipa::ToSchema)]
pub struct CaptionRequest {
    pub caption: Option<String>,
}

#[utoipa::path(
    patch, path = "/api/v1/photos/{id}/caption", tag = "photos",
    security(("bearer" = [])),
    params(("id" = Uuid, Path, description = "Photo id")),
    request_body = CaptionRequest,
    responses((status = 200, body = Photo), (status = 404, body = crate::error::ErrorBody))
)]
pub async fn set_caption(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<Uuid>,
    Json(body): Json<CaptionRequest>,
) -> ApiResult<Json<Photo>> {
    let caption = body
        .caption
        .as_deref()
        .map(str::trim)
        .filter(|c| !c.is_empty())
        .map(|c| c.chars().take(500).collect::<String>());

    let row: PhotoRow = sqlx::query_as(&format!(
        "UPDATE weigh_in_photos SET caption = $3 WHERE id = $1 AND user_id = $2 RETURNING {COLUMNS}"
    ))
    .bind(id)
    .bind(user.id)
    .bind(caption)
    .fetch_optional(&state.db)
    .await?
    .ok_or(ApiError::NotFound("photo"))?;

    Ok(Json(row.into()))
}

#[utoipa::path(
    delete, path = "/api/v1/photos/{id}", tag = "photos",
    security(("bearer" = [])),
    params(("id" = Uuid, Path, description = "Photo id")),
    responses((status = 204, description = "Deleted"), (status = 404, body = crate::error::ErrorBody))
)]
pub async fn delete(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<Uuid>,
) -> ApiResult<StatusCode> {
    // Delete the row first and take the path back with it, so a failure leaves
    // an unreferenced file rather than a row pointing at nothing.
    let path: Option<(String,)> = sqlx::query_as(
        "DELETE FROM weigh_in_photos WHERE id = $1 AND user_id = $2 RETURNING relative_path",
    )
    .bind(id)
    .bind(user.id)
    .fetch_optional(&state.db)
    .await?;

    let Some((relative_path,)) = path else {
        return Err(ApiError::NotFound("photo"));
    };

    state.photos.remove(&relative_path).await;
    Ok(StatusCode::NO_CONTENT)
}

/// Remove every photo belonging to a weigh-in, files included.
///
/// The foreign key would cascade the rows on its own, but nothing in the
/// database knows about the filesystem, so deleting a weigh-in has to reclaim
/// the files explicitly or they are orphaned forever.
pub async fn delete_for_weight_entry(
    state: &AppState,
    user_id: Uuid,
    entry_id: Uuid,
) -> ApiResult<()> {
    let paths: Vec<(String,)> = sqlx::query_as(
        "DELETE FROM weigh_in_photos WHERE weight_entry_id = $1 AND user_id = $2
         RETURNING relative_path",
    )
    .bind(entry_id)
    .bind(user_id)
    .fetch_all(&state.db)
    .await?;

    for (path,) in paths {
        state.photos.remove(&path).await;
    }
    Ok(())
}
