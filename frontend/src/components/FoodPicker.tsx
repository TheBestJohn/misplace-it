import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, Barcode, Globe, Plus, Search } from 'lucide-react'

import { api } from '@/api/endpoints'
import type { ExternalFood, Food } from '@/api/types'
import { kcal, round, sourceLabel } from '@/lib/format'
import { useFoodSearch, type SearchTier } from '@/lib/useFoodSearch'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { ErrorNote, SourceBadge, Spinner } from '@/components/shared'
import FoodForm from '@/components/FoodForm'

/** How each tier is labelled in the list. */
const TIER_LABEL: Record<SearchTier, string> = {
  exact: 'Exact match',
  prefix: 'Starts with',
  contains: 'Contains',
  fuzzy: 'Did you mean',
}

/**
 * One surface over all three food sources.
 *
 * The library tab streams from the SSE endpoint, so results appear tier by
 * tier as the server finds them rather than all at once when the slowest query
 * finishes. External hits are not foods yet — picking one imports it first
 * (idempotent on source + id) and hands back a real local food, so callers
 * never care where it came from.
 */
export default function FoodPicker({
  onPick,
  autoFocus = true,
}: {
  onPick: (food: Food) => void
  autoFocus?: boolean
}) {
  const [term, setTerm] = useState('')
  const [debounced, setDebounced] = useState('')
  const [barcode, setBarcode] = useState('')
  const [submittedBarcode, setSubmittedBarcode] = useState('')
  const [externalTerm, setExternalTerm] = useState('')
  // When set, the picker swaps to the create form rather than opening a second
  // dialog on top of the one it is already inside.
  const [creating, setCreating] = useState<string | null>(null)
  const queryClient = useQueryClient()

  // Short debounce: the stream is fast enough that this is about not opening a
  // connection per keystroke, not about hiding latency.
  useEffect(() => {
    const id = setTimeout(() => setDebounced(term.trim()), 180)
    return () => clearTimeout(id)
  }, [term])

  const search = useFoodSearch(debounced, { limit: 8 })

  const external = useQuery({
    queryKey: ['foods', 'external', externalTerm],
    queryFn: () => api.searchExternal(externalTerm),
    enabled: externalTerm.trim().length >= 2,
  })

  const lookup = useQuery({
    queryKey: ['foods', 'barcode', submittedBarcode],
    queryFn: () => api.lookupBarcode(submittedBarcode),
    enabled: submittedBarcode.length >= 6,
    retry: false,
  })

  const importFood = useMutation({
    mutationFn: (food: ExternalFood) => api.importFood(food),
    onSuccess: (food) => {
      queryClient.invalidateQueries({ queryKey: ['foods'] })
      onPick(food)
    },
  })

  // Group by tier so the list can show why each block matched.
  const grouped = useMemo(() => {
    const out: { tier: SearchTier; foods: typeof search.results }[] = []
    for (const food of search.results) {
      const last = out[out.length - 1]
      if (last && last.tier === food.tier) last.foods.push(food)
      else out.push({ tier: food.tier, foods: [food] })
    }
    return out
  }, [search.results])

  if (creating !== null) {
    return (
      <div className="space-y-3">
        <Button variant="ghost" size="sm" className="px-0" onClick={() => setCreating(null)}>
          <ArrowLeft /> Back to search
        </Button>
        <FoodForm
          initialName={creating}
          submitLabel="Create and use"
          onCancel={() => setCreating(null)}
          // Straight into the amount step: creating the food was a detour from
          // logging it, not the goal.
          onSaved={(food) => onPick(food)}
        />
      </div>
    )
  }

  return (
    <Tabs defaultValue="library" className="gap-3">
      <TabsList className="grid w-full grid-cols-3">
        <TabsTrigger value="library">
          <Search /> Search
        </TabsTrigger>
        <TabsTrigger value="external">
          <Globe /> Databases
        </TabsTrigger>
        <TabsTrigger value="barcode">
          <Barcode /> Barcode
        </TabsTrigger>
      </TabsList>

      <TabsContent value="library" className="space-y-3">
        <Input
          placeholder="Search foods — typos are fine…"
          value={term}
          onChange={(e) => setTerm(e.target.value)}
          autoFocus={autoFocus}
        />

        {search.error && <ErrorNote error={search.error} />}

        <div className="max-h-[46vh] space-y-3 overflow-y-auto">
          {grouped.map((group) => (
            <div key={group.tier} className="space-y-1.5">
              <p className="text-muted-foreground px-1 text-[11px] font-medium tracking-wide uppercase">
                {TIER_LABEL[group.tier]}
              </p>
              {group.foods.map((food) => (
                <FoodRow key={food.id} food={food} onPick={onPick} />
              ))}
            </div>
          ))}

          {search.searching && <Spinner label="Searching…" />}

          {!search.searching && debounced && search.results.length === 0 && (
            <Alert>
              <AlertDescription className="w-full space-y-2">
                <p>
                  Nothing matched “{debounced}”. Try the <strong>Databases</strong> or{' '}
                  <strong>Barcode</strong> tab, or add it yourself.
                </p>
                <Button variant="outline" size="sm" onClick={() => setCreating(debounced)}>
                  <Plus /> Create “{debounced}”
                </Button>
              </AlertDescription>
            </Alert>
          )}

          {!debounced && (
            <p className="text-muted-foreground py-2 text-sm">Start typing to search every food.</p>
          )}
        </div>

        <div className="flex items-center justify-between gap-3">
          <Button variant="ghost" size="sm" className="px-0" onClick={() => setCreating(debounced)}>
            <Plus /> New food
          </Button>
          {search.elapsedMs !== null && search.results.length > 0 && (
            <p className="text-muted-foreground text-[11px]">
              {search.results.length} result{search.results.length === 1 ? '' : 's'} in{' '}
              {search.elapsedMs}ms
            </p>
          )}
        </div>
      </TabsContent>

      <TabsContent value="external" className="space-y-3">
        <Input
          placeholder="Search USDA and Open Food Facts…"
          value={externalTerm}
          onChange={(e) => setExternalTerm(e.target.value)}
        />
        {external.isFetching && <Spinner label="Searching food databases…" />}
        <ErrorNote error={external.error} />
        <ErrorNote error={importFood.error} />
        {external.data?.unavailable.map((reason) => (
          <Alert variant="warning" key={reason}>
            <AlertDescription>{reason}</AlertDescription>
          </Alert>
        ))}
        <div className="max-h-[46vh] space-y-1.5 overflow-y-auto">
          {external.data?.results.map((food) => (
            <button
              key={`${food.source}-${food.source_id}`}
              type="button"
              disabled={importFood.isPending}
              onClick={() => importFood.mutate(food)}
              className={rowClass}
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{food.name}</span>
                <span className="text-muted-foreground block truncate text-xs">
                  {food.brand ? `${food.brand} · ` : ''}
                  {kcal(food.calories_kcal)} / 100 g · P {round(food.protein_g)} C{' '}
                  {round(food.carbs_g)} F {round(food.fat_g)}
                </span>
              </span>
              <SourceBadge source={food.source} />
            </button>
          ))}
          {external.data?.results.length === 0 && !external.isFetching && (
            <p className="text-muted-foreground py-2 text-sm">No matches.</p>
          )}
        </div>
      </TabsContent>

      <TabsContent value="barcode" className="space-y-3">
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            setSubmittedBarcode(barcode.replace(/\D/g, ''))
          }}
        >
          <Input
            inputMode="numeric"
            placeholder="Scan or type a UPC / EAN"
            value={barcode}
            onChange={(e) => setBarcode(e.target.value)}
          />
          <Button type="submit">Look up</Button>
        </form>

        {lookup.isFetching && <Spinner label="Looking up barcode…" />}
        <ErrorNote error={lookup.error} />
        <ErrorNote error={importFood.error} />

        {lookup.data?.local && (
          <>
            <Alert>
              <AlertDescription>Already in the food database.</AlertDescription>
            </Alert>
            <FoodRow food={lookup.data.local} onPick={onPick} />
          </>
        )}

        {lookup.data?.external && !lookup.data.local && (
          <button
            type="button"
            disabled={importFood.isPending}
            onClick={() => importFood.mutate(lookup.data!.external!)}
            className={rowClass}
          >
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium">{lookup.data.external.name}</span>
              <span className="text-muted-foreground block truncate text-xs">
                {lookup.data.external.brand ? `${lookup.data.external.brand} · ` : ''}
                {sourceLabel(lookup.data.external.source)} ·{' '}
                {kcal(lookup.data.external.calories_kcal)} / 100 g
              </span>
            </span>
            <Badge>Import</Badge>
          </button>
        )}
      </TabsContent>
    </Tabs>
  )
}

const rowClass = cn(
  'flex w-full items-center gap-3 rounded-md border bg-card px-3 py-2 text-left text-sm',
  'hover:border-primary hover:bg-accent transition-colors',
  'focus-visible:ring-ring/50 focus-visible:ring-[3px] outline-none',
  'disabled:cursor-wait disabled:opacity-60',
)

function FoodRow({ food, onPick }: { food: Food; onPick: (food: Food) => void }) {
  return (
    <button type="button" onClick={() => onPick(food)} className={rowClass}>
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">{food.name}</span>
        <span className="text-muted-foreground block truncate text-xs">
          {food.brand ? `${food.brand} · ` : ''}
          {kcal(food.calories_kcal)} / 100 g
        </span>
      </span>
      <SourceBadge source={food.source} />
    </button>
  )
}
