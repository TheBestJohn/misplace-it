//! USDA FoodData Central client.
//!
//! FDC reports nutrients per 100 g using stable numeric nutrient ids, which is
//! exactly the basis this app stores, so the mapping is a straight lookup.

use serde::Deserialize;

use crate::domain::food::ExternalFood;
use crate::error::ApiError;

// FoodData Central nutrient ids.
const N_ENERGY_KCAL: i64 = 1008;
const N_ENERGY_KJ: i64 = 1062;
const N_PROTEIN: i64 = 1003;
const N_CARBS: i64 = 1005;
const N_FAT: i64 = 1004;
const N_FIBER: i64 = 1079;
const N_SUGAR: i64 = 2000;
const N_SAT_FAT: i64 = 1258;
const N_SODIUM: i64 = 1093;

const KJ_PER_KCAL: f64 = 4.184;

#[derive(Clone)]
pub struct UsdaClient {
    http: reqwest::Client,
    base_url: String,
    api_key: Option<String>,
}

#[derive(Debug, Deserialize)]
struct SearchResponse {
    #[serde(default)]
    foods: Vec<SearchFood>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SearchFood {
    fdc_id: i64,
    description: String,
    #[serde(default)]
    brand_name: Option<String>,
    #[serde(default)]
    brand_owner: Option<String>,
    #[serde(default)]
    gtin_upc: Option<String>,
    #[serde(default)]
    serving_size: Option<f64>,
    #[serde(default)]
    serving_size_unit: Option<String>,
    #[serde(default)]
    household_serving_full_text: Option<String>,
    #[serde(default)]
    food_nutrients: Vec<SearchNutrient>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SearchNutrient {
    #[serde(default)]
    nutrient_id: Option<i64>,
    #[serde(default)]
    value: Option<f64>,
}

impl UsdaClient {
    pub fn new(http: reqwest::Client, base_url: String, api_key: Option<String>) -> Self {
        Self {
            http,
            base_url: base_url.trim_end_matches('/').to_string(),
            api_key,
        }
    }

    pub fn is_configured(&self) -> bool {
        self.api_key.is_some()
    }

    /// Free-text search. Returns `Ok(None)` when no API key is configured so the
    /// caller can degrade gracefully instead of failing the whole request.
    pub async fn search(&self, query: &str, limit: i64) -> Result<Option<Vec<ExternalFood>>, ApiError> {
        let Some(key) = &self.api_key else {
            return Ok(None);
        };

        let url = format!("{}/foods/search", self.base_url);
        let limit = limit.clamp(1, 50).to_string();

        let resp = self
            .http
            .get(&url)
            .query(&[
                ("api_key", key.as_str()),
                ("query", query),
                ("pageSize", limit.as_str()),
                ("dataType", "Foundation,SR Legacy,Branded"),
            ])
            .send()
            .await
            .map_err(|e| ApiError::UpstreamUnavailable(format!("USDA request failed: {e}")))?;

        if !resp.status().is_success() {
            return Err(ApiError::UpstreamUnavailable(format!(
                "USDA returned HTTP {}",
                resp.status()
            )));
        }

        let body: SearchResponse = resp
            .json()
            .await
            .map_err(|e| ApiError::UpstreamUnavailable(format!("USDA response unreadable: {e}")))?;

        Ok(Some(body.foods.into_iter().map(map_food).collect()))
    }

    /// Fetch a single food by its FDC id.
    pub async fn get(&self, fdc_id: &str) -> Result<Option<ExternalFood>, ApiError> {
        let Some(key) = &self.api_key else {
            return Ok(None);
        };

        let url = format!("{}/food/{}", self.base_url, fdc_id);
        let resp = self
            .http
            .get(&url)
            .query(&[("api_key", key.as_str())])
            .send()
            .await
            .map_err(|e| ApiError::UpstreamUnavailable(format!("USDA request failed: {e}")))?;

        if resp.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(None);
        }
        if !resp.status().is_success() {
            return Err(ApiError::UpstreamUnavailable(format!(
                "USDA returned HTTP {}",
                resp.status()
            )));
        }

        // The detail endpoint nests the nutrient id one level deeper than search
        // does, so normalise both shapes into the flat form before mapping.
        let raw: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| ApiError::UpstreamUnavailable(format!("USDA response unreadable: {e}")))?;

        Ok(Some(map_detail(&raw)))
    }
}

fn nutrient(nutrients: &[SearchNutrient], id: i64) -> Option<f64> {
    nutrients
        .iter()
        .find(|n| n.nutrient_id == Some(id))
        .and_then(|n| n.value)
}

fn energy_kcal(nutrients: &[SearchNutrient]) -> f64 {
    if let Some(kcal) = nutrient(nutrients, N_ENERGY_KCAL) {
        return kcal;
    }
    // Some Foundation foods only publish kilojoules.
    nutrient(nutrients, N_ENERGY_KJ)
        .map(|kj| kj / KJ_PER_KCAL)
        .unwrap_or(0.0)
}

/// USDA serving sizes come with a unit; only gram-like units can be trusted as
/// a gram weight, so anything else falls back to the 100 g default.
fn serving_grams(size: Option<f64>, unit: Option<&str>) -> f64 {
    match (size, unit.map(|u| u.to_ascii_lowercase())) {
        (Some(s), Some(u)) if s > 0.0 && (u == "g" || u == "gram" || u == "grm") => s,
        // millilitres: assume ~1 g/ml, which is right for water-like products
        (Some(s), Some(u)) if s > 0.0 && (u == "ml" || u == "mlt") => s,
        _ => 100.0,
    }
}

fn map_food(f: SearchFood) -> ExternalFood {
    let n = &f.food_nutrients;
    ExternalFood {
        source: "usda".into(),
        source_id: f.fdc_id.to_string(),
        name: f.description,
        brand: f.brand_name.or(f.brand_owner),
        upc: f.gtin_upc.filter(|u| !u.trim().is_empty()),
        calories_kcal: energy_kcal(n),
        protein_g: nutrient(n, N_PROTEIN).unwrap_or(0.0),
        carbs_g: nutrient(n, N_CARBS).unwrap_or(0.0),
        fat_g: nutrient(n, N_FAT).unwrap_or(0.0),
        fiber_g: nutrient(n, N_FIBER),
        sugar_g: nutrient(n, N_SUGAR),
        saturated_fat_g: nutrient(n, N_SAT_FAT),
        sodium_mg: nutrient(n, N_SODIUM),
        serving_size_g: serving_grams(f.serving_size, f.serving_size_unit.as_deref()),
        serving_label: f.household_serving_full_text,
    }
}

fn map_detail(raw: &serde_json::Value) -> ExternalFood {
    let nutrients: Vec<SearchNutrient> = raw
        .get("foodNutrients")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .map(|item| SearchNutrient {
                    // detail shape: { "nutrient": { "id": 1008 }, "amount": 52 }
                    nutrient_id: item
                        .get("nutrient")
                        .and_then(|n| n.get("id"))
                        .and_then(|v| v.as_i64())
                        .or_else(|| item.get("nutrientId").and_then(|v| v.as_i64())),
                    value: item
                        .get("amount")
                        .and_then(|v| v.as_f64())
                        .or_else(|| item.get("value").and_then(|v| v.as_f64())),
                })
                .collect()
        })
        .unwrap_or_default();

    let str_field = |key: &str| {
        raw.get(key)
            .and_then(|v| v.as_str())
            .map(str::to_string)
            .filter(|s| !s.trim().is_empty())
    };

    ExternalFood {
        source: "usda".into(),
        source_id: raw
            .get("fdcId")
            .and_then(|v| v.as_i64())
            .map(|v| v.to_string())
            .unwrap_or_default(),
        name: str_field("description").unwrap_or_else(|| "Unnamed food".into()),
        brand: str_field("brandName").or_else(|| str_field("brandOwner")),
        upc: str_field("gtinUpc"),
        calories_kcal: energy_kcal(&nutrients),
        protein_g: nutrient(&nutrients, N_PROTEIN).unwrap_or(0.0),
        carbs_g: nutrient(&nutrients, N_CARBS).unwrap_or(0.0),
        fat_g: nutrient(&nutrients, N_FAT).unwrap_or(0.0),
        fiber_g: nutrient(&nutrients, N_FIBER),
        sugar_g: nutrient(&nutrients, N_SUGAR),
        saturated_fat_g: nutrient(&nutrients, N_SAT_FAT),
        sodium_mg: nutrient(&nutrients, N_SODIUM),
        serving_size_g: serving_grams(
            raw.get("servingSize").and_then(|v| v.as_f64()),
            raw.get("servingSizeUnit").and_then(|v| v.as_str()),
        ),
        serving_label: str_field("householdServingFullText"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn energy_falls_back_to_kilojoules() {
        let n = vec![SearchNutrient {
            nutrient_id: Some(N_ENERGY_KJ),
            value: Some(418.4),
        }];
        assert!((energy_kcal(&n) - 100.0).abs() < 0.001);
    }

    #[test]
    fn non_gram_serving_units_fall_back_to_100g() {
        assert_eq!(serving_grams(Some(1.0), Some("cup")), 100.0);
        assert_eq!(serving_grams(Some(30.0), Some("g")), 30.0);
        assert_eq!(serving_grams(None, None), 100.0);
    }
}
