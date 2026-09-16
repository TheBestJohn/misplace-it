import { request } from './client'
import type {
  AuthResponse,
  BarcodeLookup,
  DiaryDay,
  DiaryEntry,
  DiarySummary,
  ExternalFood,
  ExternalSearchResponse,
  Food,
  FoodDetail,
  Health,
  Profile,
  Recipe,
  RecipeSummary,
  WeightEntry,
  WeightStats,
} from './types'

export interface RecipeItemInput {
  food_id: string
  quantity_g: number
  note?: string | null
}

export interface RecipeInput {
  name: string
  description?: string | null
  instructions?: string | null
  servings: number
  items: RecipeItemInput[]
}

export interface FoodInput {
  name: string
  brand?: string | null
  upc?: string | null
  calories_kcal: number
  protein_g: number
  carbs_g: number
  fat_g: number
  fiber_g?: number | null
  sugar_g?: number | null
  saturated_fat_g?: number | null
  sodium_mg?: number | null
  serving_size_g: number
  serving_label?: string | null
}

export const api = {
  health: () => request<Health>('/health'),

  register: (body: { email: string; password: string; display_name: string }) =>
    request<AuthResponse>('/auth/register', { method: 'POST', body }),
  login: (body: { email: string; password: string }) =>
    request<AuthResponse>('/auth/login', { method: 'POST', body }),
  me: () => request<Profile>('/auth/me'),

  getProfile: () => request<Profile>('/profile'),
  updateProfile: (body: Partial<Profile>) =>
    request<Profile>('/profile', { method: 'PATCH', body }),

  listWeights: (query: { from?: string; to?: string; limit?: number } = {}) =>
    request<WeightEntry[]>('/weights', { query }),
  weightStats: (query: { from?: string; to?: string } = {}) =>
    request<WeightStats>('/weights/stats', { query }),
  logWeight: (body: {
    recorded_on?: string
    weight_kg: number
    body_fat_pct?: number | null
    note?: string | null
  }) => request<WeightEntry>('/weights', { method: 'POST', body }),
  deleteWeight: (id: string) => request<void>(`/weights/${id}`, { method: 'DELETE' }),

  listFoods: (query: { q?: string; source?: string; mine?: boolean; limit?: number } = {}) =>
    request<Food[]>('/foods', { query }),
  getFood: (id: string) => request<FoodDetail>(`/foods/${id}`),
  createFood: (body: FoodInput) => request<FoodDetail>('/foods', { method: 'POST', body }),
  updateFood: (id: string, body: FoodInput) =>
    request<FoodDetail>(`/foods/${id}`, { method: 'PUT', body }),
  deleteFood: (id: string) => request<void>(`/foods/${id}`, { method: 'DELETE' }),
  searchExternal: (q: string, limit = 15) =>
    request<ExternalSearchResponse>('/foods/search/external', { query: { q, limit } }),
  lookupBarcode: (upc: string) => request<BarcodeLookup>(`/foods/barcode/${upc}`),
  importFood: (body: ExternalFood) =>
    request<FoodDetail>('/foods/import', { method: 'POST', body }),

  listRecipes: (query: { q?: string } = {}) => request<RecipeSummary[]>('/recipes', { query }),
  getRecipe: (id: string) => request<Recipe>(`/recipes/${id}`),
  createRecipe: (body: RecipeInput) => request<Recipe>('/recipes', { method: 'POST', body }),
  updateRecipe: (id: string, body: RecipeInput) =>
    request<Recipe>(`/recipes/${id}`, { method: 'PUT', body }),
  deleteRecipe: (id: string) => request<void>(`/recipes/${id}`, { method: 'DELETE' }),

  diaryDay: (date: string) => request<DiaryDay>('/diary/day', { query: { date } }),
  diarySummary: (from: string, to: string) =>
    request<DiarySummary>('/diary/summary', { query: { from, to } }),
  logDiaryEntry: (body: {
    logged_on?: string
    meal?: string
    food_id?: string
    recipe_id?: string
    quantity_g?: number
    recipe_servings?: number
  }) => request<DiaryEntry>('/diary', { method: 'POST', body }),
  updateDiaryEntry: (
    id: string,
    body: { quantity_g?: number; recipe_servings?: number; meal?: string; logged_on?: string },
  ) => request<DiaryEntry>(`/diary/${id}`, { method: 'PATCH', body }),
  deleteDiaryEntry: (id: string) => request<void>(`/diary/${id}`, { method: 'DELETE' }),
}
