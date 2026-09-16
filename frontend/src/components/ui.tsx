import type { ReactNode } from 'react'

import { Link } from 'react-router-dom'

import type { Nutrients, TargetProgress } from '../api/types'
import { kcal, round } from '../lib/format'

export function Card({
  title,
  action,
  children,
  className = '',
}: {
  title?: ReactNode
  action?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <section className={`card ${className}`}>
      {(title || action) && (
        <header className="card-head">
          {title && <h2>{title}</h2>}
          {action}
        </header>
      )}
      {children}
    </section>
  )
}

export function Spinner({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="spinner" role="status" aria-live="polite">
      <span className="spinner-dot" />
      <span>{label}</span>
    </div>
  )
}

export function ErrorNote({ error }: { error: unknown }) {
  if (!error) return null
  const message = error instanceof Error ? error.message : String(error)
  return (
    <p className="note note-error" role="alert">
      {message}
    </p>
  )
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="empty">{children}</p>
}

/**
 * Macro readout used everywhere a nutrient total is shown. Keeping it in one
 * component is what makes a recipe, a diary entry and a day all read alike.
 */
export function MacroRow({ n, compact = false }: { n: Nutrients; compact?: boolean }) {
  return (
    <div className={`macros ${compact ? 'macros-compact' : ''}`}>
      <span className="macro macro-kcal">{kcal(n.calories_kcal)}</span>
      <span className="macro macro-p">P {round(n.protein_g)}g</span>
      <span className="macro macro-c">C {round(n.carbs_g)}g</span>
      <span className="macro macro-f">F {round(n.fat_g)}g</span>
    </div>
  )
}

/** Macro colours by nutrient, so a bar matches its figure in a MacroRow. */
const TONES: Record<string, string> = {
  calories_kcal: 'kcal',
  protein_g: 'p',
  carbs_g: 'c',
  fat_g: 'f',
}

/**
 * Progress against one target, read in the target's own direction.
 *
 * A budget and a goal are the same arithmetic with opposite meanings: 120% of
 * a calorie budget is a problem, 120% of a protein goal is a success. Rendering
 * both as "percent consumed, red when over" — which is what this did before —
 * is wrong for half of them. So the bar turns red only for a blown budget, and
 * green for a goal that has been reached, and the caption says "left" for a
 * budget and "to go" for a goal.
 */
export function TargetBar({ target }: { target: TargetProgress }) {
  const { kind, status, percent, amount, consumed, remaining, unit, label } = target

  const over = status === 'over'
  const met = status === 'met'
  const tone = TONES[target.nutrient] ?? 'neutral'

  const caption = over
    ? `${round(Math.abs(remaining))}${unit} over`
    : met
      ? 'goal met'
      : kind === 'budget'
        ? `${round(remaining)}${unit} left`
        : `${round(remaining)}${unit} to go`

  return (
    <div className="target">
      <div className="target-head">
        <span className="target-label">
          {label}
          <span className={`kind-tag kind-${kind}`}>{kind}</span>
        </span>
        <span className="target-value">
          {round(consumed)}
          <span className="muted">
            {' / '}
            {round(amount)}
            {unit}
          </span>
        </span>
      </div>
      <div
        className="bar"
        role="progressbar"
        aria-label={`${label} ${kind}`}
        aria-valuenow={Math.round(percent)}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div
          className={`bar-fill bar-${tone} ${over ? 'bar-over' : ''} ${met ? 'bar-met' : ''}`}
          style={{ width: `${Math.min(100, percent)}%` }}
        />
      </div>
      <span className={`target-caption ${over ? 'over' : met ? 'good' : 'muted'}`}>{caption}</span>
    </div>
  )
}

/** The set of targets for a day, or a prompt to set some. */
export function TargetList({ targets }: { targets: TargetProgress[] }) {
  if (targets.length === 0) {
    return (
      <p className="note">
        No goals or budgets set yet — <Link to="/settings">add them in Settings</Link> to track
        progress.
      </p>
    )
  }
  return (
    <div className="targets">
      {targets.map((t) => (
        <TargetBar key={t.nutrient} target={t} />
      ))}
    </div>
  )
}

export function SourceBadge({ source }: { source: string }) {
  const label = source === 'usda' ? 'USDA' : source === 'off' ? 'OFF' : 'Custom'
  return <span className={`badge badge-${source}`}>{label}</span>
}

export function Modal({
  title,
  onClose,
  children,
  wide = false,
}: {
  title: string
  onClose: () => void
  children: ReactNode
  wide?: boolean
}) {
  return (
    <div
      className="modal-backdrop"
      onClick={onClose}
      role="presentation"
    >
      <div
        className={`modal ${wide ? 'modal-wide' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="modal-head">
          <h2>{title}</h2>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  )
}
