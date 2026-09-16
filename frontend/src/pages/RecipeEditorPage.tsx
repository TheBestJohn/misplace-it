import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, Globe, Plus, X } from 'lucide-react'

import { api } from '@/api/endpoints'
import type { RecipeInput } from '@/api/endpoints'
import type { Food, Nutrients } from '@/api/types'
import { grams, kcal, round } from '@/lib/format'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import FoodPicker from '@/components/FoodPicker'
import { Empty, ErrorNote, MacroRow, Spinner } from '@/components/shared'

/** An ingredient being edited, carrying per-100g figures for live totals. */
interface DraftItem {
  key: string
  food_id: string
  name: string
  brand: string | null
  quantity_g: number
  per100: Pick<Food, 'calories_kcal' | 'protein_g' | 'carbs_g' | 'fat_g'>
}

const ZERO: Nutrients = {
  calories_kcal: 0,
  protein_g: 0,
  carbs_g: 0,
  fat_g: 0,
  fiber_g: 0,
  sugar_g: 0,
  saturated_fat_g: 0,
  sodium_mg: 0,
}

export default function RecipeEditorPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const isNew = !id

  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [instructions, setInstructions] = useState('')
  const [servings, setServings] = useState('1')
  const [isPublic, setIsPublic] = useState(false)
  const [items, setItems] = useState<DraftItem[]>([])
  const [picking, setPicking] = useState(false)

  const existing = useQuery({
    queryKey: ['recipes', id],
    queryFn: () => api.getRecipe(id!),
    enabled: !isNew,
  })

  const readOnly = !isNew && existing.data ? !existing.data.is_owner : false

  // Hydrate once the recipe arrives. Per-100g figures are recovered from the
  // stored per-item totals, so the live arithmetic below stays accurate.
  useEffect(() => {
    const recipe = existing.data
    if (!recipe) return
    setName(recipe.name)
    setDescription(recipe.description ?? '')
    setInstructions(recipe.instructions ?? '')
    setServings(String(recipe.servings))
    setIsPublic(recipe.is_public)
    setItems(
      recipe.items.map((item) => ({
        key: item.id,
        food_id: item.food_id,
        name: item.food_name,
        brand: item.food_brand,
        quantity_g: item.quantity_g,
        per100: {
          calories_kcal: (item.nutrients.calories_kcal / item.quantity_g) * 100,
          protein_g: (item.nutrients.protein_g / item.quantity_g) * 100,
          carbs_g: (item.nutrients.carbs_g / item.quantity_g) * 100,
          fat_g: (item.nutrients.fat_g / item.quantity_g) * 100,
        },
      })),
    )
  }, [existing.data])

  const save = useMutation({
    mutationFn: () => {
      const payload: RecipeInput = {
        name,
        description: description || null,
        instructions: instructions || null,
        servings: Number(servings),
        is_public: isPublic,
        items: items.map((i) => ({ food_id: i.food_id, quantity_g: i.quantity_g })),
      }
      return isNew ? api.createRecipe(payload) : api.updateRecipe(id!, payload)
    },
    onSuccess: (recipe) => {
      queryClient.invalidateQueries({ queryKey: ['recipes'] })
      navigate(`/recipes/${recipe.id}`, { replace: true })
    },
  })

  const servingCount = Number(servings) > 0 ? Number(servings) : 1

  // Totals recompute as you type, using the same grams/100 scaling the server
  // applies on save — so what is shown is what gets stored.
  const total: Nutrients = items.reduce<Nutrients>((acc, item) => {
    const f = item.quantity_g / 100
    return {
      ...acc,
      calories_kcal: acc.calories_kcal + item.per100.calories_kcal * f,
      protein_g: acc.protein_g + item.per100.protein_g * f,
      carbs_g: acc.carbs_g + item.per100.carbs_g * f,
      fat_g: acc.fat_g + item.per100.fat_g * f,
    }
  }, ZERO)

  const perServing: Nutrients = {
    ...total,
    calories_kcal: total.calories_kcal / servingCount,
    protein_g: total.protein_g / servingCount,
    carbs_g: total.carbs_g / servingCount,
    fat_g: total.fat_g / servingCount,
  }

  const totalWeight = items.reduce((sum, i) => sum + i.quantity_g, 0)

  const addFood = (food: Food) => {
    setItems((prev) => [
      ...prev,
      {
        key: `${food.id}-${Date.now()}`,
        food_id: food.id,
        name: food.name,
        brand: food.brand,
        quantity_g: food.serving_size_g,
        per100: {
          calories_kcal: food.calories_kcal,
          protein_g: food.protein_g,
          carbs_g: food.carbs_g,
          fat_g: food.fat_g,
        },
      },
    ])
    setPicking(false)
  }

  if (!isNew && existing.isLoading) return <Spinner />

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">
          {isNew ? 'New recipe' : readOnly ? name : 'Edit recipe'}
        </h1>
        <Button variant="ghost" size="sm" onClick={() => navigate('/recipes')}>
          <ArrowLeft /> Back
        </Button>
      </div>

      <ErrorNote error={existing.error} />

      {readOnly && (
        <Alert>
          <Globe />
          <AlertDescription>
            Shared by {existing.data?.author}. You can view it and log it, but only its author can
            change it.
          </AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Details</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-3">
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="r-name">Name</Label>
            <Input
              id="r-name"
              required
              disabled={readOnly}
              autoFocus={isNew}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="r-servings">Servings</Label>
            <Input
              id="r-servings"
              type="number"
              min={0.1}
              step="any"
              disabled={readOnly}
              value={servings}
              onChange={(e) => setServings(e.target.value)}
            />
          </div>
          <div className="space-y-1.5 sm:col-span-3">
            <Label htmlFor="r-desc">Description</Label>
            <Input
              id="r-desc"
              disabled={readOnly}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          <div className="space-y-1.5 sm:col-span-3">
            <Label htmlFor="r-inst">Instructions</Label>
            <Textarea
              id="r-inst"
              rows={5}
              disabled={readOnly}
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
            />
          </div>

          {!readOnly && (
            <div className="flex items-start gap-3 rounded-md border p-3 sm:col-span-3">
              <Switch
                id="r-public"
                checked={isPublic}
                onCheckedChange={setIsPublic}
                className="mt-0.5"
              />
              <div>
                <Label htmlFor="r-public">Share this recipe</Label>
                <p className="text-muted-foreground text-xs">
                  Recipes are private by default. Sharing lets every account read and log this one;
                  only you can edit it.
                </p>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Ingredients</CardTitle>
          {!readOnly && (
            <CardAction>
              <Button variant="outline" size="sm" onClick={() => setPicking(true)}>
                <Plus /> Add ingredient
              </Button>
            </CardAction>
          )}
        </CardHeader>
        <CardContent>
          {items.length === 0 ? (
            <Empty>No ingredients yet.</Empty>
          ) : (
            <ul className="divide-y">
              {items.map((item, index) => (
                <li key={item.key} className="flex items-center gap-3 py-2.5">
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{item.name}</p>
                    {item.brand && (
                      <p className="text-muted-foreground truncate text-xs">{item.brand}</p>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5">
                    <Input
                      type="number"
                      min={0.1}
                      step="any"
                      disabled={readOnly}
                      className="tabular w-20 text-right"
                      aria-label={`${item.name} grams`}
                      value={item.quantity_g}
                      onChange={(e) =>
                        setItems((prev) =>
                          prev.map((it, i) =>
                            i === index ? { ...it, quantity_g: Number(e.target.value) } : it,
                          ),
                        )
                      }
                    />
                    <span className="text-muted-foreground text-xs">g</span>
                  </div>
                  <span className="text-muted-foreground tabular w-20 text-right text-xs">
                    {kcal((item.per100.calories_kcal * item.quantity_g) / 100)}
                  </span>
                  {!readOnly && (
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Remove ${item.name}`}
                      onClick={() => setItems((prev) => prev.filter((_, i) => i !== index))}
                    >
                      <X />
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Nutrition</CardTitle>
          <CardDescription>Recomputed as you edit, the same way the server does.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1">
            <p className="text-muted-foreground text-xs">
              Whole recipe · {grams(totalWeight, 0)}
            </p>
            <MacroRow n={total} />
          </div>
          <div className="space-y-1">
            <p className="text-muted-foreground text-xs">
              Per serving ({round(servingCount, 2)} servings)
            </p>
            <MacroRow n={perServing} />
          </div>
        </CardContent>
      </Card>

      {!readOnly && (
        <>
          <ErrorNote error={save.error} />
          <div className="flex flex-wrap items-center gap-3">
            <Button
              disabled={save.isPending || !name || items.length === 0}
              onClick={() => save.mutate()}
            >
              {save.isPending ? 'Saving…' : isNew ? 'Create recipe' : 'Save changes'}
            </Button>
            {items.length === 0 && (
              <span className="text-muted-foreground text-xs">Add at least one ingredient.</span>
            )}
          </div>
        </>
      )}

      <Dialog open={picking} onOpenChange={setPicking}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Add ingredient</DialogTitle>
          </DialogHeader>
          <FoodPicker onPick={addFood} />
        </DialogContent>
      </Dialog>
    </div>
  )
}
