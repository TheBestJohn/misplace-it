import { useEffect, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'

import { api } from '../api/endpoints'
import type { Profile } from '../api/types'
import { useAuth } from '../lib/auth'
import { round } from '../lib/format'
import { Card, ErrorNote, Spinner } from '../components/ui'

const ACTIVITY = [
  { value: 'sedentary', label: 'Sedentary (desk job, little exercise)', factor: 1.2 },
  { value: 'light', label: 'Light (1-3 sessions a week)', factor: 1.375 },
  { value: 'moderate', label: 'Moderate (3-5 sessions a week)', factor: 1.55 },
  { value: 'active', label: 'Active (6-7 sessions a week)', factor: 1.725 },
  { value: 'very_active', label: 'Very active (physical job or 2x/day)', factor: 1.9 },
]

const GOALS = [
  { value: 'cut', label: 'Lose weight', adjust: -500 },
  { value: 'maintain', label: 'Maintain', adjust: 0 },
  { value: 'bulk', label: 'Gain weight', adjust: 300 },
]

export default function SettingsPage() {
  const { user, setUser } = useAuth()
  const [form, setForm] = useState<Partial<Profile>>({})
  const [saved, setSaved] = useState(false)

  const profile = useQuery({ queryKey: ['profile'], queryFn: () => api.getProfile() })
  const latestWeight = useQuery({
    queryKey: ['weights', 'latest'],
    queryFn: () => api.listWeights({ limit: 1 }),
  })

  useEffect(() => {
    if (profile.data) setForm(profile.data)
  }, [profile.data])

  const save = useMutation({
    mutationFn: () => api.updateProfile(form),
    onSuccess: (updated) => {
      setUser(updated)
      setForm(updated)
      setSaved(true)
      setTimeout(() => setSaved(false), 2500)
    },
  })

  const set = <K extends keyof Profile>(key: K, value: Profile[K]) =>
    setForm((f) => ({ ...f, [key]: value }))

  const num = (key: keyof Profile) => (e: React.ChangeEvent<HTMLInputElement>) =>
    set(key as never, (e.target.value === '' ? null : Number(e.target.value)) as never)

  /**
   * Mifflin-St Jeor BMR, scaled by activity, adjusted for the stated goal.
   * It's an estimate to seed the targets — you can overwrite any of them.
   */
  const suggestion = (() => {
    const weight = latestWeight.data?.[0]?.weight_kg ?? form.target_weight_kg
    const height = form.height_cm
    const birth = form.birth_date
    if (!weight || !height || !birth) return null

    const age = Math.floor((Date.now() - new Date(birth).getTime()) / (365.25 * 24 * 3600 * 1000))
    const sexOffset = form.sex === 'female' ? -161 : 5
    const bmr = 10 * weight + 6.25 * height - 5 * age + sexOffset
    const factor = ACTIVITY.find((a) => a.value === form.activity_level)?.factor ?? 1.55
    const adjust = GOALS.find((g) => g.value === form.goal)?.adjust ?? 0
    const calories = Math.round(bmr * factor + adjust)

    // 2 g protein/kg on a cut (protects lean mass), 1.6 otherwise; 25% of
    // calories from fat; carbohydrate fills the remainder.
    const protein = Math.round(weight * (form.goal === 'cut' ? 2.0 : 1.6))
    const fat = Math.round((calories * 0.25) / 9)
    const carbs = Math.round((calories - protein * 4 - fat * 9) / 4)

    return { calories, protein, fat, carbs: Math.max(carbs, 0) }
  })()

  if (profile.isLoading) return <Spinner />

  return (
    <div className="page">
      <div className="page-head">
        <h1>Settings</h1>
        {saved && <span className="note note-ok">Saved</span>}
      </div>

      <Card title="Profile">
        <div className="form-grid">
          <label className="field">
            <span>Name</span>
            <input value={form.display_name ?? ''} onChange={(e) => set('display_name', e.target.value)} />
          </label>
          <label className="field">
            <span>Email</span>
            <input value={user?.email ?? ''} disabled />
          </label>
          <label className="field">
            <span>Date of birth</span>
            <input
              type="date"
              value={form.birth_date ?? ''}
              onChange={(e) => set('birth_date', e.target.value || null)}
            />
          </label>
          <label className="field">
            <span>Sex</span>
            <select value={form.sex ?? ''} onChange={(e) => set('sex', e.target.value || null)}>
              <option value="">Prefer not to say</option>
              <option value="female">Female</option>
              <option value="male">Male</option>
            </select>
          </label>
          <label className="field">
            <span>Height (cm)</span>
            <input type="number" step="any" value={form.height_cm ?? ''} onChange={num('height_cm')} />
          </label>
          <label className="field">
            <span>Target weight (kg)</span>
            <input
              type="number"
              step="any"
              value={form.target_weight_kg ?? ''}
              onChange={num('target_weight_kg')}
            />
          </label>
          <label className="field field-wide">
            <span>Activity level</span>
            <select
              value={form.activity_level ?? 'moderate'}
              onChange={(e) => set('activity_level', e.target.value)}
            >
              {ACTIVITY.map((a) => (
                <option key={a.value} value={a.value}>
                  {a.label}
                </option>
              ))}
            </select>
          </label>
          <label className="field field-wide">
            <span>Goal</span>
            <select value={form.goal ?? 'maintain'} onChange={(e) => set('goal', e.target.value)}>
              {GOALS.map((g) => (
                <option key={g.value} value={g.value}>
                  {g.label}
                </option>
              ))}
            </select>
          </label>
        </div>
      </Card>

      <Card title="Daily targets">
        {suggestion && (
          <div className="note note-ok suggestion">
            <div>
              <strong>Suggested:</strong> {suggestion.calories} kcal · P {suggestion.protein} g · C{' '}
              {suggestion.carbs} g · F {suggestion.fat} g
              <br />
              <span className="muted small">
                Mifflin-St Jeor BMR × activity, adjusted for your goal. An estimate — adjust to what
                the scale actually does.
              </span>
            </div>
            <button
              type="button"
              className="button button-small"
              onClick={() =>
                setForm((f) => ({
                  ...f,
                  daily_calorie_target: suggestion.calories,
                  daily_protein_target_g: suggestion.protein,
                  daily_carbs_target_g: suggestion.carbs,
                  daily_fat_target_g: suggestion.fat,
                }))
              }
            >
              Use these
            </button>
          </div>
        )}
        {!suggestion && (
          <p className="muted small">
            Set your height, date of birth and log a weight to get a suggested calorie target.
          </p>
        )}

        <div className="form-grid">
          <label className="field">
            <span>Calories (kcal)</span>
            <input
              type="number"
              step="any"
              value={form.daily_calorie_target ?? ''}
              onChange={num('daily_calorie_target')}
            />
          </label>
          <label className="field">
            <span>Protein (g)</span>
            <input
              type="number"
              step="any"
              value={form.daily_protein_target_g ?? ''}
              onChange={num('daily_protein_target_g')}
            />
          </label>
          <label className="field">
            <span>Carbs (g)</span>
            <input
              type="number"
              step="any"
              value={form.daily_carbs_target_g ?? ''}
              onChange={num('daily_carbs_target_g')}
            />
          </label>
          <label className="field">
            <span>Fat (g)</span>
            <input
              type="number"
              step="any"
              value={form.daily_fat_target_g ?? ''}
              onChange={num('daily_fat_target_g')}
            />
          </label>
        </div>

        {form.daily_calorie_target && (
          <p className="muted small">
            Macros account for{' '}
            {round(
              ((form.daily_protein_target_g ?? 0) * 4 +
                (form.daily_carbs_target_g ?? 0) * 4 +
                (form.daily_fat_target_g ?? 0) * 9),
              0,
            )}{' '}
            of {round(form.daily_calorie_target, 0)} kcal.
          </p>
        )}
      </Card>

      <ErrorNote error={save.error} />
      <div className="form-actions">
        <button
          type="button"
          className="button button-primary"
          disabled={save.isPending}
          onClick={() => save.mutate()}
        >
          {save.isPending ? 'Saving…' : 'Save settings'}
        </button>
      </div>
    </div>
  )
}
