/** Formatting helpers kept in one place so units read the same on every screen. */

export const kcal = (v: number | null | undefined) =>
  v === null || v === undefined ? '—' : `${Math.round(v).toLocaleString()} kcal`

export const grams = (v: number | null | undefined, digits = 1) =>
  v === null || v === undefined ? '—' : `${round(v, digits)} g`

export const kg = (v: number | null | undefined, digits = 1) =>
  v === null || v === undefined ? '—' : `${round(v, digits)} kg`

export const round = (v: number, digits = 1) => {
  const factor = 10 ** digits
  return Math.round(v * factor) / factor
}

export const signed = (v: number | null | undefined, digits = 1) => {
  if (v === null || v === undefined) return '—'
  const r = round(v, digits)
  return r > 0 ? `+${r}` : `${r}`
}

export const today = () => toISODate(new Date())

export function toISODate(date: Date): string {
  // Local calendar date, not UTC: logging dinner at 9pm should not land on
  // tomorrow for anyone east of Greenwich.
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

export function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number)
  const date = new Date(y, m - 1, d)
  date.setDate(date.getDate() + days)
  return toISODate(date)
}

export function prettyDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number)
  const date = new Date(y, m - 1, d)
  const t = today()
  if (iso === t) return 'Today'
  if (iso === addDays(t, -1)) return 'Yesterday'
  if (iso === addDays(t, 1)) return 'Tomorrow'
  return date.toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: date.getFullYear() === new Date().getFullYear() ? undefined : 'numeric',
  })
}

export const shortDate = (iso: string) => {
  const [, m, d] = iso.split('-').map(Number)
  return `${m}/${d}`
}

export const titleCase = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

export const sourceLabel = (source: string) =>
  source === 'usda' ? 'USDA' : source === 'off' ? 'Open Food Facts' : 'Custom'

/** lb <-> kg helpers: the API is metric, the UI lets you pick. */
export const LB_PER_KG = 2.2046226218
export const kgToLb = (v: number) => v * LB_PER_KG
export const lbToKg = (v: number) => v / LB_PER_KG
