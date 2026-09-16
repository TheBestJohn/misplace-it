import type { ReactNode } from 'react'

import type { Nutrients } from '../api/types'
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

/** Progress toward a daily target; renders a plain total when none is set. */
export function TargetBar({
  label,
  value,
  target,
  unit = 'g',
  tone = 'p',
}: {
  label: string
  value: number
  target: number | null | undefined
  unit?: string
  tone?: 'kcal' | 'p' | 'c' | 'f'
}) {
  const pct = target && target > 0 ? Math.min(100, (value / target) * 100) : 0
  const over = target != null && target > 0 && value > target

  return (
    <div className="target">
      <div className="target-head">
        <span>{label}</span>
        <span className="target-value">
          {round(value)}
          {unit}
          {target ? (
            <span className="muted">
              {' '}
              / {round(target)}
              {unit}
            </span>
          ) : null}
        </span>
      </div>
      <div className="bar" role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
        <div className={`bar-fill bar-${tone} ${over ? 'bar-over' : ''}`} style={{ width: `${pct}%` }} />
      </div>
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
