export interface Nutrients {
  calories_kcal: number
  protein_g: number
  carbs_g: number
  fat_g: number
  fiber_g: number
  sugar_g: number
  saturated_fat_g: number
  sodium_mg: number
}

export interface Profile {
  id: string
  email: string
  display_name: string
  sex: string | null
  birth_date: string | null
  height_cm: number | null
  activity_level: string
  goal: string
  target_weight_kg: number | null
  created_at: string
}

/** Nutrients a target can be set on. Mirrors the server's vocabulary. */
export type Nutrient =
  | 'calories_kcal'
  | 'protein_g'
  | 'carbs_g'
  | 'fat_g'
  | 'fiber_g'
  | 'sugar_g'
  | 'saturated_fat_g'
  | 'sodium_mg'

/**
 * Which way a target points.
 * - `goal`   — a floor. Hit at least this. Exceeding it is fine.
 * - `budget` — a ceiling. Stay under this. Exceeding it is over-budget.
 */
export type TargetKind = 'goal' | 'budget'

export interface NutritionTarget {
  nutrient: Nutrient
  amount: number
  kind: TargetKind
  label: string
  unit: string
}

export interface TargetProgress {
  nutrient: Nutrient
  label: string
  unit: string
  kind: TargetKind
  amount: number
  consumed: number
  /** Always `amount - consumed`, signed: negative means past the number. */
  remaining: number
  percent: number
  /** `under` | `over` for a budget, `short` | `met` for a goal. */
  status: 'under' | 'over' | 'short' | 'met'
}

export interface AuthResponse {
  access_token: string
  token_type: string
  expires_in: number
  user: Profile
}

export interface WeightEntry {
  id: string
  recorded_on: string
  weight_kg: number
  body_fat_pct: number | null
  note: string | null
  created_at: string
  updated_at: string
}

export interface WeightStats {
  count: number
  latest_kg: number | null
  earliest_kg: number | null
  change_kg: number | null
  min_kg: number | null
  max_kg: number | null
  moving_average_7_kg: number | null
}

export interface Food {
  id: string
  source: 'custom' | 'usda' | 'off' | string
  source_id: string | null
  name: string
  brand: string | null
  upc: string | null
  calories_kcal: number
  protein_g: number
  carbs_g: number
  fat_g: number
  fiber_g: number | null
  sugar_g: number | null
  saturated_fat_g: number | null
  sodium_mg: number | null
  serving_size_g: number
  serving_label: string | null
  created_by: string | null
  created_at: string
  updated_at: string
}

/** `GET /foods/{id}` flattens the food and adds a computed per-serving block. */
export type FoodDetail = Food & { per_serving: Nutrients }

export interface ExternalFood {
  source: string
  source_id: string
  name: string
  brand: string | null
  upc: string | null
  calories_kcal: number
  protein_g: number
  carbs_g: number
  fat_g: number
  fiber_g: number | null
  sugar_g: number | null
  saturated_fat_g: number | null
  sodium_mg: number | null
  serving_size_g: number
  serving_label: string | null
}

export interface ExternalSearchResponse {
  results: ExternalFood[]
  unavailable: string[]
}

export interface BarcodeLookup {
  upc: string
  local: FoodDetail | null
  external: ExternalFood | null
}

export interface RecipeItem {
  id: string
  food_id: string
  food_name: string
  food_brand: string | null
  quantity_g: number
  note: string | null
  sort_order: number
  nutrients: Nutrients
}

export interface RecipeSummary {
  id: string
  name: string
  description: string | null
  servings: number
  total_weight_g: number
  item_count: number
  per_serving: Nutrients
  created_at: string
  updated_at: string
}

export interface Recipe {
  id: string
  name: string
  description: string | null
  instructions: string | null
  servings: number
  total_weight_g: number
  items: RecipeItem[]
  total: Nutrients
  per_serving: Nutrients
  created_at: string
  updated_at: string
}

export interface DiaryEntry {
  id: string
  logged_on: string
  meal: string
  food_id: string | null
  recipe_id: string | null
  name: string
  brand: string | null
  quantity_g: number | null
  recipe_servings: number | null
  nutrients: Nutrients
  created_at: string
  updated_at: string
}

export interface MealGroup {
  meal: string
  entries: DiaryEntry[]
  total: Nutrients
}

export interface DiaryDay {
  date: string
  meals: MealGroup[]
  total: Nutrients
  /** Progress against each target that is set, in display order. */
  targets: TargetProgress[]
}

export interface DailyTotal {
  date: string
  total: Nutrients
  entry_count: number
}

export interface DiarySummary {
  from: string
  to: string
  days: DailyTotal[]
  average: Nutrients
  logged_day_count: number
}

export interface Health {
  status: string
  version: string
  database: string
  usda_configured: boolean
}
