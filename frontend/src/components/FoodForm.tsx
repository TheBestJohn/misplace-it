import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ChevronDown, ChevronRight } from 'lucide-react'

import { api } from '@/api/endpoints'
import type { FoodInput } from '@/api/endpoints'
import type { Food, FoodDetail } from '@/api/types'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ErrorNote } from '@/components/shared'

const EMPTY: FoodInput = {
  name: '',
  brand: '',
  upc: '',
  calories_kcal: 0,
  protein_g: 0,
  carbs_g: 0,
  fat_g: 0,
  fiber_g: null,
  sugar_g: null,
  saturated_fat_g: null,
  sodium_mg: null,
  serving_size_g: 100,
  serving_label: '',
}

/**
 * Create or edit a custom food.
 *
 * Shared between the Foods page and the food picker, so a food can be created
 * without leaving whatever you were in the middle of. The optional nutrients
 * start collapsed: thirteen fields is a lot to face when you are halfway
 * through logging lunch, and only six of them are required.
 */
export default function FoodForm({
  food,
  initialName,
  onSaved,
  onCancel,
  submitLabel,
}: {
  food?: Food | null
  /** Seeds the name, so a search that found nothing carries straight over. */
  initialName?: string
  onSaved: (food: FoodDetail) => void
  onCancel: () => void
  submitLabel?: string
}) {
  const queryClient = useQueryClient()
  const [showMore, setShowMore] = useState(false)
  const [form, setForm] = useState<FoodInput>(
    food
      ? {
          name: food.name,
          brand: food.brand ?? '',
          upc: food.upc ?? '',
          calories_kcal: food.calories_kcal,
          protein_g: food.protein_g,
          carbs_g: food.carbs_g,
          fat_g: food.fat_g,
          fiber_g: food.fiber_g,
          sugar_g: food.sugar_g,
          saturated_fat_g: food.saturated_fat_g,
          sodium_mg: food.sodium_mg,
          serving_size_g: food.serving_size_g,
          serving_label: food.serving_label ?? '',
        }
      : { ...EMPTY, name: initialName ?? '' },
  )

  const save = useMutation({
    mutationFn: () => {
      const payload: FoodInput = {
        ...form,
        name: form.name.trim(),
        brand: form.brand || null,
        upc: form.upc || null,
        serving_label: form.serving_label || null,
      }
      return food ? api.updateFood(food.id, payload) : api.createFood(payload)
    },
    onSuccess: (saved) => {
      queryClient.invalidateQueries({ queryKey: ['foods'] })
      onSaved(saved)
    },
  })

  const num = (key: keyof FoodInput) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [key]: e.target.value === '' ? null : Number(e.target.value) }))

  const NumField = ({
    id,
    label,
    field,
    required,
  }: {
    id: string
    label: string
    field: keyof FoodInput
    required?: boolean
  }) => (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type="number"
        step="any"
        min={0}
        required={required}
        value={(form[field] as number | null) ?? ''}
        onChange={num(field)}
      />
    </div>
  )

  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault()
        save.mutate()
      }}
    >
      <div className="space-y-1.5">
        <Label htmlFor="f-name">Name</Label>
        <Input
          id="f-name"
          required
          autoFocus
          value={form.name}
          onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="f-brand">Brand</Label>
        <Input
          id="f-brand"
          value={form.brand ?? ''}
          onChange={(e) => setForm((f) => ({ ...f, brand: e.target.value }))}
        />
      </div>

      <p className="text-muted-foreground text-xs">Nutrients are per 100 g.</p>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <NumField id="f-kcal" label="Calories" field="calories_kcal" required />
        <NumField id="f-p" label="Protein (g)" field="protein_g" required />
        <NumField id="f-c" label="Carbs (g)" field="carbs_g" required />
        <NumField id="f-f" label="Fat (g)" field="fat_g" required />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <NumField id="f-serv" label="Serving size (g)" field="serving_size_g" required />
        <div className="space-y-1.5">
          <Label htmlFor="f-servlabel">Serving label</Label>
          <Input
            id="f-servlabel"
            placeholder="e.g. 1 cup"
            value={form.serving_label ?? ''}
            onChange={(e) => setForm((f) => ({ ...f, serving_label: e.target.value }))}
          />
        </div>
      </div>

      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="px-0"
        onClick={() => setShowMore((v) => !v)}
        aria-expanded={showMore}
      >
        {showMore ? <ChevronDown /> : <ChevronRight />}
        More nutrients
      </Button>

      {showMore && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <NumField id="f-fib" label="Fiber (g)" field="fiber_g" />
          <NumField id="f-sug" label="Sugar (g)" field="sugar_g" />
          <NumField id="f-sat" label="Sat. fat (g)" field="saturated_fat_g" />
          <NumField id="f-na" label="Sodium (mg)" field="sodium_mg" />
          <div className="col-span-2 space-y-1.5 sm:col-span-4">
            <Label htmlFor="f-upc">UPC</Label>
            <Input
              id="f-upc"
              inputMode="numeric"
              value={form.upc ?? ''}
              onChange={(e) => setForm((f) => ({ ...f, upc: e.target.value }))}
            />
          </div>
        </div>
      )}

      <ErrorNote error={save.error} />

      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={save.isPending || !form.name.trim()}>
          {save.isPending ? 'Saving…' : (submitLabel ?? 'Save')}
        </Button>
      </div>
    </form>
  )
}
