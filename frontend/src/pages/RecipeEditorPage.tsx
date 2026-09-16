import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { api } from '../api/endpoints'
import type { RecipeInput } from '../api/endpoints'
import type { Food, Nutrients } from '../api/types'
import { grams, kcal, round } from '../lib/format'
import FoodPicker from '../components/FoodPicker'
import { Card, ErrorNote, MacroRow, Modal, Spinner } from '../components/ui'

/** An ingredient being edited, carrying the per-100g figures for live totals. */
interface DraftItem {
  key: string
  food_id: string
  name: string
  brand: string | null
  quantity_g: number
  per100: Pick<Food, 'calories_kcal' | 'protein_g' | 'carbs_g' | 'fat_g'>
}

export default function RecipeEditorPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const isNew = !id

  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [instructions, setInstructions] = useState('')
  const [servings, setServings] = useState('1')
  const [items, setItems] = useState<DraftItem[]>([])
  const [picking, setPicking] = useState(false)

  const existing = useQuery({
    queryKey: ['recipes', id],
    queryFn: () => api.getRecipe(id!),
    enabled: !isNew,
  })

  // Hydrate the form once the recipe arrives. The saved recipe stores only the
  // food id and gram amount, so re-fetch each food's per-100g figures to keep
  // the live totals below accurate while editing.
  useEffect(() => {
    const recipe = existing.data
    if (!recipe) return

    setName(recipe.name)
    setDescription(recipe.description ?? '')
    setInstructions(recipe.instructions ?? '')
    setServings(String(recipe.servings))
    setItems(
      recipe.items.map((item) => ({
        key: item.id,
        food_id: item.food_id,
        name: item.food_name,
        brand: item.food_brand,
        quantity_g: item.quantity_g,
        // Recover per-100g from the stored per-item totals.
        per100: {
          calories_kcal: (item.nutrients.calories_kcal / item.quantity_g) * 100,
          protein_g: (item.nutrients.protein_g / item.quantity_g) * 100,
          carbs_g: (item.nutrients.carbs_g / item.quantity_g) * 100,
          fat_g: (item.nutrients.fat_g / item.quantity_g) * 100,
        },
      })),
    )
  }, [existing.data])

  const save = useMutation({
    mutationFn: () => {
      const payload: RecipeInput = {
        name,
        description: description || null,
        instructions: instructions || null,
        servings: Number(servings),
        items: items.map((item) => ({ food_id: item.food_id, quantity_g: item.quantity_g })),
      }
      return isNew ? api.createRecipe(payload) : api.updateRecipe(id!, payload)
    },
    onSuccess: (recipe) => {
      queryClient.invalidateQueries({ queryKey: ['recipes'] })
      navigate(`/recipes/${recipe.id}`, { replace: true })
    },
  })

  const servingCount = Number(servings) > 0 ? Number(servings) : 1

  // Totals recompute as you type; the server recomputes them the same way on
  // save, so what you see here is what gets stored.
  const total: Nutrients = items.reduce<Nutrients>(
    (acc, item) => {
      const f = item.quantity_g / 100
      return {
        calories_kcal: acc.calories_kcal + item.per100.calories_kcal * f,
        protein_g: acc.protein_g + item.per100.protein_g * f,
        carbs_g: acc.carbs_g + item.per100.carbs_g * f,
        fat_g: acc.fat_g + item.per100.fat_g * f,
        fiber_g: 0,
        sugar_g: 0,
        saturated_fat_g: 0,
        sodium_mg: 0,
      }
    },
    { calories_kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0, fiber_g: 0, sugar_g: 0, saturated_fat_g: 0, sodium_mg: 0 },
  )

  const perServing: Nutrients = {
    ...total,
    calories_kcal: total.calories_kcal / servingCount,
    protein_g: total.protein_g / servingCount,
    carbs_g: total.carbs_g / servingCount,
    fat_g: total.fat_g / servingCount,
  }

  const totalWeight = items.reduce((sum, item) => sum + item.quantity_g, 0)

  const addFood = (food: Food) => {
    setItems((prev) => [
      ...prev,
      {
        key: `${food.id}-${Date.now()}`,
        food_id: food.id,
        name: food.name,
        brand: food.brand,
        quantity_g: food.serving_size_g,
        per100: {
          calories_kcal: food.calories_kcal,
          protein_g: food.protein_g,
          carbs_g: food.carbs_g,
          fat_g: food.fat_g,
        },
      },
    ])
    setPicking(false)
  }

  if (!isNew && existing.isLoading) return <Spinner />

  return (
    <div className="page">
      <div className="page-head">
        <h1>{isNew ? 'New recipe' : 'Edit recipe'}</h1>
        <button type="button" className="button button-ghost button-small" onClick={() => navigate('/recipes')}>
          Back
        </button>
      </div>

      <ErrorNote error={existing.error} />

      <Card title="Details">
        <div className="form-grid">
          <label className="field field-wide">
            <span>Name</span>
            <input value={name} onChange={(e) => setName(e.target.value)} required autoFocus={isNew} />
          </label>
          <label className="field">
            <span>Servings</span>
            <input
              type="number"
              min={0.1}
              step="any"
              value={servings}
              onChange={(e) => setServings(e.target.value)}
            />
          </label>
          <label className="field field-wide">
            <span>Description</span>
            <input value={description} onChange={(e) => setDescription(e.target.value)} />
          </label>
          <label className="field field-wide">
            <span>Instructions</span>
            <textarea rows={5} value={instructions} onChange={(e) => setInstructions(e.target.value)} />
          </label>
        </div>
      </Card>

      <Card
        title="Ingredients"
        action={
          <button type="button" className="button button-small" onClick={() => setPicking(true)}>
            + Add ingredient
          </button>
        }
      >
        {items.length === 0 ? (
          <p className="empty">No ingredients yet.</p>
        ) : (
          <ul className="entry-list">
            {items.map((item, index) => (
              <li key={item.key} className="entry">
                <div className="entry-main">
                  <span className="entry-name">{item.name}</span>
                  {item.brand && <span className="muted small">{item.brand}</span>}
                </div>
                <label className="inline-field">
                  <input
                    type="number"
                    min={0.1}
                    step="any"
                    value={item.quantity_g}
                    onChange={(e) =>
                      setItems((prev) =>
                        prev.map((it, i) =>
                          i === index ? { ...it, quantity_g: Number(e.target.value) } : it,
                        ),
                      )
                    }
                  />
                  <span className="muted small">g</span>
                </label>
                <span className="muted small">
                  {kcal((item.per100.calories_kcal * item.quantity_g) / 100)}
                </span>
                <button
                  type="button"
                  className="icon-button"
                  aria-label={`Remove ${item.name}`}
                  onClick={() => setItems((prev) => prev.filter((_, i) => i !== index))}
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="Nutrition">
        <div className="nutrition-split">
          <div>
            <span className="muted small">Whole recipe · {grams(totalWeight, 0)}</span>
            <MacroRow n={total} />
          </div>
          <div>
            <span className="muted small">Per serving ({round(servingCount, 2)} servings)</span>
            <MacroRow n={perServing} />
          </div>
        </div>
      </Card>

      <ErrorNote error={save.error} />
      <div className="form-actions">
        <button
          type="button"
          className="button button-primary"
          disabled={save.isPending || !name || items.length === 0}
          onClick={() => save.mutate()}
        >
          {save.isPending ? 'Saving…' : isNew ? 'Create recipe' : 'Save changes'}
        </button>
        {items.length === 0 && <span className="muted small">Add at least one ingredient.</span>}
      </div>

      {picking && (
        <Modal title="Add ingredient" onClose={() => setPicking(false)} wide>
          <FoodPicker onPick={addFood} />
        </Modal>
      )}
    </div>
  )
}
