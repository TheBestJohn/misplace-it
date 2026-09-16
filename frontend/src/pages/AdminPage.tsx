import { useEffect, useState } from 'react'
import { Navigate } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ShieldCheck } from 'lucide-react'

import { api } from '@/api/endpoints'
import type { AdminUserRow } from '@/api/types'
import { useAuth } from '@/lib/auth'
import { relativeTime } from '@/lib/format'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Empty, ErrorNote, Spinner } from '@/components/shared'

/** One number and its caption. The stats grid is a dozen of these. */
function Stat({ label, value, hint }: { label: string; value: number; hint?: string }) {
  return (
    <div className="rounded-lg border px-3 py-2">
      <div className="tabular text-xl font-semibold">{value.toLocaleString()}</div>
      <div className="text-muted-foreground text-xs">{label}</div>
      {hint && <div className="text-muted-foreground text-[11px]">{hint}</div>}
    </div>
  )
}

/**
 * Instance administration.
 *
 * Guarded twice on purpose. The route hides itself when `is_admin` is false,
 * which is a convenience; every endpoint behind it re-checks the flag against
 * the database on each request, which is the actual control. A client-side
 * check alone would be decoration.
 */
export default function AdminPage() {
  const { user } = useAuth()
  const queryClient = useQueryClient()
  const [term, setTerm] = useState('')
  const [debounced, setDebounced] = useState('')
  const [includeDisabled, setIncludeDisabled] = useState(false)

  useEffect(() => {
    const id = setTimeout(() => setDebounced(term.trim()), 250)
    return () => clearTimeout(id)
  }, [term])

  const stats = useQuery({ queryKey: ['admin', 'stats'], queryFn: () => api.adminStats() })
  const users = useQuery({
    queryKey: ['admin', 'users', debounced, includeDisabled],
    queryFn: () =>
      api.adminUsers({ q: debounced || undefined, include_disabled: includeDisabled }),
  })

  const patch = useMutation({
    mutationFn: ({ id, body }: { id: string; body: { is_admin?: boolean; disabled?: boolean } }) =>
      api.adminPatchUser(id, body),
    onSuccess: (_row, { body }) => {
      // Suspending someone otherwise makes them vanish from the default list,
      // which reads as "deleted" rather than "suspended" and gives you nothing
      // to undo it with. Reveal the suspended rows instead.
      if (body.disabled) setIncludeDisabled(true)
      queryClient.invalidateQueries({ queryKey: ['admin'] })
    },
  })

  if (user && !user.is_admin) return <Navigate to="/" replace />

  const unchecked = stats.data ? stats.data.foods - stats.data.foods_verified : 0

  return (
    <div className="space-y-4">
      <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
        <ShieldCheck className="size-5" /> Administration
      </h1>

      <Card>
        <CardHeader>
          <CardTitle>This instance</CardTitle>
          <CardDescription>
            The food database is the part worth watching: it is open to everyone, so the useful
            number is how much of it anyone has actually checked.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {stats.isLoading && <Spinner />}
          <ErrorNote error={stats.error} />
          {stats.data && (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Stat label="Accounts" value={stats.data.users} hint={`${stats.data.admins} admin`} />
              <Stat label="Suspended" value={stats.data.disabled_users} />
              <Stat label="Active API keys" value={stats.data.active_api_keys} />
              <Stat label="Foods" value={stats.data.foods} hint={`${stats.data.food_variants} variants`} />
              <Stat
                label="Verified foods"
                value={stats.data.foods_verified}
                hint={`quorum of ${stats.data.food_quorum}`}
              />
              <Stat label="Unverified" value={unchecked} />
              <Stat label="Disputed" value={stats.data.foods_disputed} />
              <Stat label="Food revisions" value={stats.data.food_revisions} />
              <Stat
                label="Recipes"
                value={stats.data.recipes}
                hint={`${stats.data.public_recipes} shared`}
              />
              <Stat label="Diary entries" value={stats.data.diary_entries} />
              <Stat label="Weigh-ins" value={stats.data.weigh_ins} />
              <Stat label="Photos" value={stats.data.photos} />
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Accounts</CardTitle>
          <CardDescription>
            Suspending keeps everything the account has recorded and simply stops it signing in —
            including its API keys. Deleting would take the diary, weights and photos with it.
          </CardDescription>
          <CardAction>
            <Label className="text-muted-foreground text-sm font-normal">
              <Switch checked={includeDisabled} onCheckedChange={setIncludeDisabled} />
              Show suspended
            </Label>
          </CardAction>
        </CardHeader>
        <CardContent className="space-y-3">
          <Input
            placeholder="Filter by name or email…"
            value={term}
            onChange={(e) => setTerm(e.target.value)}
          />
          {users.isLoading && <Spinner />}
          <ErrorNote error={users.error} />
          <ErrorNote error={patch.error} />
          {users.data?.length === 0 && <Empty>Nobody matches.</Empty>}

          {users.data && users.data.length > 0 && (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Account</TableHead>
                  <TableHead className="text-right">Logged</TableHead>
                  <TableHead className="text-right">Foods</TableHead>
                  <TableHead className="text-right">Keys</TableHead>
                  <TableHead>Last seen</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {users.data.map((row: AdminUserRow) => {
                  const self = row.id === user?.id
                  return (
                    <TableRow key={row.id} className={cn(row.disabled_at && 'opacity-55')}>
                      <TableCell className="max-w-[16rem] whitespace-normal">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium">{row.display_name}</span>
                          {row.is_admin && (
                            <Badge variant="secondary" className="text-[10px]">
                              Admin
                            </Badge>
                          )}
                          {row.disabled_at && (
                            <Badge variant="destructive" className="text-[10px]">
                              Suspended
                            </Badge>
                          )}
                          {self && (
                            <Badge variant="outline" className="text-[10px]">
                              You
                            </Badge>
                          )}
                        </div>
                        <span className="text-muted-foreground text-xs">{row.email}</span>
                      </TableCell>
                      <TableCell className="tabular text-right">
                        {row.diary_entries + row.weigh_ins}
                      </TableCell>
                      <TableCell className="tabular text-right">
                        {row.foods_created}
                        <span className="text-muted-foreground text-xs"> / {row.food_edits}</span>
                      </TableCell>
                      <TableCell className="tabular text-right">{row.active_api_keys}</TableCell>
                      <TableCell className="text-muted-foreground text-xs">
                        {row.last_activity_at ? relativeTime(row.last_activity_at) : 'never'}
                      </TableCell>
                      <TableCell className="text-right">
                        {/* No actions on yourself: the server refuses a
                            self-demotion or self-suspension outright, since
                            that is the one mistake here nothing inside the
                            application can undo. */}
                        {!self && (
                          <div className="flex justify-end gap-1">
                            <Button
                              variant="ghost"
                              size="sm"
                              disabled={patch.isPending}
                              onClick={() =>
                                patch.mutate({ id: row.id, body: { is_admin: !row.is_admin } })
                              }
                            >
                              {row.is_admin ? 'Demote' : 'Make admin'}
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              disabled={patch.isPending}
                              onClick={() =>
                                patch.mutate({ id: row.id, body: { disabled: !row.disabled_at } })
                              }
                            >
                              {row.disabled_at ? 'Restore' : 'Suspend'}
                            </Button>
                          </div>
                        )}
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          )}
          <p className="text-muted-foreground text-xs">
            Foods column reads created / edited.
          </p>
        </CardContent>
      </Card>
    </div>
  )
}
