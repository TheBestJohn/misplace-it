use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Serialize;

/// One error type for the whole API surface. Handlers return `ApiResult<T>` and
/// use `?` freely; the conversion into an HTTP response happens in exactly one
/// place, so every error the client sees has the same JSON shape.
#[derive(Debug, thiserror::Error)]
pub enum ApiError {
    #[error("{0}")]
    BadRequest(String),
    #[error("unauthorized")]
    Unauthorized,
    #[error("forbidden")]
    Forbidden,
    #[error("{0} not found")]
    NotFound(&'static str),
    #[error("{0}")]
    Conflict(String),
    #[error("{0}")]
    UpstreamUnavailable(String),
    #[error(transparent)]
    Database(#[from] sqlx::Error),
    #[error(transparent)]
    Internal(#[from] anyhow::Error),
}

pub type ApiResult<T> = Result<T, ApiError>;

#[derive(Serialize, utoipa::ToSchema)]
pub struct ErrorBody {
    /// Stable machine-readable code, e.g. `not_found`.
    pub error: String,
    /// Human-readable explanation.
    pub message: String,
}

impl ApiError {
    pub fn bad_request(msg: impl Into<String>) -> Self {
        Self::BadRequest(msg.into())
    }

    fn parts(&self) -> (StatusCode, &'static str) {
        match self {
            Self::BadRequest(_) => (StatusCode::BAD_REQUEST, "bad_request"),
            Self::Unauthorized => (StatusCode::UNAUTHORIZED, "unauthorized"),
            Self::Forbidden => (StatusCode::FORBIDDEN, "forbidden"),
            Self::NotFound(_) => (StatusCode::NOT_FOUND, "not_found"),
            Self::Conflict(_) => (StatusCode::CONFLICT, "conflict"),
            Self::UpstreamUnavailable(_) => (StatusCode::BAD_GATEWAY, "upstream_unavailable"),
            Self::Database(e) => match e {
                // Surface unique-violation as a 409 rather than a 500: it is a
                // client-correctable condition (duplicate email, duplicate date).
                sqlx::Error::Database(db) if db.is_unique_violation() => {
                    (StatusCode::CONFLICT, "conflict")
                }
                sqlx::Error::Database(db) if db.is_foreign_key_violation() => {
                    (StatusCode::BAD_REQUEST, "bad_request")
                }
                sqlx::Error::RowNotFound => (StatusCode::NOT_FOUND, "not_found"),
                _ => (StatusCode::INTERNAL_SERVER_ERROR, "internal_error"),
            },
            Self::Internal(_) => (StatusCode::INTERNAL_SERVER_ERROR, "internal_error"),
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let (status, code) = self.parts();

        // Never leak database/internal detail to the client, but do log it.
        let message = if status == StatusCode::INTERNAL_SERVER_ERROR {
            tracing::error!(error = ?self, "request failed");
            "something went wrong".to_string()
        } else {
            match &self {
                ApiError::Database(sqlx::Error::Database(_)) => {
                    "that conflicts with an existing record".to_string()
                }
                other => other.to_string(),
            }
        };

        (
            status,
            Json(ErrorBody {
                error: code.to_string(),
                message,
            }),
        )
            .into_response()
    }
}

impl From<validator::ValidationErrors> for ApiError {
    fn from(e: validator::ValidationErrors) -> Self {
        let detail = e
            .field_errors()
            .iter()
            .map(|(field, errs)| {
                let reason = errs
                    .first()
                    .and_then(|v| v.message.clone())
                    .map(|m| m.to_string())
                    .unwrap_or_else(|| "is invalid".into());
                format!("{field} {reason}")
            })
            .collect::<Vec<_>>()
            .join("; ");
        ApiError::BadRequest(detail)
    }
}
