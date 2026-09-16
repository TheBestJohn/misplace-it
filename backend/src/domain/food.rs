use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use utoipa::ToSchema;
use uuid::Uuid;
use validator::Validate;

use super::nutrients::Nutrients;

/// Every column `Food` reads, in one place.
///
/// This list had been copied into three route modules, and adding the
/// provenance columns broke two of them at runtime — `query_as` is checked
/// against the database, not the compiler, so a stale list is a 500 rather
/// than a build error. Defining it beside the struct means the next column
/// only has to be added once.
pub const FOOD_COLUMNS: &str = r#"
    id, source, source_id, name, brand, upc, calories_kcal, protein_g, carbs_g, fat_g,
    fiber_g, sugar_g, saturated_fat_g, sodium_mg, serving_size_g, serving_label,
    variant_of, variant_label, revision, verified_at,
    created_by, created_at, updated_at
"#;

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
    /// Set when this food is a preparation variant of another food, e.g. the
    /// cooked form of a raw ingredient.
    pub variant_of: Option<Uuid>,
    /// What distinguishes this variant from its parent: `cooked`, `raw`,
    /// `drained`. Always present exactly when `variant_of` is.
    pub variant_label: Option<String>,
    /// Bumped by the database on every substantive edit. Verification is
    /// scoped to this number, so an edit resets community agreement.
    pub revision: i32,
    /// When the current revision reached quorum. Cleared by any edit.
    pub verified_at: Option<DateTime<Utc>>,
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
    /// Who has touched this entry and how much the community trusts it.
    pub provenance: FoodProvenance,
    /// Preparation variants of this food. Empty when this row is itself a
    /// variant, since variants are deliberately one level deep.
    #[serde(default)]
    pub variants: Vec<Food>,
    /// The food this one is a variant of, when it is one.
    pub parent: Option<Food>,
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
    #[validate(range(
        min = 0.0,
        max = 100.0,
        message = "is out of range for a per-100g value"
    ))]
    pub protein_g: f64,
    #[validate(range(
        min = 0.0,
        max = 100.0,
        message = "is out of range for a per-100g value"
    ))]
    pub carbs_g: f64,
    #[validate(range(
        min = 0.0,
        max = 100.0,
        message = "is out of range for a per-100g value"
    ))]
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
    /// Make this food a preparation variant of another food.
    pub variant_of: Option<Uuid>,
    /// Required with `variant_of`, rejected without it.
    #[validate(length(min = 1, max = 60, message = "must be 1-60 characters"))]
    pub variant_label: Option<String>,
    /// Free-text note stored on the revision this write creates — the edit
    /// summary line of a wiki, not a field on the food itself.
    #[validate(length(max = 300, message = "must be at most 300 characters"))]
    pub edit_summary: Option<String>,
}

impl UpsertFoodRequest {
    /// `variant_of` and `variant_label` are meaningless apart: the database
    /// enforces the pairing too, but catching it here yields a field-level
    /// validation error instead of a constraint name.
    pub fn check_variant(&self) -> Result<(), &'static str> {
        match (
            self.variant_of,
            self.variant_label.as_deref().map(str::trim),
        ) {
            (Some(_), None) | (Some(_), Some("")) => {
                Err("variant_label is required when variant_of is set")
            }
            (None, Some(l)) if !l.is_empty() => {
                Err("variant_of is required when variant_label is set")
            }
            _ => Ok(()),
        }
    }
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

// ---------------------------------------------------------------------------
// Provenance: history, contributors and community verification
// ---------------------------------------------------------------------------

/// A vote on a specific revision of a food.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum Verdict {
    /// "I checked this against the label or the source and it is right."
    Confirm,
    /// "These numbers are wrong."
    Dispute,
}

impl Verdict {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Confirm => "confirm",
            Self::Dispute => "dispute",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "confirm" => Some(Self::Confirm),
            "dispute" => Some(Self::Dispute),
            _ => None,
        }
    }
}

/// How much the community trusts the food's *current* revision.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum VerificationStatus {
    /// Nobody has weighed in yet, or not enough people have.
    #[default]
    Unverified,
    /// Net confirmations reached the quorum.
    Verified,
    /// At least one person says the numbers are wrong, and nobody has
    /// out-confirmed them. Surfaced loudly: a disputed food is worse than an
    /// unverified one, because someone has actively looked and objected.
    Disputed,
}

impl VerificationStatus {
    /// Disputes are subtracted rather than merely counted so that a single
    /// objection cannot be buried by a couple of casual confirmations: the
    /// quorum has to be cleared *net* of everyone who disagrees.
    pub fn evaluate(confirmations: i64, disputes: i64, quorum: i64) -> Self {
        if disputes > 0 && confirmations <= disputes {
            Self::Disputed
        } else if confirmations - disputes >= quorum {
            Self::Verified
        } else {
            Self::Unverified
        }
    }
}

/// The editorial state of a food: one revision's worth of trust, plus who put
/// the current numbers there.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct FoodProvenance {
    pub revision: i32,
    pub status: VerificationStatus,
    pub confirmations: i64,
    pub disputes: i64,
    /// Net confirmations needed for `verified`, so a client can render
    /// "1 of 2" without hard-coding the server's policy.
    pub quorum: i64,
    pub verified_at: Option<DateTime<Utc>>,
    /// Number of distinct people who have ever edited this food.
    pub contributors: i64,
    pub last_change_kind: String,
    pub last_edited_at: DateTime<Utc>,
    pub last_edited_by: Option<Uuid>,
    pub last_edited_by_name: Option<String>,
    pub last_edit_summary: Option<String>,
    /// Your own vote on the current revision, if you cast one.
    pub your_verdict: Option<Verdict>,
    /// False when you wrote the current revision: endorsing your own edit
    /// would make the quorum a formality.
    pub can_verify: bool,
}

/// One historical state of a food. `snapshot` is the full set of editable
/// fields as they stood, so a revision can be rendered or restored without
/// replaying anything.
#[derive(Debug, Clone, Serialize, FromRow, ToSchema)]
pub struct FoodRevision {
    pub id: Uuid,
    pub food_id: Uuid,
    pub revision: i32,
    /// `create`, `edit`, `import`, `revert` or `seed`.
    pub change_kind: String,
    pub edited_by: Option<Uuid>,
    pub edited_by_name: Option<String>,
    pub summary: Option<String>,
    #[schema(value_type = Object)]
    pub snapshot: serde_json::Value,
    pub created_at: DateTime<Utc>,
    /// Field names whose value differs from the revision before this one.
    /// Computed on read so the client can highlight a diff without fetching
    /// two revisions and comparing them itself.
    #[sqlx(skip)]
    #[serde(default)]
    pub changed_fields: Vec<String>,
}

/// One person's vote, for the "who agreed" list on a food.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct FoodVerification {
    pub user_id: Uuid,
    pub display_name: String,
    pub revision: i32,
    pub verdict: Verdict,
    pub note: Option<String>,
    pub created_at: DateTime<Utc>,
    /// True when this vote is on the food's current revision. Older votes are
    /// kept and shown, but they no longer count toward the quorum.
    pub current: bool,
}

#[derive(Debug, Deserialize, Validate, ToSchema)]
pub struct VerifyRequest {
    pub verdict: Verdict,
    /// Why — especially useful on a dispute, where the next editor needs to
    /// know what to fix.
    #[validate(length(max = 300, message = "must be at most 300 characters"))]
    pub note: Option<String>,
}

#[derive(Debug, Deserialize, Validate, ToSchema)]
pub struct RevertRequest {
    /// The revision number to restore. Restoring does not delete history: it
    /// appends a new revision whose content equals the old one, so the bad
    /// edit stays on the record.
    #[validate(range(min = 1, message = "must be a positive revision number"))]
    pub revision: i32,
    #[validate(length(max = 300, message = "must be at most 300 characters"))]
    pub reason: Option<String>,
}

/// One food in the portable export format. Deliberately not `Food`: internal
/// ids and per-user bookkeeping have no meaning in another deployment, so the
/// export is keyed by natural identity (source + source id, or name + brand)
/// and carries only the facts about the food itself.
#[derive(Debug, Clone, Serialize, Deserialize, FromRow, ToSchema)]
pub struct FoodExport {
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
    /// The parent's export key, when this row is a variant. Resolved by name
    /// on import, since ids do not travel.
    pub variant_of_key: Option<String>,
    pub variant_label: Option<String>,
    pub revision: i32,
    pub confirmations: i64,
    pub disputes: i64,
    /// Derived from the counts above and the instance's quorum, so a consumer
    /// need not know what that quorum was.
    #[sqlx(skip)]
    #[serde(default)]
    pub status: VerificationStatus,
}

/// The whole dataset, shaped to be committed to a git repository: a stable
/// top-level object with a version field, so a future format change is
/// detectable rather than silently mis-parsed.
#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct FoodExportBundle {
    /// Format version of this document, not of the application.
    pub format: u32,
    pub generated_at: DateTime<Utc>,
    pub count: usize,
    pub foods: Vec<FoodExport>,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct ExportQuery {
    /// Export only foods whose current revision reached quorum — the setting
    /// you want when feeding a curated public dataset.
    #[serde(default)]
    pub verified_only: bool,
}
