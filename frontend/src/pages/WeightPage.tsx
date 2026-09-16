import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'

import { api } from '../api/endpoints'
import { useAuth } from '../lib/auth'
import { addDays, kg, kgToLb, lbToKg, prettyDate, round, shortDate, signed, today } from '../lib/format'
import { Card, ErrorNote, Spinner } from '../components/ui'

const RANGES = [
  { label: '30d', days: 30 },
  { label: '90d', days: 90 },
  { label: '1y', days: 365 },
  { label: 'All', days: 3650 },
]

export default function WeightPage() {
  const { user } = useAuth()
  const queryClient = useQueryClient()
  const [rangeDays, setRangeDays] = useState(90)
  const [unit, setUnit] = useState<'kg' | 'lb'>('kg')

  const [date, setDate] = useState(today())
  const [value, setValue] = useState('')
  const [bodyFat, setBodyFat] = useState('')
  const [note, setNote] = useState('')

  const to = today()
  const from = addDays(to, -rangeDays)

  const entries = useQuery({
    queryKey: ['weights', from, to],
    queryFn: () => api.listWeights({ from, to, limit: 2000 }),
  })
  const stats = useQuery({
    queryKey: ['weights', 'stats', from, to],
    queryFn: () => api.weightStats({ from, to }),
  })

  const log = useMutation({
    mutationFn: () =>
      api.logWeight({
        recorded_on: date,
        // The API is metric; convert at the edge so only this line knows about lb.
        weight_kg: unit === 'kg' ? Number(value) : lbToKg(Number(value)),
        body_fat_pct: bodyFat ? Number(bodyFat) : null,
        note: note || null,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['weights'] })
      setValue('')
      setBodyFat('')
      setNote('')
    },
  })

  const remove = useMutation({
    mutationFn: (id: string) => api.deleteWeight(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['weights'] }),
  })

  const display = (v: number | null | undefined) => {
    if (v === null || v === undefined) return '—'
    return unit === 'kg' ? kg(v) : `${round(kgToLb(v))} lb`
  }

  const series = (entries.data ?? [])
    .slice()
    .reverse()
    .map((w) => ({
      date: shortDate(w.recorded_on),
      value: round(unit === 'kg' ? w.weight_kg : kgToLb(w.weight_kg), 2),
    }))

  const targetLine =
    user?.target_weight_kg != null
      ? round(unit === 'kg' ? user.target_weight_kg : kgToLb(user.target_weight_kg), 2)
      : null

  return (
    <div className="page">
      <div className="page-head">
        <h1>Weight</h1>
        <div className="segmented segmented-small">
          <button type="button" className={unit === 'kg' ? 'active' : ''} onClick={() => setUnit('kg')}>
            kg
          </button>
          <button type="button" className={unit === 'lb' ? 'active' : ''} onClick={() => setUnit('lb')}>
            lb
          </button>
        </div>
      </div>

      <Card title="Log a weigh-in">
        <form
          className="form-grid"
          onSubmit={(e) => {
            e.preventDefault()
            log.mutate()
          }}
        >
          <label className="field">
            <span>Date</span>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} max={today()} />
          </label>
          <label className="field">
            <span>Weight ({unit})</span>
            <input
              type="number"
              step="any"
              min={1}
              required
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder={unit === 'kg' ? '82.5' : '182'}
            />
          </label>
          <label className="field">
            <span>Body fat % (optional)</span>
            <input
              type="number"
              step="any"
              min={0}
              max={100}
              value={bodyFat}
              onChange={(e) => setBodyFat(e.target.value)}
            />
          </label>
          <label className="field field-wide">
            <span>Note (optional)</span>
            <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
          </label>
          <div className="form-actions">
            <button type="submit" className="button button-primary" disabled={log.isPending || !value}>
              {log.isPending ? 'Saving…' : 'Save'}
            </button>
            <span className="muted small">One entry per day — saving again replaces it.</span>
          </div>
        </form>
        <ErrorNote error={log.error} />
      </Card>

      <Card
        title="Trend"
        action={
          <div className="segmented segmented-small">
            {RANGES.map((r) => (
              <button
                key={r.label}
                type="button"
                className={rangeDays === r.days ? 'active' : ''}
                onClick={() => setRangeDays(r.days)}
              >
                {r.label}
              </button>
            ))}
          </div>
        }
      >
        {entries.isLoading && <Spinner />}
        <ErrorNote error={entries.error} />
        {series.length === 0 ? (
          <p className="empty">No entries in this range.</p>
        ) : (
          <>
            <div className="chart">
              <ResponsiveContainer width="100%" height={260}>
                <LineChart data={series} margin={{ top: 8, right: 8, bottom: 0, left: -12 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--line)" />
                  <XAxis dataKey="date" stroke="var(--muted)" fontSize={12} tickMargin={8} />
                  <YAxis
                    stroke="var(--muted)"
                    fontSize={12}
                    width={56}
                    domain={['dataMin - 1', 'dataMax + 1']}
                  />
                  <Tooltip
                    contentStyle={{
                      background: 'var(--surface)',
                      border: '1px solid var(--line)',
                      borderRadius: 8,
                      color: 'var(--text)',
                    }}
                  />
                  {targetLine != null && (
                    <ReferenceLine
                      y={targetLine}
                      stroke="var(--accent-3)"
                      strokeDasharray="4 4"
                      label={{ value: 'Target', fill: 'var(--muted)', fontSize: 11, position: 'right' }}
                    />
                  )}
                  <Line
                    type="monotone"
                    dataKey="value"
                    name={unit}
                    stroke="var(--accent-2)"
                    strokeWidth={2}
                    dot={{ r: 2 }}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>

            {stats.data && (
              <dl className="stat-grid">
                <div>
                  <dt>Latest</dt>
                  <dd>{display(stats.data.latest_kg)}</dd>
                </div>
                <div>
                  <dt>Change</dt>
                  <dd className={(stats.data.change_kg ?? 0) <= 0 ? 'good' : 'over'}>
                    {stats.data.change_kg == null
                      ? '—'
                      : `${signed(unit === 'kg' ? stats.data.change_kg : kgToLb(stats.data.change_kg))} ${unit}`}
                  </dd>
                </div>
                <div>
                  <dt>7-entry avg</dt>
                  <dd>{display(stats.data.moving_average_7_kg)}</dd>
                </div>
                <div>
                  <dt>Entries</dt>
                  <dd>{stats.data.count}</dd>
                </div>
              </dl>
            )}
          </>
        )}
      </Card>

      <Card title="History">
        {entries.data?.length === 0 && <p className="empty">Nothing yet.</p>}
        <ul className="entry-list">
          {entries.data?.map((entry) => (
            <li key={entry.id} className="entry">
              <div className="entry-main">
                <span className="entry-name">{display(entry.weight_kg)}</span>
                <span className="muted small">
                  {prettyDate(entry.recorded_on)}
                  {entry.body_fat_pct != null ? ` · ${round(entry.body_fat_pct)}% body fat` : ''}
                  {entry.note ? ` · ${entry.note}` : ''}
                </span>
              </div>
              <button
                type="button"
                className="icon-button"
                aria-label={`Delete entry for ${entry.recorded_on}`}
                onClick={() => remove.mutate(entry.id)}
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  )
}
