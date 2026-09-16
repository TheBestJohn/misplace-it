use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use utoipa::ToSchema;
use uuid::Uuid;
use validator::Validate;

/// What a key is allowed to do.
///
/// Two scopes rather than a per-endpoint permission matrix: the realistic uses
/// for a key here are "let my dashboard read my numbers" and "let my script log
/// meals", and a finer-grained model would be more surface to get wrong than
/// anyone is asking for. `read` maps to safe HTTP methods, `write` to the rest.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum ApiKeyScope {
    Read,
    Write,
}

impl ApiKeyScope {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Read => "read",
            Self::Write => "write",
        }
    }
}

/// A key as listed back to its owner. There is no field for the token: once
/// issued it exists only as a digest, so this is all the server can still say
/// about it.
#[derive(Debug, Clone, Serialize, FromRow, ToSchema)]
pub struct ApiKey {
    pub id: Uuid,
    pub name: String,
    /// The non-secret leading characters, e.g. `nomi_7Fq3xA…`, so a key can be
    /// told apart from its siblings in a list.
    pub prefix: String,
    pub scopes: Vec<String>,
    pub last_used_at: Option<DateTime<Utc>>,
    pub expires_at: Option<DateTime<Utc>>,
    pub revoked_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
}

/// The one and only response that contains the token itself.
#[derive(Debug, Serialize, ToSchema)]
pub struct CreatedApiKey {
    #[serde(flatten)]
    pub key: ApiKey,
    /// The full token. Shown once, at creation, and never recoverable
    /// afterwards — the server keeps only a digest of it.
    pub token: String,
}

#[derive(Debug, Deserialize, Validate, ToSchema)]
pub struct CreateApiKeyRequest {
    /// What this key is for, so future-you can revoke the right one.
    #[validate(length(min = 1, max = 80, message = "must be 1-80 characters"))]
    pub name: String,
    /// Defaults to read-only: the safer of the two is the one you get by not
    /// thinking about it.
    #[serde(default)]
    pub scopes: Vec<ApiKeyScope>,
    /// Optional lifetime in days. A key with no expiry never stops working,
    /// which is occasionally what you want and usually not.
    #[validate(range(min = 1, max = 3650, message = "must be between 1 and 3650 days"))]
    pub expires_in_days: Option<i64>,
}
