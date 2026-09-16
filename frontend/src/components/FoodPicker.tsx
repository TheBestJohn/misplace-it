import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { api } from '../api/endpoints'
import type { ExternalFood, Food } from '../api/types'
import { kcal, round, sourceLabel } from '../lib/format'
import { ErrorNote, SourceBadge, Spinner } from './ui'

type Tab = 'library' | 'search' | 'barcode'

/**
 * One search surface over all three food sources.
 *
 * External hits are not foods yet — they live upstream. Picking one imports it
 * first (POST /foods/import, which is idempotent on source+id) and hands the
 * caller back a real local food, so callers never have to care where it came
 * from.
 */
export default function FoodPicker({
  onPick,
  autoFocus = true,
}: {
  onPick: (food: Food) => void
  autoFocus?: boolean
}) {
  const [tab, setTab] = useState<Tab>('library')
  const [term, setTerm] = useState('')
  const [debounced, setDebounced] = useState('')
  const [barcode, setBarcode] = useState('')
  const [submittedBarcode, setSubmittedBarcode] = useState('')
  const queryClient = useQueryClient()

  // Debounce so a fast typist doesn't fire a request per keystroke — this
  // matters most on the external tab, which hits third-party APIs.
  useEffect(() => {
    const id = setTimeout(() => setDebounced(term.trim()), 300)
    return () => clearTimeout(id)
  }, [term])

  const library = useQuery({
    queryKey: ['foods', debounced],
    queryFn: () => api.listFoods({ q: debounced || undefined, limit: 30 }),
    enabled: tab === 'library',
  })

  const external = useQuery({
    queryKey: ['foods', 'external', debounced],
    queryFn: () => api.searchExternal(debounced),
    enabled: tab === 'search' && debounced.length >= 2,
  })

  const lookup = useQuery({
    queryKey: ['foods', 'barcode', submittedBarcode],
    queryFn: () => api.lookupBarcode(submittedBarcode),
    enabled: tab === 'barcode' && submittedBarcode.length >= 6,
    retry: false,
  })

  const importFood = useMutation({
    mutationFn: (food: ExternalFood) => api.importFood(food),
    onSuccess: (food) => {
      queryClient.invalidateQueries({ queryKey: ['foods'] })
      onPick(food)
    },
  })

  const externalResults = useMemo(() => external.data?.results ?? [], [external.data])

  return (
    <div className="picker">
      <div className="segmented" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'library'}
          className={tab === 'library' ? 'active' : ''}
          onClick={() => setTab('library')}
        >
          My library
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'search'}
          className={tab === 'search' ? 'active' : ''}
          onClick={() => setTab('search')}
        >
          Food databases
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'barcode'}
          className={tab === 'barcode' ? 'active' : ''}
          onClick={() => setTab('barcode')}
        >
          Barcode
        </button>
      </div>

      {tab === 'barcode' ? (
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault()
            setSubmittedBarcode(barcode.replace(/\D/g, ''))
          }}
        >
          <input
            className="grow"
            inputMode="numeric"
            pattern="[0-9]*"
            placeholder="Scan or type a UPC / EAN"
            value={barcode}
            onChange={(e) => setBarcode(e.target.value)}
            autoFocus={autoFocus}
          />
          <button type="submit" className="button button-primary">
            Look up
          </button>
        </form>
      ) : (
        <input
          className="picker-search"
          placeholder={tab === 'library' ? 'Search your foods…' : 'Search USDA and Open Food Facts…'}
          value={term}
          onChange={(e) => setTerm(e.target.value)}
          autoFocus={autoFocus}
        />
      )}

      {tab === 'library' && (
        <div className="picker-results">
          {library.isLoading && <Spinner />}
          <ErrorNote error={library.error} />
          {library.data?.length === 0 && (
            <p className="empty">
              Nothing here yet — try the <strong>Food databases</strong> or{' '}
              <strong>Barcode</strong> tab to pull one in.
            </p>
          )}
          {library.data?.map((food) => (
            <button
              key={food.id}
              type="button"
              className="picker-item"
              onClick={() => onPick(food)}
            >
              <span className="picker-item-main">
                <span className="picker-item-name">{food.name}</span>
                <span className="muted small">
                  {food.brand ? `${food.brand} · ` : ''}
                  {kcal(food.calories_kcal)} / 100 g
                </span>
              </span>
              <SourceBadge source={food.source} />
            </button>
          ))}
        </div>
      )}

      {tab === 'search' && (
        <div className="picker-results">
          {debounced.length < 2 && <p className="empty">Type at least two characters.</p>}
          {external.isFetching && <Spinner label="Searching food databases…" />}
          <ErrorNote error={external.error} />
          <ErrorNote error={importFood.error} />

          {external.data?.unavailable?.map((reason) => (
            <p className="note note-warn" key={reason}>
              {reason}
            </p>
          ))}

          {!external.isFetching && debounced.length >= 2 && externalResults.length === 0 && (
            <p className="empty">No matches.</p>
          )}

          {externalResults.map((food) => (
            <button
              key={`${food.source}-${food.source_id}`}
              type="button"
              className="picker-item"
              disabled={importFood.isPending}
              onClick={() => importFood.mutate(food)}
            >
              <span className="picker-item-main">
                <span className="picker-item-name">{food.name}</span>
                <span className="muted small">
                  {food.brand ? `${food.brand} · ` : ''}
                  {kcal(food.calories_kcal)} / 100 g · P {round(food.protein_g)} C{' '}
                  {round(food.carbs_g)} F {round(food.fat_g)}
                </span>
              </span>
              <SourceBadge source={food.source} />
            </button>
          ))}
        </div>
      )}

      {tab === 'barcode' && (
        <div className="picker-results">
          {lookup.isFetching && <Spinner label="Looking up barcode…" />}
          <ErrorNote error={lookup.error} />
          <ErrorNote error={importFood.error} />

          {lookup.data?.local && (
            <>
              <p className="note">Already in your library.</p>
              <button
                type="button"
                className="picker-item"
                onClick={() => onPick(lookup.data!.local!)}
              >
                <span className="picker-item-main">
                  <span className="picker-item-name">{lookup.data.local.name}</span>
                  <span className="muted small">{kcal(lookup.data.local.calories_kcal)} / 100 g</span>
                </span>
                <SourceBadge source={lookup.data.local.source} />
              </button>
            </>
          )}

          {lookup.data?.external && !lookup.data.local && (
            <button
              type="button"
              className="picker-item"
              disabled={importFood.isPending}
              onClick={() => importFood.mutate(lookup.data!.external!)}
            >
              <span className="picker-item-main">
                <span className="picker-item-name">{lookup.data.external.name}</span>
                <span className="muted small">
                  {lookup.data.external.brand ? `${lookup.data.external.brand} · ` : ''}
                  {sourceLabel(lookup.data.external.source)} ·{' '}
                  {kcal(lookup.data.external.calories_kcal)} / 100 g
                </span>
              </span>
              <span className="badge">Import</span>
            </button>
          )}
        </div>
      )}
    </div>
  )
}
