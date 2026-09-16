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
  variant_of: null,
  variant_label: null,
  edit_summary: '',
}

/**
 * Create or edit a food.
 *
 * Shared between the Foods page, the food picker and the detail dialog, so a
 * food can be created or corrected without leaving whatever you were in the
 * middle of. The optional nutrients start collapsed: thirteen fields is a lot
 * to face when you are halfway through logging lunch, and only six of them are
 * required.
 */
export default function FoodForm({
  food,
  variantOf,
  initialName,
  askForSummary,
  onSaved,
  onCancel,
  submitLabel,
}: {
  food?: Food | null
  /**
   * Start a new preparation variant of this food. The nutrients are seeded
   * from the parent because a variant is usually a nudge from it, not a blank
   * form -- cooked chicken is not a different food you have to look up again.
   */
  variantOf?: Food | null
  /** Seeds the name, so a search that found nothing carries straight over. */
  initialName?: string
  /**
   * Ask what changed. Shown when editing something that already exists, where
   * the note is the difference between a history you can read and a list of
   * timestamps.
   */
  askForSummary?: boolean
  onSaved: (food: FoodDetail) => void
  onCancel: () => void
  submitLabel?: string
}) {
  const queryClient = useQueryClient()
  const [showMore, setShowMore] = useState(false)
  const [form, setForm] = useState<FoodInput>(() => {
    const source = food ?? variantOf
    if (!source) return { ...EMPTY, name: initialName ?? '' }
    return {
      name: source.name,
      brand: source.brand ?? '',
      upc: food?.upc ?? '',
      calories_kcal: source.calories_kcal,
      protein_g: source.protein_g,
      carbs_g: source.carbs_g,
      fat_g: source.fat_g,
      fiber_g: source.fiber_g,
      sugar_g: source.sugar_g,
      saturated_fat_g: source.saturated_fat_g,
      sodium_mg: source.sodium_mg,
      serving_size_g: source.serving_size_g,
      serving_label: source.serving_label ?? '',
      variant_of: variantOf ? variantOf.id : (food?.variant_of ?? null),
      variant_label: variantOf ? '' : (food?.variant_label ?? null),
      edit_summary: '',
    }
  })

  const save = useMutation({
    mutationFn: () => {
      const payload: FoodInput = {
        ...form,
        name: form.name.trim(),
        brand: form.brand || null,
        upc: form.upc || null,
        serving_label: form.serving_label || null,
        variant_label: form.variant_label ? form.variant_label.trim() : null,
        edit_summary: form.edit_summary || null,
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

      {form.variant_of && (
        <div className="space-y-1.5">
          <Label htmlFor="f-variant">Variant</Label>
          <Input
            id="f-variant"
            required
            placeholder="cooked, raw, drained…"
            value={form.variant_label ?? ''}
            onChange={(e) => setForm((f) => ({ ...f, variant_label: e.target.value }))}
          />
          <p className="text-muted-foreground text-xs">
            What makes this different from the food it came from. The numbers below started as a
            copy of the parent&rsquo;s — change the ones the preparation changes.
          </p>
        </div>
      )}

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

      {askForSummary && (
        <div className="space-y-1.5">
          <Label htmlFor="f-summary">What changed?</Label>
          <Input
            id="f-summary"
            placeholder="e.g. fat is 3.2 g on the current packaging"
            value={form.edit_summary ?? ''}
            onChange={(e) => setForm((f) => ({ ...f, edit_summary: e.target.value }))}
          />
          <p className="text-muted-foreground text-xs">
            Kept on the revision, not on the food. It is what the next person reads before deciding
            whether to trust your numbers.
          </p>
        </div>
      )}

      <ErrorNote error={save.error} />

      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          type="submit"
          disabled={
            save.isPending ||
            !form.name.trim() ||
            // The server refuses a parent without a label too; catching it here
            // saves a round trip to be told something the form already knows.
            (!!form.variant_of && !form.variant_label?.trim())
          }
        >
          {save.isPending ? 'Saving…' : (submitLabel ?? 'Save')}
        </Button>
      </div>
    </form>
  )
}
