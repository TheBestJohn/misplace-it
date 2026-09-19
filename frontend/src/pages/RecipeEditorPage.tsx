import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, ExternalLink, Globe, Plus, X } from 'lucide-react'

import { api } from '@/api/endpoints'
import type { RecipeInput } from '@/api/endpoints'
import type { Food, Nutrients, RecipeSummary } from '@/api/types'
import { grams, kcal, round } from '@/lib/format'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import FoodPicker from '@/components/FoodPicker'
import RecipePicker from '@/components/RecipePicker'
import { Empty, ErrorNote, MacroRow, Spinner } from '@/components/shared'

/** The four figures the live totals below need. */
type Macros = Pick<Nutrients, 'calories_kcal' | 'protein_g' | 'carbs_g' | 'fat_g'>

/**
 * An ingredient being edited.
 *
 * Both kinds are held as an amount times a per-unit figure — grams of a food,
 * or servings of a recipe — so the running totals are one multiplication and
 * never have to ask which kind a row is.
 */
interface DraftItem {
  key: string
  kind: 'food' | 'recipe' | 'text'
  /** The food id or the sub-recipe id. Empty for a free-text ingredient,
   *  which points at nothing — that is what makes it free text. */
  refId: string
  name: string
  brand: string | null
  /** Grams for a food, servings for a recipe. */
  amount: number
  /** Nutrients in one gram of the food, or one serving of the recipe. */
  perUnit: Macros
  /** Grams in one unit: 1 for a food, and a serving's weight for a recipe. */
  gramsPerUnit: number
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

/**
 * Add an ingredient that is only words.
 *
 * Its own component so the input has its own state: typing here must not
 * re-render the ingredient list on every keystroke, and a component declared
 * inside the page body would be a new type on every render and lose focus.
 */
function TextIngredientForm({ onAdd }: { onAdd: (label: string) => void }) {
  const [text, setText] = useState('')
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault()
        if (text.trim()) onAdd(text.trim())
        setText('')
      }}
    >
      <div className="space-y-1.5">
        <Label htmlFor="r-freetext">Ingredient</Label>
        <Input
          id="r-freetext"
          autoFocus
          placeholder="e.g. salt and pepper to taste"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
      </div>
      <Button type="submit" disabled={!text.trim()}>
        <Plus /> Add
      </Button>
      <p className="text-muted-foreground text-xs">
        For the things not worth a database entry — a pinch of salt, a squeeze of lemon. It
        contributes nothing to the macros, and the recipe says how many of these it has so the
        totals are never quietly short.
      </p>
    </form>
  )
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
      recipe.items.map((item) => {
        // The server sends each item's contribution already scaled, so dividing
        // by the amount recovers the per-unit figure whichever kind it is.
        const amount = item.quantity_g ?? item.servings ?? 1
        return {
          key: item.id,
          kind: item.label
            ? ('text' as const)
            : item.sub_recipe_id
              ? ('recipe' as const)
              : ('food' as const),
          refId: item.sub_recipe_id ?? item.food_id ?? '',
          name: item.name,
          brand: item.brand,
          amount,
          perUnit: {
            calories_kcal: item.nutrients.calories_kcal / amount,
            protein_g: item.nutrients.protein_g / amount,
            carbs_g: item.nutrients.carbs_g / amount,
            fat_g: item.nutrients.fat_g / amount,
          },
          gramsPerUnit: item.weight_g / amount,
        }
      }),
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
        items: items.map((i) => {
          if (i.kind === 'food') return { food_id: i.refId, quantity_g: i.amount }
          if (i.kind === 'recipe') return { sub_recipe_id: i.refId, servings: i.amount }
          return { label: i.name }
        }),
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
  const total: Nutrients = items.reduce<Nutrients>(
    (acc, item) => ({
      ...acc,
      calories_kcal: acc.calories_kcal + item.perUnit.calories_kcal * item.amount,
      protein_g: acc.protein_g + item.perUnit.protein_g * item.amount,
      carbs_g: acc.carbs_g + item.perUnit.carbs_g * item.amount,
      fat_g: acc.fat_g + item.perUnit.fat_g * item.amount,
    }),
    ZERO,
  )

  const perServing: Nutrients = {
    ...total,
    calories_kcal: total.calories_kcal / servingCount,
    protein_g: total.protein_g / servingCount,
    carbs_g: total.carbs_g / servingCount,
    fat_g: total.fat_g / servingCount,
  }

  const totalWeight = items.reduce((sum, i) => sum + i.gramsPerUnit * i.amount, 0)

  // What this page can see for itself, and what the server counted through any
  // nesting. The saved figure is the honest one; the local count is what keeps
  // the warning truthful while you are still editing.
  const untrackedHere = items.filter((i) => i.kind === 'text').length
  const untracked = Math.max(untrackedHere, existing.data?.untracked_count ?? 0)

  const addFood = (food: Food) => {
    setItems((prev) => [
      ...prev,
      {
        key: `${food.id}-${Date.now()}`,
        kind: 'food',
        refId: food.id,
        name: food.name,
        brand: food.brand,
        amount: food.serving_size_g,
        // Foods are stored per 100 g; the draft works in per-gram so both kinds
        // of row share one multiplication.
        perUnit: {
          calories_kcal: food.calories_kcal / 100,
          protein_g: food.protein_g / 100,
          carbs_g: food.carbs_g / 100,
          fat_g: food.fat_g / 100,
        },
        gramsPerUnit: 1,
      },
    ])
    setPicking(false)
  }

  const addText = (label: string) => {
    setItems((prev) => [
      ...prev,
      {
        key: `text-${Date.now()}`,
        kind: 'text',
        refId: '',
        name: label,
        brand: null,
        // Nothing to scale and nothing to contribute. Carried as zeroes rather
        // than as a special case so the totals below stay one multiplication.
        amount: 0,
        perUnit: { calories_kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0 },
        gramsPerUnit: 0,
      },
    ])
    setPicking(false)
  }

  const addRecipe = (recipe: RecipeSummary) => {
    setItems((prev) => [
      ...prev,
      {
        key: `${recipe.id}-${Date.now()}`,
        kind: 'recipe',
        refId: recipe.id,
        name: recipe.name,
        brand: null,
        amount: 1,
        perUnit: recipe.per_serving,
        gramsPerUnit: recipe.total_weight_g / recipe.servings,
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
                    {item.kind === 'text' ? (
                      // Free text stays editable in place: there is no record
                      // behind it to open, and re-picking it to fix a typo
                      // would be silly.
                      <Input
                        disabled={readOnly}
                        aria-label={`Ingredient ${index + 1}`}
                        value={item.name}
                        onChange={(e) =>
                          setItems((prev) =>
                            prev.map((it, i) =>
                              i === index ? { ...it, name: e.target.value } : it,
                            ),
                          )
                        }
                      />
                    ) : item.kind === 'recipe' ? (
                      // A sub-recipe is a real thing elsewhere in the app, so
                      // its name goes where its name belongs: to it. Same tab,
                      // like the Back button — unsaved edits are lost either
                      // way, and a link that opens somewhere unexpected is
                      // worse than one that behaves like every other link.
                      <Link
                        to={`/recipes/${item.refId}`}
                        className="hover:text-primary flex items-center gap-1.5 truncate font-medium underline-offset-4 hover:underline"
                      >
                        {item.name}
                        <ExternalLink className="size-3.5 shrink-0" />
                      </Link>
                    ) : (
                      <p className="truncate font-medium">{item.name}</p>
                    )}
                    {item.kind === 'recipe' ? (
                      <p className="text-muted-foreground truncate text-xs">
                        recipe · {grams(item.gramsPerUnit * item.amount, 0)}
                      </p>
                    ) : item.kind === 'text' ? (
                      <p className="text-muted-foreground truncate text-xs">
                        no nutrition information
                      </p>
                    ) : (
                      item.brand && (
                        <p className="text-muted-foreground truncate text-xs">{item.brand}</p>
                      )
                    )}
                  </div>
                  {item.kind === 'text' ? (
                    // No amount and no calories: both would be numbers the
                    // totals deliberately ignore.
                    <span className="text-muted-foreground w-[10.5rem] text-right text-xs">
                      not counted
                    </span>
                  ) : (
                  <>
                  <div className="flex items-center gap-1.5">
                    <Input
                      type="number"
                      min={item.kind === 'recipe' ? 0.01 : 0.1}
                      step="any"
                      disabled={readOnly}
                      className="tabular w-20 text-right"
                      aria-label={`${item.name} ${item.kind === 'recipe' ? 'servings' : 'grams'}`}
                      value={item.amount}
                      onChange={(e) =>
                        setItems((prev) =>
                          prev.map((it, i) =>
                            i === index ? { ...it, amount: Number(e.target.value) } : it,
                          ),
                        )
                      }
                    />
                    <span className="text-muted-foreground w-12 text-xs">
                      {item.kind === 'recipe' ? 'servings' : 'g'}
                    </span>
                  </div>
                  <span className="text-muted-foreground tabular w-20 text-right text-xs">
                    {kcal(item.perUnit.calories_kcal * item.amount)}
                  </span>
                  </>
                  )}
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
        <CardContent className="space-y-3">
          <div className="grid gap-4 sm:grid-cols-2">
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
          </div>

          {/* Said plainly rather than left to be inferred from the ingredient
              list. A total that silently omits three ingredients is worse than
              no total, and the count includes ones inside sub-recipes, which
              you cannot see from this page at all. */}
          {untracked > 0 && (
            <p className="text-muted-foreground text-xs">
              Excludes {untracked} ingredient{untracked === 1 ? '' : 's'} with no nutrition
              information
              {existing.data && existing.data.untracked_count > untrackedHere
                ? ', some inside a sub-recipe'
                : ''}
              .
            </p>
          )}
        </CardContent>
      </Card>

      {!readOnly && (
        <>
          <ErrorNote error={save.error} />
          <div className="flex flex-wrap items-center gap-3">
            <Button
              disabled={
                save.isPending ||
                !name ||
                items.length === 0 ||
                items.some((i) => i.kind === 'text' && !i.name.trim())
              }
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
          <Tabs defaultValue="food">
            <TabsList>
              <TabsTrigger value="food">Food</TabsTrigger>
              <TabsTrigger value="recipe">Recipe</TabsTrigger>
              <TabsTrigger value="text">Just text</TabsTrigger>
            </TabsList>
            <TabsContent value="food" className="pt-3">
              <FoodPicker onPick={addFood} />
            </TabsContent>
            <TabsContent value="recipe" className="pt-3">
              <RecipePicker excludeId={id} onPick={addRecipe} />
            </TabsContent>
            <TabsContent value="text" className="pt-3">
              <TextIngredientForm onAdd={addText} />
            </TabsContent>
          </Tabs>
        </DialogContent>
      </Dialog>
    </div>
  )
}
