import { useEffect, useState } from 'react'
import { Moon, Sun } from 'lucide-react'

import { Button } from '@/components/ui/button'

type Theme = 'light' | 'dark'
const KEY = 'misplace-it.theme'

/**
 * Read the theme the boot script in index.html already applied, rather than
 * re-deriving it from storage. One source of truth means the button can never
 * disagree with the page it is sitting on.
 */
function current(): Theme {
  return document.documentElement.classList.contains('dark') ? 'dark' : 'light'
}

/**
 * Tailwind's dark variant keys off a `.dark` class on <html>, so the theme is
 * applied imperatively rather than by a media query alone — that is what lets
 * an explicit choice override the OS. The preference is a per-viewer
 * convenience, so localStorage is its right home, and every access is guarded
 * because it throws when site data is blocked.
 */
export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(current)

  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark')
    try {
      localStorage.setItem(KEY, theme)
    } catch {
      // Not persisting is acceptable; the toggle still works for this session.
    }
  }, [theme])

  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
      aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
    >
      {theme === 'dark' ? <Sun /> : <Moon />}
    </Button>
  )
}
