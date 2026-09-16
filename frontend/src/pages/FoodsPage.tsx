import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { api } from '../api/endpoints'
import type { FoodInput } from '../api/endpoints'
import type { ExternalFood, Food } from '../api/types'
import { useAuth } from '../lib/auth'
import { grams, kcal, round, sourceLabel } from '../lib/format'
import { Card, ErrorNote, Modal, SourceBadge, Spinner } from '../components/ui'

export default function FoodsPage() {
  const { user } = useAuth()
  const queryClient = useQueryClient()
  const [term, setTerm] = useState('')
  const [debounced, setDebounced] = useState('')
  const [mineOnly, setMineOnly] = useState(false)
  const [editing, setEditing] = useState<Food | 'new' | null>(null)
  const [barcode, setBarcode] = useState('')
  const [submittedBarcode, setSubmittedBarcode] = useState('')
  const [externalTerm, setExternalTerm] = useState('')

  useEffect(() => {
    const id = setTimeout(() => setDebounced(term.trim()), 300)
    return () => clearTimeout(id)
  }, [term])

  const foods = useQuery({
    queryKey: ['foods', debounced, mineOnly],
    queryFn: () => api.listFoods({ q: debounced || undefined, mine: mineOnly, limit: 100 }),
  })

  const external = useQuery({
    queryKey: ['foods', 'external', externalTerm],
    queryFn: () => api.searchExternal(externalTerm),
    enabled: externalTerm.length >= 2,
  })

  const lookup = useQuery({
    queryKey: ['foods', 'barcode', submittedBarcode],
    queryFn: () => api.lookupBarcode(submittedBarcode),
    enabled: submittedBarcode.length >= 6,
    retry: false,
  })

  const importFood = useMutation({
    mutationFn: (food: ExternalFood) => api.importFood(food),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['foods'] }),
  })

  const remove = useMutation({
    mutationFn: (id: string) => api.deleteFood(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['foods'] }),
  })

  return (
    <div className="page">
      <div className="page-head">
        <h1>Foods</h1>
        <button type="button" className="button button-primary button-small" onClick={() => setEditing('new')}>
          + Custom food
        </button>
      </div>

      <Card title="Look up a barcode">
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault()
            setSubmittedBarcode(barcode.replace(/\D/g, ''))
          }}
        >
          <input
            className="grow"
            inputMode="numeric"
            placeholder="UPC / EAN, e.g. 3017624010701"
            value={barcode}
            onChange={(e) => setBarcode(e.target.value)}
          />
          <button type="submit" className="button button-primary">
            Look up
          </button>
        </form>
        {lookup.isFetching && <Spinner label="Looking up…" />}
        <ErrorNote error={lookup.error} />
        {lookup.data?.local && (
          <p className="note">
            Already in your library: <strong>{lookup.data.local.name}</strong>
          </p>
        )}
        {lookup.data?.external && !lookup.data.local && (
          <div className="picker-item picker-item-static">
            <span className="picker-item-main">
              <span className="picker-item-name">{lookup.data.external.name}</span>
              <span className="muted small">
                {lookup.data.external.brand ? `${lookup.data.external.brand} · ` : ''}
                {sourceLabel(lookup.data.external.source)} · {kcal(lookup.data.external.calories_kcal)} /
                100 g
              </span>
            </span>
            <button
              type="button"
              className="button button-small"
              disabled={importFood.isPending}
              onClick={() => importFood.mutate(lookup.data!.external!)}
            >
              Import
            </button>
          </div>
        )}
      </Card>

      <Card title="Search USDA & Open Food Facts">
        <input
          className="grow"
          placeholder="e.g. greek yogurt"
          value={externalTerm}
          onChange={(e) => setExternalTerm(e.target.value)}
        />
        {external.isFetching && <Spinner label="Searching…" />}
        <ErrorNote error={external.error} />
        <ErrorNote error={importFood.error} />
        {external.data?.unavailable.map((reason) => (
          <p className="note note-warn" key={reason}>
            {reason}
          </p>
        ))}
        <div className="picker-results">
          {external.data?.results.map((food) => (
            <div className="picker-item picker-item-static" key={`${food.source}-${food.source_id}`}>
              <span className="picker-item-main">
                <span className="picker-item-name">{food.name}</span>
                <span className="muted small">
                  {food.brand ? `${food.brand} · ` : ''}
                  {kcal(food.calories_kcal)} / 100 g · P {round(food.protein_g)} C {round(food.carbs_g)} F{' '}
                  {round(food.fat_g)}
                </span>
              </span>
              <SourceBadge source={food.source} />
              <button
                type="button"
                className="button button-small"
                disabled={importFood.isPending}
                onClick={() => importFood.mutate(food)}
              >
                Import
              </button>
            </div>
          ))}
        </div>
      </Card>

      <Card
        title="Library"
        action={
          <label className="checkbox">
            <input type="checkbox" checked={mineOnly} onChange={(e) => setMineOnly(e.target.checked)} />
            <span>Mine only</span>
          </label>
        }
      >
        <input
          className="grow"
          placeholder="Filter your food library…"
          value={term}
          onChange={(e) => setTerm(e.target.value)}
        />
        {foods.isLoading && <Spinner />}
        <ErrorNote error={foods.error} />
        <ErrorNote error={remove.error} />
        {foods.data?.length === 0 && <p className="empty">Nothing matches.</p>}
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th className="num">kcal</th>
                <th className="num">P</th>
                <th className="num">C</th>
                <th className="num">F</th>
                <th>Serving</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {foods.data?.map((food) => (
                <tr key={food.id}>
                  <td>
                    <div className="cell-main">
                      <span>{food.name}</span>
                      <SourceBadge source={food.source} />
                    </div>
                    {food.brand && <span className="muted small">{food.brand}</span>}
                  </td>
                  <td className="num">{round(food.calories_kcal)}</td>
                  <td className="num">{round(food.protein_g)}</td>
                  <td className="num">{round(food.carbs_g)}</td>
                  <td className="num">{round(food.fat_g)}</td>
                  <td className="muted small">
                    {grams(food.serving_size_g, 0)}
                    {food.serving_label ? ` · ${food.serving_label}` : ''}
                  </td>
                  <td className="actions">
                    {food.created_by === user?.id && (
                      <>
                        <button type="button" className="button button-ghost button-small" onClick={() => setEditing(food)}>
                          Edit
                        </button>
                        <button
                          type="button"
                          className="icon-button"
                          aria-label={`Delete ${food.name}`}
                          onClick={() => remove.mutate(food.id)}
                        >
                          ✕
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="muted small">All figures are per 100 g.</p>
      </Card>

      {editing && (
        <FoodFormModal
          food={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  )
}

const EMPTY: FoodInput = {
  name: '',
  brand: '',
  upc: '',
  calories_kcal: 0,
  protein_g: 0,
  carbs_g: 0,
  fat_g: 0,
  fiber_g: null,
  sugar_g: null,
  saturated_fat_g: null,
  sodium_mg: null,
  serving_size_g: 100,
  serving_label: '',
}

function FoodFormModal({ food, onClose }: { food: Food | null; onClose: () => void }) {
  const queryClient = useQueryClient()
  const [form, setForm] = useState<FoodInput>(
    food
      ? {
          name: food.name,
          brand: food.brand ?? '',
          upc: food.upc ?? '',
          calories_kcal: food.calories_kcal,
          protein_g: food.protein_g,
          carbs_g: food.carbs_g,
          fat_g: food.fat_g,
          fiber_g: food.fiber_g,
          sugar_g: food.sugar_g,
          saturated_fat_g: food.saturated_fat_g,
          sodium_mg: food.sodium_mg,
          serving_size_g: food.serving_size_g,
          serving_label: food.serving_label ?? '',
        }
      : EMPTY,
  )

  const save = useMutation({
    mutationFn: () => {
      const payload: FoodInput = {
        ...form,
        brand: form.brand || null,
        upc: form.upc || null,
        serving_label: form.serving_label || null,
      }
      return food ? api.updateFood(food.id, payload) : api.createFood(payload)
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['foods'] })
      onClose()
    },
  })

  const num = (key: keyof FoodInput) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [key]: e.target.value === '' ? null : Number(e.target.value) }))

  return (
    <Modal title={food ? 'Edit food' : 'New custom food'} onClose={onClose} wide>
      <form
        className="form-grid"
        onSubmit={(e) => {
          e.preventDefault()
          save.mutate()
        }}
      >
        <label className="field field-wide">
          <span>Name</span>
          <input
            required
            value={form.name}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            autoFocus
          />
        </label>
        <label className="field">
          <span>Brand</span>
          <input value={form.brand ?? ''} onChange={(e) => setForm((f) => ({ ...f, brand: e.target.value }))} />
        </label>
        <label className="field">
          <span>UPC</span>
          <input
            inputMode="numeric"
            value={form.upc ?? ''}
            onChange={(e) => setForm((f) => ({ ...f, upc: e.target.value }))}
          />
        </label>

        <p className="field-note field-wide">Enter nutrients per 100 g.</p>

        <label className="field">
          <span>Calories (kcal)</span>
          <input type="number" step="any" min={0} required value={form.calories_kcal} onChange={num('calories_kcal')} />
        </label>
        <label className="field">
          <span>Protein (g)</span>
          <input type="number" step="any" min={0} required value={form.protein_g} onChange={num('protein_g')} />
        </label>
        <label className="field">
          <span>Carbs (g)</span>
          <input type="number" step="any" min={0} required value={form.carbs_g} onChange={num('carbs_g')} />
        </label>
        <label className="field">
          <span>Fat (g)</span>
          <input type="number" step="any" min={0} required value={form.fat_g} onChange={num('fat_g')} />
        </label>
        <label className="field">
          <span>Fiber (g)</span>
          <input type="number" step="any" min={0} value={form.fiber_g ?? ''} onChange={num('fiber_g')} />
        </label>
        <label className="field">
          <span>Sugar (g)</span>
          <input type="number" step="any" min={0} value={form.sugar_g ?? ''} onChange={num('sugar_g')} />
        </label>
        <label className="field">
          <span>Saturated fat (g)</span>
          <input type="number" step="any" min={0} value={form.saturated_fat_g ?? ''} onChange={num('saturated_fat_g')} />
        </label>
        <label className="field">
          <span>Sodium (mg)</span>
          <input type="number" step="any" min={0} value={form.sodium_mg ?? ''} onChange={num('sodium_mg')} />
        </label>

        <label className="field">
          <span>Serving size (g)</span>
          <input type="number" step="any" min={0.1} required value={form.serving_size_g} onChange={num('serving_size_g')} />
        </label>
        <label className="field">
          <span>Serving label</span>
          <input
            placeholder="e.g. 1 cup"
            value={form.serving_label ?? ''}
            onChange={(e) => setForm((f) => ({ ...f, serving_label: e.target.value }))}
          />
        </label>

        <ErrorNote error={save.error} />
        <div className="form-actions field-wide">
          <button type="submit" className="button button-primary" disabled={save.isPending}>
            {save.isPending ? 'Saving…' : 'Save'}
          </button>
          <button type="button" className="button button-ghost" onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </Modal>
  )
}
