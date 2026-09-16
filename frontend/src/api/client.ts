const TOKEN_KEY = 'misplace-it.token'

export const tokenStore = {
  get: () => localStorage.getItem(TOKEN_KEY),
  set: (token: string) => localStorage.setItem(TOKEN_KEY, token),
  clear: () => localStorage.removeItem(TOKEN_KEY),
}

/** Error carrying the HTTP status so callers can branch on 401/404/409. */
export class ApiError extends Error {
  status: number
  code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }
}

/** Fired when the server rejects our token, so the app can sign the user out. */
export const UNAUTHORIZED_EVENT = 'misplace-it:unauthorized'

const BASE = '/api/v1'

interface RequestOptions {
  method?: string
  body?: unknown
  /** Multipart payload. Mutually exclusive with `body`. */
  form?: FormData
  query?: Record<string, string | number | boolean | undefined | null>
  signal?: AbortSignal
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, form, query, signal } = options

  const url = new URL(BASE + path, window.location.origin)
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null && value !== '') {
        url.searchParams.set(key, String(value))
      }
    }
  }

  const headers: Record<string, string> = {}
  const token = tokenStore.get()
  if (token) headers.Authorization = `Bearer ${token}`
  // FormData sets its own Content-Type, boundary included; setting it here
  // would produce a header that does not match the body.
  if (body !== undefined) headers['Content-Type'] = 'application/json'

  const response = await fetch(url.toString(), {
    method,
    headers,
    signal,
    body: form ?? (body === undefined ? undefined : JSON.stringify(body)),
  })

  if (response.status === 401) {
    // Expired or invalid token: clear it and let the app react once, centrally,
    // rather than having every screen handle sign-out for itself.
    tokenStore.clear()
    window.dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT))
    throw new ApiError(401, 'unauthorized', 'Your session has expired. Please sign in again.')
  }

  if (response.status === 204) return undefined as T

  const text = await response.text()
  const payload = text ? safeParse(text) : null

  if (!response.ok) {
    const code = (payload as { error?: string } | null)?.error ?? 'error'
    const message =
      (payload as { message?: string } | null)?.message ?? `Request failed (${response.status})`
    throw new ApiError(response.status, code, message)
  }

  return payload as T
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return { message: text }
  }
}

/**
 * Fetch an authenticated image and hand back an object URL.
 *
 * Photos are served by the API rather than as static files so ownership is
 * checked on every read, which means `<img src>` cannot fetch them directly —
 * it sends no Authorization header. The caller must revoke the returned URL.
 */
export async function fetchImageObjectUrl(path: string): Promise<string> {
  const token = tokenStore.get()
  const response = await fetch(path, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })
  if (response.status === 401) {
    tokenStore.clear()
    window.dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT))
    throw new ApiError(401, 'unauthorized', 'Your session has expired.')
  }
  if (!response.ok) throw new ApiError(response.status, 'error', 'Could not load the image')
  return URL.createObjectURL(await response.blob())
}
