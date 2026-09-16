use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use utoipa::ToSchema;
use uuid::Uuid;
use validator::Validate;

use super::nutrients::Nutrients;

#[derive(Debug, FromRow)]
pub struct RecipeRow {
    pub id: Uuid,
    pub name: String,
    pub description: Option<String>,
    pub instructions: Option<String>,
    pub servings: f64,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, FromRow)]
pub struct RecipeItemRow {
    pub id: Uuid,
    pub food_id: Uuid,
    pub quantity_g: f64,
    pub note: Option<String>,
    pub sort_order: i32,
    // joined from foods
    pub food_name: String,
    pub food_brand: Option<String>,
    pub calories_kcal: f64,
    pub protein_g: f64,
    pub carbs_g: f64,
    pub fat_g: f64,
    pub fiber_g: Option<f64>,
    pub sugar_g: Option<f64>,
    pub saturated_fat_g: Option<f64>,
    pub sodium_mg: Option<f64>,
}

impl RecipeItemRow {
    pub fn nutrients(&self) -> Nutrients {
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
        .scaled(self.quantity_g / 100.0)
    }
}

#[derive(Debug, Serialize, ToSchema)]
pub struct RecipeItem {
    pub id: Uuid,
    pub food_id: Uuid,
    pub food_name: String,
    pub food_brand: Option<String>,
    pub quantity_g: f64,
    pub note: Option<String>,
    pub sort_order: i32,
    pub nutrients: Nutrients,
}

/// A recipe summary (list view) — no ingredient rows, but macros included so
/// the list can be sorted/filtered without an N+1 round trip.
#[derive(Debug, Serialize, ToSchema)]
pub struct RecipeSummary {
    pub id: Uuid,
    pub name: String,
    pub description: Option<String>,
    pub servings: f64,
    pub total_weight_g: f64,
    pub item_count: i64,
    pub per_serving: Nutrients,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct Recipe {
    pub id: Uuid,
    pub name: String,
    pub description: Option<String>,
    pub instructions: Option<String>,
    pub servings: f64,
    pub total_weight_g: f64,
    pub items: Vec<RecipeItem>,
    pub total: Nutrients,
    pub per_serving: Nutrients,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Serialize, Deserialize, Validate, ToSchema)]
pub struct RecipeItemInput {
    pub food_id: Uuid,
    #[validate(range(
        min = 0.1,
        max = 100000.0,
        message = "must be between 0.1 and 100000 g"
    ))]
    pub quantity_g: f64,
    #[validate(length(max = 200, message = "must be at most 200 characters"))]
    pub note: Option<String>,
}

#[derive(Debug, Deserialize, Validate, ToSchema)]
pub struct UpsertRecipeRequest {
    #[validate(length(min = 1, max = 200, message = "must be 1-200 characters"))]
    pub name: String,
    #[validate(length(max = 2000, message = "must be at most 2000 characters"))]
    pub description: Option<String>,
    #[validate(length(max = 20000, message = "must be at most 20000 characters"))]
    pub instructions: Option<String>,
    #[validate(range(min = 0.1, max = 1000.0, message = "must be between 0.1 and 1000"))]
    pub servings: f64,
    #[validate(nested)]
    #[validate(length(min = 1, message = "must contain at least one ingredient"))]
    pub items: Vec<RecipeItemInput>,
}
