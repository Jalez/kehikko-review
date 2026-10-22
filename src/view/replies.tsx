import { useState } from 'react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

import { MAX_BODY, type ReplyDraft } from '../../review/shape.ts'

import { SMALL, Who } from './comment.tsx'

/**
 * Replies to the review comments the person received on their own change (`/review-reply` drafts
 * them): what was said, the reply, and what to change. Nothing is posted until the person presses
 * Post, then "Post it" — the words posted are the words shown, or nothing (`/api/reply/send`).
 */

const say = (error: unknown): string => (error instanceof Error ? error.message : String(error))

export function Replies({
  replies,
  tracker,
  onReword,
  onDrop,
  onSend,
}: {
  replies: readonly ReplyDraft[]
  tracker: 'GitHub' | 'GitLab'
  onReword(id: string, body: string, todo: string): Promise<void>
  onDrop(id: string): Promise<void>
  onSend(id: string, body: string): Promise<void>
}) {
  if (!replies.length) return null
  return (
    <section className="flex min-w-0 flex-col gap-1.5" aria-label="Replies">
      <h3 className="text-[0.75rem] font-semibold">
        Replies to your reviewers
        <span className="font-normal text-muted-foreground"> — {replies.filter((r) => !r.sent).length} waiting</span>
      </h3>
      <ul className="flex min-w-0 flex-col gap-1.5">
        {replies.map((reply) => (
          <li key={reply.id} className="min-w-0">
            <ReplyCard reply={reply} tracker={tracker} onReword={onReword} onDrop={onDrop} onSend={onSend} />
          </li>
        ))}
      </ul>
    </section>
  )
}

function ReplyCard({
  reply,
  tracker,
  onReword,
  onDrop,
  onSend,
}: {
  reply: ReplyDraft
  tracker: 'GitHub' | 'GitLab'
  onReword(id: string, body: string, todo: string): Promise<void>
  onDrop(id: string): Promise<void>
  onSend(id: string, body: string): Promise<void>
}) {
  const [editing, setEditing] = useState(false)
  const [body, setBody] = useState(reply.body)
  const [todo, setTodo] = useState(reply.todo)
  const [confirming, setConfirming] = useState(false)
  const [armed, setArmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const act = (does: () => Promise<void>, after?: () => void) => {
    setBusy(true)
    setError(null)
    does()
      .then(() => after?.())
      .catch((e: unknown) => setError(say(e)))
      .finally(() => {
        setBusy(false)
        setArmed(false)
        setConfirming(false)
      })
  }
  const box = 'w-full min-w-0 resize-y rounded-md border bg-background px-2 py-1 text-[0.75rem] leading-snug outline-none focus-visible:ring-2 focus-visible:ring-ring'

  return (
    <article className={cn('flex min-w-0 flex-col gap-1 rounded-md border bg-card px-2 py-1.5 text-[0.7rem] leading-4', reply.by === 'agent' && !reply.sent && !reply.editedAt && 'border-l-2 border-l-agent')} data-reply={reply.id}>
      <div className="flex min-w-0 flex-wrap items-center gap-1">
        <Who by={reply.editedAt ? 'person' : reply.by} />
        <Badge variant={reply.sent ? 'secondary' : 'outline'} className="px-1.5 text-[0.65rem]">
          {reply.sent ? 'posted' : 'draft'}
        </Badge>
        <span className="min-w-0 flex-1 truncate font-mono text-muted-foreground" title={reply.where}>
          {reply.where}
        </span>
        {reply.sent?.url ? (
          <a className="underline underline-offset-2" href={reply.sent.url} target="_blank" rel="noopener noreferrer">
            on the tracker
          </a>
        ) : null}
      </div>
      <blockquote className="border-l-2 pl-2 whitespace-pre-wrap text-muted-foreground [overflow-wrap:anywhere]">
        <span className="font-semibold">{reply.from || 'somebody'}:</span> {reply.said}
      </blockquote>
      {editing ? (
        <>
          <label className="text-muted-foreground" htmlFor={`reply-${reply.id}`}>
            Your reply
          </label>
          <textarea id={`reply-${reply.id}`} className={box} rows={3} maxLength={MAX_BODY} value={body} onChange={(e) => setBody(e.target.value)} disabled={busy} />
          <label className="text-muted-foreground" htmlFor={`todo-${reply.id}`}>
            What to change (not posted)
          </label>
          <textarea id={`todo-${reply.id}`} className={box} rows={2} maxLength={MAX_BODY} value={todo} onChange={(e) => setTodo(e.target.value)} disabled={busy} />
        </>
      ) : (
        <>
          <p className="whitespace-pre-wrap text-[0.75rem] leading-snug [overflow-wrap:anywhere]">{reply.body}</p>
          {reply.todo ? <p className="whitespace-pre-wrap text-muted-foreground [overflow-wrap:anywhere]">To change: {reply.todo}</p> : null}
        </>
      )}
      {error ? (
        <p role="alert" className="rounded-md border border-del-mark/50 bg-del px-2 py-1">
          {error}
        </p>
      ) : null}
      {reply.sent ? null : confirming ? (
        <div className="flex flex-col gap-1 rounded-md border border-ring bg-background p-2" data-testid="reply-confirm">
          <p>
            Nothing has been posted yet. This reply goes to {reply.where} on {tracker}, under your own login, exactly as shown above.
          </p>
          <div className="flex flex-wrap items-center justify-end gap-1">
            <Button type="button" variant="ghost" size="sm" className={SMALL} onClick={() => setConfirming(false)} disabled={busy}>
              Not yet
            </Button>
            <Button type="button" size="sm" className={SMALL} disabled={busy} onClick={() => act(() => onSend(reply.id, reply.body))}>
              {busy ? 'Posting…' : 'Post it'}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center justify-end gap-1">
          {editing ? (
            <>
              <Button type="button" variant="ghost" size="sm" className={SMALL} onClick={() => setEditing(false)} disabled={busy}>
                Cancel
              </Button>
              <Button type="button" size="sm" className={SMALL} disabled={busy || !body.trim()} onClick={() => act(() => onReword(reply.id, body, todo), () => setEditing(false))}>
                Save
              </Button>
            </>
          ) : (
            <>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className={SMALL}
                onClick={() => {
                  setBody(reply.body)
                  setTodo(reply.todo)
                  setEditing(true)
                }}
              >
                Edit
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className={cn(SMALL, armed && 'text-destructive')}
                onBlur={() => setArmed(false)}
                onClick={() => (armed ? act(() => onDrop(reply.id)) : setArmed(true))}
              >
                {armed ? 'Remove it?' : 'Remove'}
              </Button>
              <Button type="button" variant="outline" size="sm" className={SMALL} onClick={() => setConfirming(true)}>
                Post reply…
              </Button>
            </>
          )}
        </div>
      )}
    </article>
  )
}
