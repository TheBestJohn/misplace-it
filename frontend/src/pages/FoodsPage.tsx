import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus, X } from 'lucide-react'

import { api } from '@/api/endpoints'
import type { ExternalFood, Food } from '@/api/types'
import { useAuth } from '@/lib/auth'
import { grams, kcal, round, sourceLabel } from '@/lib/format'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Empty, ErrorNote, SourceBadge, Spinner } from '@/components/shared'
import FoodForm from '@/components/FoodForm'

export default function FoodsPage() {
  const { user } = useAuth()
  const queryClient = useQueryClient()
  const [term, setTerm] = useState('')
  const [debounced, setDebounced] = useState('')
  const [mineOnly, setMineOnly] = useState(false)
  const [editing, setEditing] = useState<Food | 'new' | null>(null)
  const [barcode, setBarcode] = useState('')
  const [submittedBarcode, setSubmittedBarcode] = useState('')
  const [externalTerm, setExternalTerm] = useState('')

  useEffect(() => {
    const id = setTimeout(() => setDebounced(term.trim()), 250)
    return () => clearTimeout(id)
  }, [term])

  const foods = useQuery({
    queryKey: ['foods', debounced, mineOnly],
    queryFn: () => api.listFoods({ q: debounced || undefined, mine: mineOnly, limit: 100 }),
  })

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
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['foods'] }),
  })

  const remove = useMutation({
    mutationFn: (id: string) => api.deleteFood(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['foods'] }),
  })

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Foods</h1>
        <Button size="sm" onClick={() => setEditing('new')}>
          <Plus /> Custom food
        </Button>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Look up a barcode</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault()
                setSubmittedBarcode(barcode.replace(/\D/g, ''))
              }}
            >
              <Input
                inputMode="numeric"
                placeholder="UPC / EAN, e.g. 3017624010701"
                value={barcode}
                onChange={(e) => setBarcode(e.target.value)}
              />
              <Button type="submit">Look up</Button>
            </form>
            {lookup.isFetching && <Spinner label="Looking up…" />}
            <ErrorNote error={lookup.error} />
            {lookup.data?.local && (
              <Alert>
                <AlertDescription>
                  Already in the database: <strong>{lookup.data.local.name}</strong>
                </AlertDescription>
              </Alert>
            )}
            {lookup.data?.external && !lookup.data.local && (
              <div className="flex items-center gap-3 rounded-md border px-3 py-2 text-sm">
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{lookup.data.external.name}</span>
                  <span className="text-muted-foreground block truncate text-xs">
                    {lookup.data.external.brand ? `${lookup.data.external.brand} · ` : ''}
                    {sourceLabel(lookup.data.external.source)} ·{' '}
                    {kcal(lookup.data.external.calories_kcal)} / 100 g
                  </span>
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={importFood.isPending}
                  onClick={() => importFood.mutate(lookup.data!.external!)}
                >
                  Import
                </Button>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Search USDA &amp; Open Food Facts</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <Input
              placeholder="e.g. greek yogurt"
              value={externalTerm}
              onChange={(e) => setExternalTerm(e.target.value)}
            />
            {external.isFetching && <Spinner label="Searching…" />}
            <ErrorNote error={external.error} />
            <ErrorNote error={importFood.error} />
            {external.data?.unavailable.map((reason) => (
              <Alert variant="warning" key={reason}>
                <AlertDescription>{reason}</AlertDescription>
              </Alert>
            ))}
            <div className="max-h-64 space-y-1.5 overflow-y-auto">
              {external.data?.results.map((food) => (
                <div
                  key={`${food.source}-${food.source_id}`}
                  className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{food.name}</span>
                    <span className="text-muted-foreground block truncate text-xs">
                      {food.brand ? `${food.brand} · ` : ''}
                      {kcal(food.calories_kcal)} / 100 g
                    </span>
                  </span>
                  <SourceBadge source={food.source} />
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={importFood.isPending}
                    onClick={() => importFood.mutate(food)}
                  >
                    Import
                  </Button>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Food database</CardTitle>
          <CardDescription>
            Shared by everyone — a food is a fact about a product. Only its author can edit it.
          </CardDescription>
          <CardAction>
            <Label className="text-muted-foreground text-sm font-normal">
              <Switch checked={mineOnly} onCheckedChange={setMineOnly} />
              Mine only
            </Label>
          </CardAction>
        </CardHeader>
        <CardContent className="space-y-3">
          <Input
            placeholder="Filter foods…"
            value={term}
            onChange={(e) => setTerm(e.target.value)}
          />
          {foods.isLoading && <Spinner />}
          <ErrorNote error={foods.error} />
          <ErrorNote error={remove.error} />
          {foods.data?.length === 0 && <Empty>Nothing matches.</Empty>}

          {foods.data && foods.data.length > 0 && (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead className="text-right">kcal</TableHead>
                  <TableHead className="text-right">P</TableHead>
                  <TableHead className="text-right">C</TableHead>
                  <TableHead className="text-right">F</TableHead>
                  <TableHead>Serving</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {foods.data.map((food) => (
                  <TableRow key={food.id}>
                    <TableCell className="max-w-[16rem] whitespace-normal">
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{food.name}</span>
                        <SourceBadge source={food.source} />
                        {food.created_by === user?.id && (
                          <Badge variant="secondary" className="text-[10px]">
                            Yours
                          </Badge>
                        )}
                      </div>
                      {food.brand && (
                        <span className="text-muted-foreground text-xs">{food.brand}</span>
                      )}
                    </TableCell>
                    <TableCell className="tabular text-right">{round(food.calories_kcal)}</TableCell>
                    <TableCell className="tabular text-right">{round(food.protein_g)}</TableCell>
                    <TableCell className="tabular text-right">{round(food.carbs_g)}</TableCell>
                    <TableCell className="tabular text-right">{round(food.fat_g)}</TableCell>
                    <TableCell className="text-muted-foreground text-xs">
                      {grams(food.serving_size_g, 0)}
                      {food.serving_label ? ` · ${food.serving_label}` : ''}
                    </TableCell>
                    <TableCell className="text-right">
                      {food.created_by === user?.id && (
                        <div className="flex justify-end gap-1">
                          <Button variant="ghost" size="sm" onClick={() => setEditing(food)}>
                            Edit
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label={`Delete ${food.name}`}
                            onClick={() => remove.mutate(food.id)}
                          >
                            <X />
                          </Button>
                        </div>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          <p className="text-muted-foreground text-xs">All figures are per 100 g.</p>
        </CardContent>
      </Card>

      <Dialog open={editing !== null} onOpenChange={(open) => !open && setEditing(null)}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{editing === 'new' ? 'New custom food' : 'Edit food'}</DialogTitle>
            <DialogDescription>
              Visible to everyone once saved. Only you can edit it.
            </DialogDescription>
          </DialogHeader>
          {editing && (
            <FoodForm
              food={editing === 'new' ? null : editing}
              onSaved={() => setEditing(null)}
              onCancel={() => setEditing(null)}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
