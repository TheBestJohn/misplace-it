import { useState } from 'react'

import { useAuth } from '@/lib/auth'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { ErrorNote } from '@/components/shared'
import { ThemeToggle } from '@/components/ThemeToggle'

export default function SignInPage() {
  const { signIn, signUp } = useAuth()
  const [mode, setMode] = useState<'signin' | 'signup'>('signin')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      if (mode === 'signin') await signIn(email, password)
      else await signUp(email, password, displayName || email.split('@')[0])
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="grid min-h-dvh place-items-center px-4 py-8">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-xl">
            <span aria-hidden="true">🥗</span> nom-inal
          </CardTitle>
          <CardDescription>Weight, calories, macros and recipes — self-hosted.</CardDescription>
          <CardAction>
            <ThemeToggle />
          </CardAction>
        </CardHeader>

        <CardContent>
          <form onSubmit={submit} className="space-y-4">
            <Tabs value={mode} onValueChange={(v) => setMode(v as typeof mode)}>
              <TabsList className="grid w-full grid-cols-2">
                <TabsTrigger value="signin">Sign in</TabsTrigger>
                <TabsTrigger value="signup">Create account</TabsTrigger>
              </TabsList>
            </Tabs>

            {mode === 'signup' && (
              <div className="space-y-1.5">
                <Label htmlFor="name">Name</Label>
                <Input
                  id="name"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  placeholder="Your name"
                  autoComplete="name"
                />
              </div>
            )}

            <div className="space-y-1.5">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="email"
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                required
                minLength={mode === 'signup' ? 10 : undefined}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
              />
              {mode === 'signup' && (
                <p className="text-muted-foreground text-xs">At least 10 characters.</p>
              )}
            </div>

            <ErrorNote error={error} />

            <Button type="submit" className="w-full" disabled={busy}>
              {busy ? 'Working…' : mode === 'signin' ? 'Sign in' : 'Create account'}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
