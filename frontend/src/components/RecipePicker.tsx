import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Globe } from 'lucide-react'

import { api } from '@/api/endpoints'
import type { RecipeSummary } from '@/api/types'
import { kcal } from '@/lib/format'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Empty, ErrorNote, Spinner } from '@/components/shared'

/**
 * Pick a recipe to use as an ingredient of another.
 *
 * Scoped to `all` — your own recipes plus everyone's shared ones — which is the
 * same set you can already open and log. The recipe being edited is excluded
 * because it obviously cannot contain itself; a deeper loop is left to the
 * server, which is the only side that can see the whole graph.
 */
export default function RecipePicker({
  excludeId,
  onPick,
}: {
  excludeId?: string
  onPick: (recipe: RecipeSummary) => void
}) {
  const [term, setTerm] = useState('')
  const [debounced, setDebounced] = useState('')

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(term.trim()), 200)
    return () => clearTimeout(timer)
  }, [term])

  const recipes = useQuery({
    queryKey: ['recipes', 'picker', debounced],
    queryFn: () => api.listRecipes({ q: debounced || undefined, scope: 'all' }),
  })

  const options = (recipes.data ?? []).filter((r) => r.id !== excludeId)

  return (
    <div className="space-y-3">
      <Input
        autoFocus
        placeholder="Search recipes…"
        value={term}
        onChange={(e) => setTerm(e.target.value)}
      />

      {recipes.isLoading && <Spinner />}
      <ErrorNote error={recipes.error} />
      {!recipes.isLoading && options.length === 0 && <Empty>No other recipes yet.</Empty>}

      <ul className="max-h-80 space-y-1.5 overflow-y-auto">
        {options.map((recipe) => (
          <li key={recipe.id}>
            <Button
              variant="outline"
              className="h-auto w-full justify-start py-2 text-left"
              onClick={() => onPick(recipe)}
            >
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2">
                  <span className="truncate font-medium">{recipe.name}</span>
                  {!recipe.is_owner && (
                    <Badge variant="outline" className="text-[10px]">
                      <Globe /> {recipe.author}
                    </Badge>
                  )}
                </span>
                <span className="text-muted-foreground block truncate text-xs font-normal">
                  {kcal(recipe.per_serving.calories_kcal)} per serving · makes {recipe.servings}
                </span>
              </span>
            </Button>
          </li>
        ))}
      </ul>

      <p className="text-muted-foreground text-xs">
        Added as a link, not a copy: its ingredients stay its own, and correcting it later updates
        every recipe built on it.
      </p>
    </div>
  )
}
