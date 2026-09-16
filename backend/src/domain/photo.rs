use chrono::{DateTime, Utc};
use serde::Serialize;
use sqlx::FromRow;
use utoipa::ToSchema;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, FromRow, ToSchema)]
pub struct Photo {
    pub id: Uuid,
    pub weight_entry_id: Uuid,
    pub content_type: String,
    pub byte_size: i64,
    pub width: i32,
    pub height: i32,
    pub caption: Option<String>,
    pub created_at: DateTime<Utc>,
    /// Where to fetch the bytes. Served by the API rather than as a static
    /// file so the ownership check cannot be bypassed by guessing a URL —
    /// these are progress photos, not public assets.
    pub url: String,
}

/// The row as stored. `relative_path` never leaves the server: exposing it
/// would invite clients to construct their own file paths.
#[derive(Debug, FromRow)]
pub struct PhotoRow {
    pub id: Uuid,
    pub weight_entry_id: Uuid,
    pub relative_path: String,
    pub content_type: String,
    pub byte_size: i64,
    pub width: i32,
    pub height: i32,
    pub caption: Option<String>,
    pub created_at: DateTime<Utc>,
}

impl From<PhotoRow> for Photo {
    fn from(r: PhotoRow) -> Self {
        Self {
            url: format!("/api/v1/photos/{}", r.id),
            id: r.id,
            weight_entry_id: r.weight_entry_id,
            content_type: r.content_type,
            byte_size: r.byte_size,
            width: r.width,
            height: r.height,
            caption: r.caption,
            created_at: r.created_at,
        }
    }
}
