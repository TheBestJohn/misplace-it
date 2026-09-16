import { NavLink, Navigate, Route, Routes } from 'react-router-dom'

import { useAuth } from './lib/auth'
import { Spinner } from './components/ui'
import SignInPage from './pages/SignInPage'
import DashboardPage from './pages/DashboardPage'
import DiaryPage from './pages/DiaryPage'
import FoodsPage from './pages/FoodsPage'
import RecipesPage from './pages/RecipesPage'
import RecipeEditorPage from './pages/RecipeEditorPage'
import WeightPage from './pages/WeightPage'
import SettingsPage from './pages/SettingsPage'

const NAV = [
  { to: '/', label: 'Today', icon: '◉', end: true },
  { to: '/diary', label: 'Diary', icon: '☰' },
  { to: '/foods', label: 'Foods', icon: '⌕' },
  { to: '/recipes', label: 'Recipes', icon: '✎' },
  { to: '/weight', label: 'Weight', icon: '⌃' },
  { to: '/settings', label: 'Settings', icon: '⚙' },
]

export default function App() {
  const { user, loading, signOut } = useAuth()

  if (loading) {
    return (
      <div className="boot">
        <Spinner label="Starting up…" />
      </div>
    )
  }

  if (!user) return <SignInPage />

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            🥗
          </span>
          <span>misplace-it</span>
        </div>
        <div className="topbar-right">
          <span className="muted hide-sm">{user.display_name}</span>
          <button type="button" className="button button-ghost" onClick={signOut}>
            Sign out
          </button>
        </div>
      </header>

      <nav className="nav" aria-label="Main">
        {NAV.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}
          >
            <span className="nav-icon" aria-hidden="true">
              {item.icon}
            </span>
            <span>{item.label}</span>
          </NavLink>
        ))}
      </nav>

      <main className="main">
        <Routes>
          <Route path="/" element={<DashboardPage />} />
          <Route path="/diary" element={<DiaryPage />} />
          <Route path="/foods" element={<FoodsPage />} />
          <Route path="/recipes" element={<RecipesPage />} />
          <Route path="/recipes/new" element={<RecipeEditorPage />} />
          <Route path="/recipes/:id" element={<RecipeEditorPage />} />
          <Route path="/weight" element={<WeightPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  )
}
