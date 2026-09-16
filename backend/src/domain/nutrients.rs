use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

/// A computed nutrient total (a serving, a recipe, a day).
///
/// Foods store nutrients per 100 g with optional fields for values the source
/// did not publish. Totals flatten those unknowns to 0 so that summing is
/// always well-defined — a missing fibre figure must not poison a day's total.
#[derive(Debug, Default, Clone, Copy, Serialize, Deserialize, ToSchema)]
pub struct Nutrients {
    pub calories_kcal: f64,
    pub protein_g: f64,
    pub carbs_g: f64,
    pub fat_g: f64,
    pub fiber_g: f64,
    pub sugar_g: f64,
    pub saturated_fat_g: f64,
    pub sodium_mg: f64,
}

impl Nutrients {
    /// Scale a per-100g profile to an arbitrary gram amount.
    pub fn scaled(&self, factor: f64) -> Self {
        Self {
            calories_kcal: self.calories_kcal * factor,
            protein_g: self.protein_g * factor,
            carbs_g: self.carbs_g * factor,
            fat_g: self.fat_g * factor,
            fiber_g: self.fiber_g * factor,
            sugar_g: self.sugar_g * factor,
            saturated_fat_g: self.saturated_fat_g * factor,
            sodium_mg: self.sodium_mg * factor,
        }
    }

    pub fn rounded(&self) -> Self {
        fn r(v: f64) -> f64 {
            (v * 100.0).round() / 100.0
        }
        Self {
            calories_kcal: r(self.calories_kcal),
            protein_g: r(self.protein_g),
            carbs_g: r(self.carbs_g),
            fat_g: r(self.fat_g),
            fiber_g: r(self.fiber_g),
            sugar_g: r(self.sugar_g),
            saturated_fat_g: r(self.saturated_fat_g),
            sodium_mg: r(self.sodium_mg),
        }
    }
}

impl std::ops::Add for Nutrients {
    type Output = Self;
    fn add(self, rhs: Self) -> Self {
        Self {
            calories_kcal: self.calories_kcal + rhs.calories_kcal,
            protein_g: self.protein_g + rhs.protein_g,
            carbs_g: self.carbs_g + rhs.carbs_g,
            fat_g: self.fat_g + rhs.fat_g,
            fiber_g: self.fiber_g + rhs.fiber_g,
            sugar_g: self.sugar_g + rhs.sugar_g,
            saturated_fat_g: self.saturated_fat_g + rhs.saturated_fat_g,
            sodium_mg: self.sodium_mg + rhs.sodium_mg,
        }
    }
}

impl std::iter::Sum for Nutrients {
    fn sum<I: Iterator<Item = Self>>(iter: I) -> Self {
        iter.fold(Self::default(), |acc, n| acc + n)
    }
}
