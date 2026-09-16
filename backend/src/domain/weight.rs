use chrono::{DateTime, NaiveDate, Utc};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use utoipa::ToSchema;
use uuid::Uuid;
use validator::Validate;

#[derive(Debug, Serialize, FromRow, ToSchema)]
pub struct WeightEntry {
    pub id: Uuid,
    pub recorded_on: NaiveDate,
    pub weight_kg: f64,
    pub body_fat_pct: Option<f64>,
    pub note: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Deserialize, Validate, ToSchema)]
pub struct UpsertWeightRequest {
    /// Defaults to today when omitted.
    pub recorded_on: Option<NaiveDate>,
    #[validate(range(min = 1.0, max = 699.0, message = "must be between 1 and 699 kg"))]
    pub weight_kg: f64,
    #[validate(range(min = 0.0, max = 100.0, message = "must be between 0 and 100"))]
    pub body_fat_pct: Option<f64>,
    #[validate(length(max = 500, message = "must be at most 500 characters"))]
    pub note: Option<String>,
}

#[derive(Debug, Default, Deserialize, Validate, ToSchema)]
#[serde(default)]
pub struct PatchWeightRequest {
    #[validate(range(min = 1.0, max = 699.0, message = "must be between 1 and 699 kg"))]
    pub weight_kg: Option<f64>,
    #[validate(range(min = 0.0, max = 100.0, message = "must be between 0 and 100"))]
    pub body_fat_pct: Option<f64>,
    #[validate(length(max = 500, message = "must be at most 500 characters"))]
    pub note: Option<String>,
}

/// Trend statistics over the queried window, computed server-side so every
/// client (web, future mobile) shows the same numbers.
#[derive(Debug, Serialize, ToSchema)]
pub struct WeightStats {
    pub count: i64,
    pub latest_kg: Option<f64>,
    pub earliest_kg: Option<f64>,
    pub change_kg: Option<f64>,
    pub min_kg: Option<f64>,
    pub max_kg: Option<f64>,
    /// 7-entry moving average of the most recent entries.
    pub moving_average_7_kg: Option<f64>,
}
