import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { api } from '../api/endpoints'
import type { TargetInput } from '../api/endpoints'
import type { Nutrient, TargetKind } from '../api/types'
import { Card, ErrorNote, Spinner } from './ui'

/**
 * The nutrient vocabulary, mirroring the server's, with the direction each one
 * defaults to. Protein and fibre are things you try to reach; the rest are
 * things you try to stay under. Every one can be flipped — carbs are a budget
 * when cutting and a goal when bulking.
 */
const NUTRIENTS: {
  key: Nutrient
  label: string
  unit: string
  defaultKind: TargetKind
  hint?: string
}[] = [
  { key: 'calories_kcal', label: 'Calories', unit: 'kcal', defaultKind: 'budget' },
  { key: 'protein_g', label: 'Protein', unit: 'g', defaultKind: 'goal' },
  { key: 'carbs_g', label: 'Carbs', unit: 'g', defaultKind: 'budget' },
  { key: 'fat_g', label: 'Fat', unit: 'g', defaultKind: 'budget' },
  { key: 'fiber_g', label: 'Fiber', unit: 'g', defaultKind: 'goal', hint: '25–38 g is typical' },
  { key: 'sugar_g', label: 'Sugar', unit: 'g', defaultKind: 'budget' },
  { key: 'saturated_fat_g', label: 'Saturated fat', unit: 'g', defaultKind: 'budget' },
  { key: 'sodium_mg', label: 'Sodium', unit: 'mg', defaultKind: 'budget', hint: '2300 mg is the usual cap' },
]

/** A row in the editor. A blank amount means "no target for this nutrient". */
interface Row {
  amount: string
  kind: TargetKind
}

type Rows = Record<Nutrient, Row>

const blankRows = (): Rows =>
  Object.fromEntries(
    NUTRIENTS.map((n) => [n.key, { amount: '', kind: n.defaultKind }]),
  ) as Rows

export interface Suggestion {
  calories: number
  protein: number
  carbs: number
  fat: number
  fiber: number
}

export default function TargetsEditor({ suggestion }: { suggestion: Suggestion | null }) {
  const queryClient = useQueryClient()
  const [rows, setRows] = useState<Rows>(blankRows)
  const [saved, setSaved] = useState(false)

  const targets = useQuery({ queryKey: ['targets'], queryFn: () => api.listTargets() })

  // Hydrate from the server, leaving nutrients with no target blank.
  useEffect(() => {
    if (!targets.data) return
    const next = blankRows()
    for (const t of targets.data) {
      next[t.nutrient] = { amount: String(t.amount), kind: t.kind }
    }
    setRows(next)
  }, [targets.data])

  const save = useMutation({
    mutationFn: () => {
      // PUT replaces the whole set, so a row left blank is a cleared target.
      const payload: TargetInput[] = NUTRIENTS.flatMap((n) => {
        const row = rows[n.key]
        const amount = Number(row.amount)
        if (!row.amount.trim() || !Number.isFinite(amount) || amount <= 0) return []
        return [{ nutrient: n.key, amount, kind: row.kind }]
      })
      return api.replaceTargets(payload)
    },
    onSuccess: () => {
      // The diary and dashboard read targets through their day query, so both
      // have to be refreshed, not just this list.
      queryClient.invalidateQueries({ queryKey: ['targets'] })
      queryClient.invalidateQueries({ queryKey: ['diary'] })
      setSaved(true)
      setTimeout(() => setSaved(false), 2500)
    },
  })

  const set = (key: Nutrient, patch: Partial<Row>) =>
    setRows((r) => ({ ...r, [key]: { ...r[key], ...patch } }))

  const applySuggestion = () => {
    if (!suggestion) return
    setRows((r) => ({
      ...r,
      calories_kcal: { amount: String(suggestion.calories), kind: 'budget' },
      protein_g: { amount: String(suggestion.protein), kind: 'goal' },
      carbs_g: { amount: String(suggestion.carbs), kind: 'budget' },
      fat_g: { amount: String(suggestion.fat), kind: 'budget' },
      fiber_g: { amount: String(suggestion.fiber), kind: 'goal' },
    }))
  }

  const activeCount = NUTRIENTS.filter((n) => Number(rows[n.key].amount) > 0).length

  if (targets.isLoading) return <Spinner />

  return (
    <Card
      title="Daily goals & budgets"
      action={saved ? <span className="note note-ok">Saved</span> : null}
    >
      <p className="muted small">
        A <strong>budget</strong> is a ceiling — stay under it. A <strong>goal</strong> is a floor —
        hit at least that much. Leave a number blank to not track it.
      </p>

      {suggestion && (
        <div className="note note-ok suggestion">
          <div>
            <strong>Suggested:</strong> {suggestion.calories} kcal budget · {suggestion.protein} g
            protein goal · {suggestion.carbs} g carbs · {suggestion.fat} g fat · {suggestion.fiber} g
            fiber
            <br />
            <span className="muted small">
              Mifflin-St Jeor BMR × activity, adjusted for your goal. An estimate — adjust to what
              the scale actually does.
            </span>
          </div>
          <button type="button" className="button button-small" onClick={applySuggestion}>
            Use these
          </button>
        </div>
      )}

      <div className="target-rows">
        {NUTRIENTS.map((n) => {
          const row = rows[n.key]
          const active = Number(row.amount) > 0
          return (
            <div className={`target-row ${active ? '' : 'target-row-off'}`} key={n.key}>
              <label className="target-row-label" htmlFor={`target-${n.key}`}>
                {n.label}
                {n.hint && <span className="muted small"> {n.hint}</span>}
              </label>

              <div className="target-row-amount">
                <input
                  id={`target-${n.key}`}
                  type="number"
                  min={0}
                  step="any"
                  inputMode="decimal"
                  placeholder="—"
                  value={row.amount}
                  onChange={(e) => set(n.key, { amount: e.target.value })}
                />
                <span className="muted small">{n.unit}</span>
              </div>

              <div className="segmented segmented-small" role="group" aria-label={`${n.label} direction`}>
                <button
                  type="button"
                  disabled={!active}
                  aria-pressed={row.kind === 'goal'}
                  className={row.kind === 'goal' ? 'active' : ''}
                  onClick={() => set(n.key, { kind: 'goal' })}
                >
                  Goal
                </button>
                <button
                  type="button"
                  disabled={!active}
                  aria-pressed={row.kind === 'budget'}
                  className={row.kind === 'budget' ? 'active' : ''}
                  onClick={() => set(n.key, { kind: 'budget' })}
                >
                  Budget
                </button>
              </div>

              <button
                type="button"
                className="icon-button"
                aria-label={`Clear ${n.label} target`}
                disabled={!active}
                onClick={() => set(n.key, { amount: '' })}
              >
                ✕
              </button>
            </div>
          )
        })}
      </div>

      <ErrorNote error={targets.error} />
      <ErrorNote error={save.error} />

      <div className="form-actions">
        <button
          type="button"
          className="button button-primary"
          disabled={save.isPending}
          onClick={() => save.mutate()}
        >
          {save.isPending ? 'Saving…' : 'Save targets'}
        </button>
        <span className="muted small">
          {activeCount} of {NUTRIENTS.length} tracked
        </span>
      </div>
    </Card>
  )
}
