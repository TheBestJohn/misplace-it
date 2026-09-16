import { useEffect, useRef, useState } from 'react'

import { tokenStore, UNAUTHORIZED_EVENT } from '@/api/client'
import type { Food } from '@/api/types'

/** Tiers the server emits, tightest match first. */
export type SearchTier = 'exact' | 'prefix' | 'contains' | 'fuzzy'

export interface TieredFood extends Food {
  /** How this food was matched, so the UI can group or label results. */
  tier: SearchTier
}

export interface FoodSearchState {
  results: TieredFood[]
  /** True from the first keystroke until the `done` event arrives. */
  searching: boolean
  /** Server-reported duration of the completed search, in ms. */
  elapsedMs: number | null
  error: string | null
}

const TIER_ORDER: Record<SearchTier, number> = { exact: 0, prefix: 1, contains: 2, fuzzy: 3 }

/**
 * Streams food search results from the SSE endpoint.
 *
 * Deliberately not using `EventSource`: it cannot send an Authorization header,
 * and the alternative — putting the token in the query string — would write it
 * into every proxy and access log between here and the server. `fetch` gives us
 * headers and an `AbortSignal`, at the cost of parsing the SSE framing by hand,
 * which is a dozen lines.
 *
 * Results are appended tier by tier as they arrive, so the list fills in from
 * the top while the fuzzy scan is still running.
 */
export function useFoodSearch(query: string, { limit = 10 } = {}): FoodSearchState {
  const [state, setState] = useState<FoodSearchState>({
    results: [],
    searching: false,
    elapsedMs: null,
    error: null,
  })

  // Lets a new keystroke cancel the request still in flight for the old one.
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    abortRef.current?.abort()

    const term = query.trim()
    if (!term) {
      setState({ results: [], searching: false, elapsedMs: null, error: null })
      return
    }

    const controller = new AbortController()
    abortRef.current = controller
    setState({ results: [], searching: true, elapsedMs: null, error: null })

    void (async () => {
      try {
        const url = new URL('/api/v1/search/foods', window.location.origin)
        url.searchParams.set('q', term)
        url.searchParams.set('limit', String(limit))

        const token = tokenStore.get()
        const response = await fetch(url, {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
          signal: controller.signal,
        })

        if (response.status === 401) {
          tokenStore.clear()
          window.dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT))
          return
        }
        if (!response.ok || !response.body) {
          throw new Error(`Search failed (${response.status})`)
        }

        for await (const event of readEventStream(response.body, controller.signal)) {
          if (controller.signal.aborted) return

          if (event.name === 'tier') {
            const payload = event.data as { tier: SearchTier; results: Food[] }
            const batch = payload.results.map((food) => ({ ...food, tier: payload.tier }))
            setState((prev) => ({
              ...prev,
              // The server already dedupes across tiers and sends them in
              // order, so appending preserves best-match-first.
              results: [...prev.results, ...batch].sort(
                (a, b) => TIER_ORDER[a.tier] - TIER_ORDER[b.tier],
              ),
            }))
          } else if (event.name === 'done') {
            const payload = event.data as { elapsed_ms: number }
            setState((prev) => ({ ...prev, searching: false, elapsedMs: payload.elapsed_ms }))
          } else if (event.name === 'error') {
            const payload = event.data as { message: string }
            setState((prev) => ({ ...prev, error: payload.message }))
          }
        }
      } catch (err) {
        // An abort is the expected outcome of typing another character.
        if (controller.signal.aborted || (err as Error)?.name === 'AbortError') return
        setState((prev) => ({
          ...prev,
          searching: false,
          error: err instanceof Error ? err.message : 'Search failed',
        }))
      }
    })()

    return () => controller.abort()
  }, [query, limit])

  return state
}

interface ParsedEvent {
  name: string
  data: unknown
}

/**
 * Minimal SSE parser over a fetch body stream.
 *
 * The wire format is blocks of `field: value` lines separated by a blank line.
 * Chunks split anywhere, so the tail of each read is carried into the next.
 */
async function* readEventStream(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncGenerator<ParsedEvent> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })

      let boundary: number
      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)

        let name = 'message'
        const dataLines: string[] = []
        for (const line of block.split('\n')) {
          // A line starting with ':' is a keep-alive comment.
          if (line.startsWith(':')) continue
          if (line.startsWith('event:')) name = line.slice(6).trim()
          else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim())
        }

        if (dataLines.length === 0) continue
        try {
          yield { name, data: JSON.parse(dataLines.join('\n')) }
        } catch {
          // A malformed frame is skipped rather than killing the stream.
        }
      }
    }
  } finally {
    reader.cancel().catch(() => {})
  }
}
