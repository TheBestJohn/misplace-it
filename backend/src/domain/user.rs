use chrono::{DateTime, NaiveDate, Utc};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use utoipa::ToSchema;
use uuid::Uuid;
use validator::Validate;

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
    pub daily_calorie_target: Option<f64>,
    pub daily_protein_target_g: Option<f64>,
    pub daily_carbs_target_g: Option<f64>,
    pub daily_fat_target_g: Option<f64>,
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
    pub daily_calorie_target: Option<f64>,
    pub daily_protein_target_g: Option<f64>,
    pub daily_carbs_target_g: Option<f64>,
    pub daily_fat_target_g: Option<f64>,
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
            daily_calorie_target: u.daily_calorie_target,
            daily_protein_target_g: u.daily_protein_target_g,
            daily_carbs_target_g: u.daily_carbs_target_g,
            daily_fat_target_g: u.daily_fat_target_g,
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
    #[validate(range(min = 0.0, max = 20000.0, message = "is out of range"))]
    pub daily_calorie_target: Option<f64>,
    #[validate(range(min = 0.0, max = 2000.0, message = "is out of range"))]
    pub daily_protein_target_g: Option<f64>,
    #[validate(range(min = 0.0, max = 2000.0, message = "is out of range"))]
    pub daily_carbs_target_g: Option<f64>,
    #[validate(range(min = 0.0, max = 2000.0, message = "is out of range"))]
    pub daily_fat_target_g: Option<f64>,
}
