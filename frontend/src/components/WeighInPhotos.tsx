import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Camera, Loader2, X } from 'lucide-react'

import { api } from '@/api/endpoints'
import { fetchImageObjectUrl } from '@/api/client'
import type { Photo } from '@/api/types'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { ErrorNote } from '@/components/shared'

/**
 * Photos attached to one weigh-in.
 *
 * Uploads are sent at full size and the server downscales and re-encodes them,
 * which is also what drops EXIF — phone photos carry GPS, and a progress photo
 * is usually taken at home.
 */
export default function WeighInPhotos({ weightEntryId }: { weightEntryId: string }) {
  const queryClient = useQueryClient()
  const inputRef = useRef<HTMLInputElement>(null)
  const [viewing, setViewing] = useState<Photo | null>(null)

  const photos = useQuery({
    queryKey: ['photos', weightEntryId],
    queryFn: () => api.listPhotos(weightEntryId),
  })

  const upload = useMutation({
    mutationFn: (file: File) => api.uploadPhoto(weightEntryId, file),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['photos', weightEntryId] })
      // A new photo can clear the progress-photo reminder.
      queryClient.invalidateQueries({ queryKey: ['reminders'] })
    },
  })

  const remove = useMutation({
    mutationFn: (id: string) => api.deletePhoto(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['photos', weightEntryId] })
      queryClient.invalidateQueries({ queryKey: ['reminders'] })
    },
  })

  const items = photos.data ?? []

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        {items.map((photo) => (
          <Thumbnail
            key={photo.id}
            photo={photo}
            onOpen={() => setViewing(photo)}
            onRemove={() => remove.mutate(photo.id)}
          />
        ))}

        <Button
          variant="outline"
          size="sm"
          disabled={upload.isPending}
          onClick={() => inputRef.current?.click()}
        >
          {upload.isPending ? <Loader2 className="animate-spin" /> : <Camera />}
          {upload.isPending ? 'Uploading…' : items.length ? 'Add another' : 'Add photo'}
        </Button>

        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) upload.mutate(file)
            // Reset so picking the same file twice still fires a change event.
            e.target.value = ''
          }}
        />
      </div>

      <ErrorNote error={upload.error} />
      <ErrorNote error={remove.error} />

      <Dialog open={viewing !== null} onOpenChange={(open) => !open && setViewing(null)}>
        <DialogContent className="sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>{viewing?.caption ?? 'Progress photo'}</DialogTitle>
          </DialogHeader>
          {viewing && <FullImage photo={viewing} />}
        </DialogContent>
      </Dialog>
    </div>
  )
}

/**
 * The API checks ownership on every read, so `<img src>` cannot fetch a photo
 * directly — it sends no Authorization header. Each image is fetched as a blob
 * and shown through an object URL, which has to be revoked to avoid leaking the
 * blob for the life of the tab.
 */
function useAuthedImage(url: string) {
  const [objectUrl, setObjectUrl] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let revoked = false
    let created: string | null = null

    fetchImageObjectUrl(url)
      .then((u) => {
        if (revoked) {
          URL.revokeObjectURL(u)
          return
        }
        created = u
        setObjectUrl(u)
      })
      .catch(() => setFailed(true))

    return () => {
      revoked = true
      if (created) URL.revokeObjectURL(created)
    }
  }, [url])

  return { objectUrl, failed }
}

function Thumbnail({
  photo,
  onOpen,
  onRemove,
}: {
  photo: Photo
  onOpen: () => void
  onRemove: () => void
}) {
  const { objectUrl, failed } = useAuthedImage(photo.url)

  return (
    <div className="group relative">
      <button
        type="button"
        onClick={onOpen}
        className="focus-visible:ring-ring/50 bg-muted block size-20 overflow-hidden rounded-md border outline-none focus-visible:ring-[3px]"
        aria-label={photo.caption ?? 'Open progress photo'}
      >
        {objectUrl ? (
          <img src={objectUrl} alt={photo.caption ?? ''} className="size-full object-cover" />
        ) : (
          <span className="text-muted-foreground grid size-full place-items-center text-[10px]">
            {failed ? 'failed' : '…'}
          </span>
        )}
      </button>
      <Button
        variant="destructive"
        size="icon-sm"
        aria-label="Delete photo"
        onClick={onRemove}
        className="absolute -top-2 -right-2 size-6 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100"
      >
        <X className="size-3" />
      </Button>
    </div>
  )
}

function FullImage({ photo }: { photo: Photo }) {
  const { objectUrl, failed } = useAuthedImage(photo.url)
  if (failed) return <ErrorNote error={new Error('Could not load that photo.')} />
  if (!objectUrl) return <div className="bg-muted h-64 animate-pulse rounded-md" />
  return (
    <img
      src={objectUrl}
      alt={photo.caption ?? 'Progress photo'}
      className="max-h-[70vh] w-full rounded-md object-contain"
    />
  )
}
