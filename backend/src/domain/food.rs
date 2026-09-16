use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use utoipa::ToSchema;
use uuid::Uuid;
use validator::Validate;

use super::nutrients::Nutrients;

/// A food as stored: all nutrient figures are **per 100 g**.
#[derive(Debug, Clone, Serialize, FromRow, ToSchema)]
pub struct Food {
    pub id: Uuid,
    /// `custom`, `usda` or `off` (Open Food Facts).
    pub source: String,
    pub source_id: Option<String>,
    pub name: String,
    pub brand: Option<String>,
    pub upc: Option<String>,
    pub calories_kcal: f64,
    pub protein_g: f64,
    pub carbs_g: f64,
    pub fat_g: f64,
    pub fiber_g: Option<f64>,
    pub sugar_g: Option<f64>,
    pub saturated_fat_g: Option<f64>,
    pub sodium_mg: Option<f64>,
    pub serving_size_g: f64,
    pub serving_label: Option<String>,
    pub created_by: Option<Uuid>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

impl Food {
    /// Per-100g profile with unknown nutrients flattened to 0 for arithmetic.
    pub fn per_100g(&self) -> Nutrients {
        Nutrients {
            calories_kcal: self.calories_kcal,
            protein_g: self.protein_g,
            carbs_g: self.carbs_g,
            fat_g: self.fat_g,
            fiber_g: self.fiber_g.unwrap_or(0.0),
            sugar_g: self.sugar_g.unwrap_or(0.0),
            saturated_fat_g: self.saturated_fat_g.unwrap_or(0.0),
            sodium_mg: self.sodium_mg.unwrap_or(0.0),
        }
    }

    /// Nutrients for an arbitrary gram amount of this food.
    pub fn nutrients_for_grams(&self, grams: f64) -> Nutrients {
        self.per_100g().scaled(grams / 100.0)
    }
}

#[derive(Debug, Serialize, ToSchema)]
pub struct FoodDetail {
    #[serde(flatten)]
    pub food: Food,
    /// Convenience: the same numbers for one serving of `serving_size_g`.
    pub per_serving: Nutrients,
}

impl From<Food> for FoodDetail {
    fn from(food: Food) -> Self {
        let per_serving = food.nutrients_for_grams(food.serving_size_g).rounded();
        Self { food, per_serving }
    }
}

fn default_serving() -> f64 {
    100.0
}

#[derive(Debug, Deserialize, Validate, ToSchema)]
pub struct UpsertFoodRequest {
    #[validate(length(min = 1, max = 200, message = "must be 1-200 characters"))]
    pub name: String,
    #[validate(length(max = 200, message = "must be at most 200 characters"))]
    pub brand: Option<String>,
    #[validate(length(min = 6, max = 20, message = "must be 6-20 digits"))]
    pub upc: Option<String>,
    #[validate(range(min = 0.0, max = 10000.0, message = "is out of range"))]
    pub calories_kcal: f64,
    #[validate(range(min = 0.0, max = 100.0, message = "is out of range for a per-100g value"))]
    pub protein_g: f64,
    #[validate(range(min = 0.0, max = 100.0, message = "is out of range for a per-100g value"))]
    pub carbs_g: f64,
    #[validate(range(min = 0.0, max = 100.0, message = "is out of range for a per-100g value"))]
    pub fat_g: f64,
    pub fiber_g: Option<f64>,
    pub sugar_g: Option<f64>,
    pub saturated_fat_g: Option<f64>,
    pub sodium_mg: Option<f64>,
    #[serde(default = "default_serving")]
    #[validate(range(min = 0.1, max = 5000.0, message = "must be between 0.1 and 5000 g"))]
    pub serving_size_g: f64,
    #[validate(length(max = 100, message = "must be at most 100 characters"))]
    pub serving_label: Option<String>,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct FoodSearchQuery {
    /// Free-text search over name and brand.
    pub q: Option<String>,
    /// Restrict to a source: `custom`, `usda`, `off`.
    pub source: Option<String>,
    /// Only foods this user created.
    #[serde(default)]
    pub mine: bool,
    #[serde(default = "default_limit")]
    pub limit: i64,
    #[serde(default)]
    pub offset: i64,
}

fn default_limit() -> i64 {
    25
}

/// A hit from an external provider that has not been imported yet. It carries
/// everything needed to import it, so the client can POST it straight back.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct ExternalFood {
    pub source: String,
    pub source_id: String,
    pub name: String,
    pub brand: Option<String>,
    pub upc: Option<String>,
    pub calories_kcal: f64,
    pub protein_g: f64,
    pub carbs_g: f64,
    pub fat_g: f64,
    pub fiber_g: Option<f64>,
    pub sugar_g: Option<f64>,
    pub saturated_fat_g: Option<f64>,
    pub sodium_mg: Option<f64>,
    pub serving_size_g: f64,
    pub serving_label: Option<String>,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct ExternalSearchQuery {
    pub q: String,
    #[serde(default = "default_limit")]
    pub limit: i64,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct ExternalSearchResponse {
    pub results: Vec<ExternalFood>,
    /// Providers that were skipped, with the reason (e.g. no USDA API key).
    pub unavailable: Vec<String>,
}

/// Result of a barcode lookup: either an already-imported local food or a
/// candidate from Open Food Facts the user can choose to import.
#[derive(Debug, Serialize, ToSchema)]
pub struct BarcodeLookup {
    pub upc: String,
    pub local: Option<FoodDetail>,
    pub external: Option<ExternalFood>,
}
