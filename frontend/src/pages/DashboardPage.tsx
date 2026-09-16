import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'

import { api } from '../api/endpoints'
import { useAuth } from '../lib/auth'
import { addDays, kcal, kg, shortDate, signed, today } from '../lib/format'
import { Card, ErrorNote, MacroRow, Spinner, TargetList } from '../components/ui'

export default function DashboardPage() {
  const { user } = useAuth()
  const to = today()
  const from = addDays(to, -29)

  const day = useQuery({ queryKey: ['diary', 'day', to], queryFn: () => api.diaryDay(to) })
  const summary = useQuery({
    queryKey: ['diary', 'summary', from, to],
    queryFn: () => api.diarySummary(from, to),
  })
  const weights = useQuery({
    queryKey: ['weights', from, to],
    queryFn: () => api.listWeights({ from, to }),
  })
  const stats = useQuery({ queryKey: ['weights', 'stats', from, to], queryFn: () => api.weightStats({ from, to }) })

  const calorieStatus = day.data?.targets.find((t) => t.nutrient === 'calories_kcal')

  // recharts wants oldest-first; the API returns newest-first for list views.
  const weightSeries = (weights.data ?? [])
    .slice()
    .reverse()
    .map((w) => ({ date: shortDate(w.recorded_on), kg: w.weight_kg }))

  const calorieSeries = (summary.data?.days ?? []).map((d) => ({
    date: shortDate(d.date),
    kcal: Math.round(d.total.calories_kcal),
  }))

  return (
    <div className="page">
      <div className="page-head">
        <h1>Today</h1>
        <span className="muted">Hi {user?.display_name.split(' ')[0]} 👋</span>
      </div>

      <div className="grid">
        <Card
          title="Today's intake"
          action={
            <Link className="button button-small" to="/diary">
              Open diary
            </Link>
          }
        >
          {day.isLoading && <Spinner />}
          <ErrorNote error={day.error} />
          {day.data && (
            <>
              <div className="big-number">
                <strong>{kcal(day.data.total.calories_kcal)}</strong>
                {calorieStatus && (
                  <span className={calorieStatus.status === 'over' ? 'muted over' : 'muted'}>
                    {calorieStatus.status === 'over'
                      ? `${kcal(Math.abs(calorieStatus.remaining))} over`
                      : `${kcal(calorieStatus.remaining)} left`}
                  </span>
                )}
              </div>
              <TargetList targets={day.data.targets} />
            </>
          )}
        </Card>

        <Card
          title="Weight"
          action={
            <Link className="button button-small" to="/weight">
              Log weight
            </Link>
          }
        >
          {stats.isLoading && <Spinner />}
          <ErrorNote error={stats.error} />
          {stats.data && stats.data.count > 0 ? (
            <>
              <div className="big-number">
                <strong>{kg(stats.data.latest_kg)}</strong>
                <span className={(stats.data.change_kg ?? 0) <= 0 ? 'muted good' : 'muted over'}>
                  {signed(stats.data.change_kg)} kg in 30 days
                </span>
              </div>
              <dl className="stat-grid">
                <div>
                  <dt>7-entry avg</dt>
                  <dd>{kg(stats.data.moving_average_7_kg)}</dd>
                </div>
                <div>
                  <dt>Range</dt>
                  <dd>
                    {kg(stats.data.min_kg)} – {kg(stats.data.max_kg)}
                  </dd>
                </div>
                <div>
                  <dt>Target</dt>
                  <dd>{kg(user?.target_weight_kg)}</dd>
                </div>
              </dl>
            </>
          ) : (
            <p className="empty">
              No weigh-ins in the last 30 days. <Link to="/weight">Log one</Link>.
            </p>
          )}
        </Card>
      </div>

      <Card title="Calories, last 30 days">
        {summary.isLoading && <Spinner />}
        <ErrorNote error={summary.error} />
        {calorieSeries.length === 0 ? (
          <p className="empty">Nothing logged in this window yet.</p>
        ) : (
          <>
            <div className="chart">
              <ResponsiveContainer width="100%" height={220}>
                <LineChart data={calorieSeries} margin={{ top: 8, right: 8, bottom: 0, left: -12 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--line)" />
                  <XAxis dataKey="date" stroke="var(--muted)" fontSize={12} tickMargin={8} />
                  <YAxis stroke="var(--muted)" fontSize={12} width={52} />
                  <Tooltip
                    contentStyle={{
                      background: 'var(--surface)',
                      border: '1px solid var(--line)',
                      borderRadius: 8,
                      color: 'var(--text)',
                    }}
                  />
                  <Line
                    type="monotone"
                    dataKey="kcal"
                    stroke="var(--accent)"
                    strokeWidth={2}
                    dot={{ r: 2 }}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
            <footer className="card-foot">
              <span className="muted small">
                Average over {summary.data?.logged_day_count} logged day
                {summary.data?.logged_day_count === 1 ? '' : 's'}:
              </span>
              {summary.data && <MacroRow n={summary.data.average} compact />}
            </footer>
          </>
        )}
      </Card>

      <Card title="Weight trend, last 30 days">
        {weights.isLoading && <Spinner />}
        <ErrorNote error={weights.error} />
        {weightSeries.length === 0 ? (
          <p className="empty">No weigh-ins yet.</p>
        ) : (
          <div className="chart">
            <ResponsiveContainer width="100%" height={220}>
              <LineChart data={weightSeries} margin={{ top: 8, right: 8, bottom: 0, left: -12 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--line)" />
                <XAxis dataKey="date" stroke="var(--muted)" fontSize={12} tickMargin={8} />
                <YAxis
                  stroke="var(--muted)"
                  fontSize={12}
                  width={52}
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
                <Line
                  type="monotone"
                  dataKey="kg"
                  stroke="var(--accent-2)"
                  strokeWidth={2}
                  dot={{ r: 2 }}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}
      </Card>
    </div>
  )
}
