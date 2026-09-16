use chrono::{DateTime, NaiveDate, Utc};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use utoipa::ToSchema;
use uuid::Uuid;
use validator::Validate;

/// Every column `UserRow` reads. Shared for the same reason as `FOOD_COLUMNS`.
pub const USER_COLUMNS: &str = r#"
    id, email, password_hash, display_name, sex, birth_date, height_cm,
    activity_level, goal, target_weight_kg, is_admin, disabled_at, created_at
"#;

#[derive(Debug, FromRow)]
pub struct UserRow {
    pub id: Uuid,
    pub email: String,
    pub password_hash: String,
    pub display_name: String,
    pub sex: Option<String>,
    pub birth_date: Option<NaiveDate>,
    pub height_cm: Option<f64>,
    pub activity_level: String,
    pub goal: String,
    pub target_weight_kg: Option<f64>,
    pub is_admin: bool,
    pub disabled_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct Profile {
    pub id: Uuid,
    pub email: String,
    pub display_name: String,
    pub sex: Option<String>,
    pub birth_date: Option<NaiveDate>,
    pub height_cm: Option<f64>,
    pub activity_level: String,
    pub goal: String,
    pub target_weight_kg: Option<f64>,
    /// Drives the admin area in the UI. The server never trusts it — every
    /// admin route re-checks the flag — but the client needs it to know
    /// whether to render the link at all.
    pub is_admin: bool,
    pub created_at: DateTime<Utc>,
}

impl From<UserRow> for Profile {
    fn from(u: UserRow) -> Self {
        Self {
            id: u.id,
            email: u.email,
            display_name: u.display_name,
            sex: u.sex,
            birth_date: u.birth_date,
            height_cm: u.height_cm,
            activity_level: u.activity_level,
            goal: u.goal,
            target_weight_kg: u.target_weight_kg,
            is_admin: u.is_admin,
            created_at: u.created_at,
        }
    }
}

#[derive(Debug, Deserialize, Validate, ToSchema)]
pub struct RegisterRequest {
    #[validate(email(message = "must be a valid email address"))]
    pub email: String,
    #[validate(length(min = 10, message = "must be at least 10 characters"))]
    pub password: String,
    #[validate(length(min = 1, max = 100, message = "must be 1-100 characters"))]
    pub display_name: String,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct LoginRequest {
    pub email: String,
    pub password: String,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct AuthResponse {
    pub access_token: String,
    pub token_type: &'static str,
    pub expires_in: i64,
    pub user: Profile,
}

#[derive(Debug, Default, Deserialize, Validate, ToSchema)]
#[serde(default)]
pub struct UpdateProfileRequest {
    #[validate(length(min = 1, max = 100, message = "must be 1-100 characters"))]
    pub display_name: Option<String>,
    pub sex: Option<String>,
    pub birth_date: Option<NaiveDate>,
    #[validate(range(min = 50.0, max = 280.0, message = "must be between 50 and 280 cm"))]
    pub height_cm: Option<f64>,
    pub activity_level: Option<String>,
    pub goal: Option<String>,
    #[validate(range(min = 20.0, max = 500.0, message = "must be between 20 and 500 kg"))]
    pub target_weight_kg: Option<f64>,
}
