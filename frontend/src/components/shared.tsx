import { Link } from 'react-router-dom'
import { Loader2, TriangleAlert } from 'lucide-react'
import type { ReactNode } from 'react'

import type { Nutrients, TargetProgress } from '@/api/types'
import { kcal, round } from '@/lib/format'
import { cn } from '@/lib/utils'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Progress } from '@/components/ui/progress'

export function Spinner({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="text-muted-foreground flex items-center gap-2 py-2 text-sm" role="status">
      <Loader2 className="size-4 animate-spin" />
      <span>{label}</span>
    </div>
  )
}

export function ErrorNote({ error }: { error: unknown }) {
  if (!error) return null
  const message = error instanceof Error ? error.message : String(error)
  return (
    <Alert variant="destructive">
      <TriangleAlert />
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  )
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="text-muted-foreground py-2 text-sm">{children}</p>
}

/**
 * The macro readout. One component everywhere a nutrient total appears, which
 * is what makes a recipe, a diary entry and a whole day read alike.
 */
export function MacroRow({
  n,
  compact = false,
  className,
}: {
  n: Nutrients
  compact?: boolean
  className?: string
}) {
  return (
    <div
      className={cn(
        'tabular flex flex-wrap items-baseline gap-x-3 gap-y-1',
        compact ? 'text-xs' : 'text-sm',
        className,
      )}
    >
      <span className={cn('text-foreground font-semibold', compact ? 'text-sm' : 'text-base')}>
        {kcal(n.calories_kcal)}
      </span>
      <span className="text-protein">P {round(n.protein_g)}g</span>
      <span className="text-carbs">C {round(n.carbs_g)}g</span>
      <span className="text-fat">F {round(n.fat_g)}g</span>
    </div>
  )
}

/** Nutrient hue for a bar, matching the figure it belongs to. */
const TONE: Record<string, string> = {
  calories_kcal: 'bg-kcal',
  protein_g: 'bg-protein',
  carbs_g: 'bg-carbs',
  fat_g: 'bg-fat',
}

/**
 * Progress against one target, read in that target's own direction.
 *
 * A budget and a goal are the same arithmetic with opposite meanings: 120% of
 * a calorie budget is a problem, 120% of a protein goal is a success. So only
 * a blown budget turns red, a met goal turns green, and the caption reads
 * "left" for a budget and "to go" for a goal.
 */
export function TargetBar({ target }: { target: TargetProgress }) {
  const { kind, status, percent, amount, consumed, remaining, unit, label } = target
  const over = status === 'over'
  const met = status === 'met'

  const caption = over
    ? `${round(Math.abs(remaining))}${unit} over`
    : met
      ? 'goal met'
      : kind === 'budget'
        ? `${round(remaining)}${unit} left`
        : `${round(remaining)}${unit} to go`

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-3 text-sm">
        {/* No kind badge: the caption below already says "left" for a budget
            and "to go" for a goal, and only a budget ever turns red. The badge
            repeated that in a third place. */}
        <span>{label}</span>
        <span className="tabular whitespace-nowrap">
          {round(consumed)}
          <span className="text-muted-foreground">
            {' / '}
            {round(amount)}
            {unit}
          </span>
        </span>
      </div>
      <Progress
        value={Math.min(100, percent)}
        aria-label={`${label} ${kind}`}
        indicatorClassName={cn(over ? 'bg-destructive' : met ? 'bg-success' : TONE[target.nutrient] ?? 'bg-primary')}
      />
      <span
        className={cn(
          'text-xs',
          over ? 'text-destructive' : met ? 'text-success' : 'text-muted-foreground',
        )}
      >
        {caption}
      </span>
    </div>
  )
}

export function TargetList({ targets }: { targets: TargetProgress[] }) {
  if (targets.length === 0) {
    return (
      <Alert>
        <AlertDescription>
          No goals or budgets set yet —{' '}
          <Link to="/settings" className="text-primary font-medium underline underline-offset-4">
            add them in Settings
          </Link>{' '}
          to track progress.
        </AlertDescription>
      </Alert>
    )
  }
  return (
    <div className="space-y-3">
      {targets.map((t) => (
        <TargetBar key={t.nutrient} target={t} />
      ))}
    </div>
  )
}

export function SourceBadge({ source }: { source: string }) {
  const label = source === 'usda' ? 'USDA' : source === 'off' ? 'OFF' : 'Custom'
  return (
    <Badge variant="outline" className="text-[10px] tracking-wide uppercase">
      {label}
    </Badge>
  )
}
