import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { api } from '../api/endpoints'
import type { Food, RecipeSummary } from '../api/types'
import { addDays, grams, kcal, prettyDate, round, titleCase, today } from '../lib/format'
import FoodPicker from '../components/FoodPicker'
import { Card, ErrorNote, MacroRow, Modal, Spinner, TargetList } from '../components/ui'

const MEALS = ['breakfast', 'lunch', 'dinner', 'snack']

export default function DiaryPage() {
  const [date, setDate] = useState(today())
  const [adding, setAdding] = useState<string | null>(null)
  const queryClient = useQueryClient()

  const day = useQuery({
    queryKey: ['diary', 'day', date],
    queryFn: () => api.diaryDay(date),
  })

  const remove = useMutation({
    mutationFn: (id: string) => api.deleteDiaryEntry(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['diary'] }),
  })

  // The headline number is the calorie target when one exists; every other
  // target is rendered uniformly by TargetList below.
  const calorieStatus = day.data?.targets.find((t) => t.nutrient === 'calories_kcal')

  return (
    <div className="page">
      <div className="page-head">
        <h1>Diary</h1>
        <div className="date-nav">
          <button type="button" className="button button-ghost" onClick={() => setDate(addDays(date, -1))}>
            ‹
          </button>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value || today())} />
          <button type="button" className="button button-ghost" onClick={() => setDate(addDays(date, 1))}>
            ›
          </button>
          {date !== today() && (
            <button type="button" className="button button-ghost" onClick={() => setDate(today())}>
              Today
            </button>
          )}
        </div>
      </div>

      {day.isLoading && <Spinner />}
      <ErrorNote error={day.error} />

      {day.data && (
        <Card title={prettyDate(date)}>
          <div className="day-total">
            <div className="big-number">
              <strong>{kcal(day.data.total.calories_kcal)}</strong>
              {calorieStatus && (
                <span className={calorieStatus.status === 'over' ? 'muted over' : 'muted'}>
                  {calorieStatus.status === 'over'
                    ? `${kcal(Math.abs(calorieStatus.remaining))} over budget`
                    : `${kcal(calorieStatus.remaining)} left`}
                </span>
              )}
            </div>
            <TargetList targets={day.data.targets} />
          </div>
        </Card>
      )}

      {(day.data?.meals ?? MEALS.map((meal) => ({ meal, entries: [], total: null }))).map((group) => (
        <Card
          key={group.meal}
          title={titleCase(group.meal)}
          action={
            <button type="button" className="button button-small" onClick={() => setAdding(group.meal)}>
              + Add
            </button>
          }
        >
          {group.entries.length === 0 ? (
            <p className="empty">Nothing logged.</p>
          ) : (
            <ul className="entry-list">
              {group.entries.map((entry) => (
                <li key={entry.id} className="entry">
                  <div className="entry-main">
                    <span className="entry-name">{entry.name}</span>
                    <span className="muted small">
                      {entry.brand ? `${entry.brand} · ` : ''}
                      {entry.quantity_g != null
                        ? grams(entry.quantity_g, 0)
                        : `${round(entry.recipe_servings ?? 0, 2)} serving${
                            (entry.recipe_servings ?? 0) === 1 ? '' : 's'
                          }`}
                    </span>
                  </div>
                  <MacroRow n={entry.nutrients} compact />
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={`Remove ${entry.name}`}
                    onClick={() => remove.mutate(entry.id)}
                  >
                    ✕
                  </button>
                </li>
              ))}
            </ul>
          )}
          {/* A subtotal only earns its space once a meal has more than one
              entry — otherwise it just repeats the row above it. */}
          {group.total && group.entries.length > 1 && (
            <footer className="card-foot">
              <span className="muted small">Meal total</span>
              <MacroRow n={group.total} compact />
            </footer>
          )}
        </Card>
      ))}

      {adding && (
        <AddEntryModal meal={adding} date={date} onClose={() => setAdding(null)} />
      )}
    </div>
  )
}

function AddEntryModal({
  meal,
  date,
  onClose,
}: {
  meal: string
  date: string
  onClose: () => void
}) {
  const [mode, setMode] = useState<'food' | 'recipe'>('food')
  const [picked, setPicked] = useState<Food | null>(null)
  const [pickedRecipe, setPickedRecipe] = useState<RecipeSummary | null>(null)
  const [amount, setAmount] = useState('100')
  const [servings, setServings] = useState('1')
  const queryClient = useQueryClient()

  const recipes = useQuery({
    queryKey: ['recipes'],
    queryFn: () => api.listRecipes(),
    enabled: mode === 'recipe',
  })

  const log = useMutation({
    mutationFn: () =>
      picked
        ? api.logDiaryEntry({
            logged_on: date,
            meal,
            food_id: picked.id,
            quantity_g: Number(amount),
          })
        : api.logDiaryEntry({
            logged_on: date,
            meal,
            recipe_id: pickedRecipe!.id,
            recipe_servings: Number(servings),
          }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['diary'] })
      onClose()
    },
  })

  // Preview the macros for the amount currently typed, before committing —
  // the scaling rule is the same one the server applies.
  const preview =
    picked && Number(amount) > 0
      ? {
          calories_kcal: (picked.calories_kcal * Number(amount)) / 100,
          protein_g: (picked.protein_g * Number(amount)) / 100,
          carbs_g: (picked.carbs_g * Number(amount)) / 100,
          fat_g: (picked.fat_g * Number(amount)) / 100,
          fiber_g: 0,
          sugar_g: 0,
          saturated_fat_g: 0,
          sodium_mg: 0,
        }
      : pickedRecipe && Number(servings) > 0
        ? {
            ...pickedRecipe.per_serving,
            calories_kcal: pickedRecipe.per_serving.calories_kcal * Number(servings),
            protein_g: pickedRecipe.per_serving.protein_g * Number(servings),
            carbs_g: pickedRecipe.per_serving.carbs_g * Number(servings),
            fat_g: pickedRecipe.per_serving.fat_g * Number(servings),
          }
        : null

  return (
    <Modal title={`Add to ${titleCase(meal)}`} onClose={onClose} wide>
      <div className="segmented" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'food'}
          className={mode === 'food' ? 'active' : ''}
          onClick={() => {
            setMode('food')
            setPickedRecipe(null)
          }}
        >
          Food
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'recipe'}
          className={mode === 'recipe' ? 'active' : ''}
          onClick={() => {
            setMode('recipe')
            setPicked(null)
          }}
        >
          Recipe
        </button>
      </div>

      {mode === 'food' &&
        (picked ? (
          <div className="picked">
            <div className="picked-head">
              <div>
                <strong>{picked.name}</strong>
                {picked.brand && <span className="muted small"> · {picked.brand}</span>}
              </div>
              <button type="button" className="button button-ghost button-small" onClick={() => setPicked(null)}>
                Change
              </button>
            </div>

            <label className="field">
              <span>Amount (grams)</span>
              <input
                type="number"
                min={1}
                step="any"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                autoFocus
              />
            </label>

            <div className="quick-amounts">
              <button type="button" className="chip" onClick={() => setAmount(String(picked.serving_size_g))}>
                1 serving ({grams(picked.serving_size_g, 0)}
                {picked.serving_label ? ` · ${picked.serving_label}` : ''})
              </button>
              <button type="button" className="chip" onClick={() => setAmount('100')}>
                100 g
              </button>
            </div>

            {preview && <MacroRow n={preview} />}
            <ErrorNote error={log.error} />
            <button
              type="button"
              className="button button-primary"
              disabled={log.isPending || !(Number(amount) > 0)}
              onClick={() => log.mutate()}
            >
              {log.isPending ? 'Saving…' : 'Log it'}
            </button>
          </div>
        ) : (
          <FoodPicker onPick={setPicked} />
        ))}

      {mode === 'recipe' &&
        (pickedRecipe ? (
          <div className="picked">
            <div className="picked-head">
              <strong>{pickedRecipe.name}</strong>
              <button
                type="button"
                className="button button-ghost button-small"
                onClick={() => setPickedRecipe(null)}
              >
                Change
              </button>
            </div>
            <label className="field">
              <span>Servings</span>
              <input
                type="number"
                min={0.1}
                step="any"
                value={servings}
                onChange={(e) => setServings(e.target.value)}
                autoFocus
              />
            </label>
            {preview && <MacroRow n={preview} />}
            <ErrorNote error={log.error} />
            <button
              type="button"
              className="button button-primary"
              disabled={log.isPending || !(Number(servings) > 0)}
              onClick={() => log.mutate()}
            >
              {log.isPending ? 'Saving…' : 'Log it'}
            </button>
          </div>
        ) : (
          <div className="picker-results">
            {recipes.isLoading && <Spinner />}
            <ErrorNote error={recipes.error} />
            {recipes.data?.length === 0 && <p className="empty">No recipes yet.</p>}
            {recipes.data?.map((recipe) => (
              <button
                key={recipe.id}
                type="button"
                className="picker-item"
                onClick={() => setPickedRecipe(recipe)}
              >
                <span className="picker-item-main">
                  <span className="picker-item-name">{recipe.name}</span>
                  <span className="muted small">
                    {kcal(recipe.per_serving.calories_kcal)} per serving · {recipe.servings} servings
                  </span>
                </span>
              </button>
            ))}
          </div>
        ))}
    </Modal>
  )
}
