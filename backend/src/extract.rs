use axum::extract::rejection::JsonRejection;
use axum::extract::{FromRequest, Request};
use axum::response::{IntoResponse, Response};
use serde::de::DeserializeOwned;

use crate::error::ApiError;

/// A drop-in replacement for `axum::Json` that reports malformed bodies
/// through `ApiError`.
///
/// Axum's own `Json` extractor rejects a bad body with a plain-text 422 that
/// never passes through `ApiError`, so those responses had a different status
/// and a different shape from every other error the API returns — a client
/// parsing `{"error", "message"}` could not read them. Routing the rejection
/// through `ApiError` makes the contract "every error looks the same" actually
/// hold. It implements `IntoResponse` too, so it works in return position and
/// route modules import one `Json`.
pub struct Json<T>(pub T);

impl<T, S> FromRequest<S> for Json<T>
where
    T: DeserializeOwned,
    S: Send + Sync,
{
    type Rejection = ApiError;

    async fn from_request(req: Request, state: &S) -> Result<Self, Self::Rejection> {
        match axum::Json::<T>::from_request(req, state).await {
            Ok(axum::Json(value)) => Ok(Self(value)),
            Err(rejection) => Err(ApiError::BadRequest(describe(rejection))),
        }
    }
}

impl<T: serde::Serialize> IntoResponse for Json<T> {
    fn into_response(self) -> Response {
        axum::Json(self.0).into_response()
    }
}

/// Axum prefixes its messages with boilerplate about its own internals. The
/// useful part is what follows, so strip the prefix and keep the detail — which
/// serde makes genuinely helpful ("unknown variant `vitamin_q`, expected one
/// of …").
fn describe(rejection: JsonRejection) -> String {
    let text = rejection.body_text();
    for prefix in [
        "Failed to deserialize the JSON body into the target type: ",
        "Failed to parse the request body as JSON: ",
    ] {
        if let Some(rest) = text.strip_prefix(prefix) {
            return rest.to_string();
        }
    }
    text
}
