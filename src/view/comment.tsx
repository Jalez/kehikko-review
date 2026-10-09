import { useEffect, useRef, useState } from 'react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

import { MAX_BODY, short, type Comment } from '../../review/shape.ts'

import { useHolding } from './holding.ts'

/** The small button every control in a narrow frame uses: a target, not a billboard. */
export const SMALL = 'h-6 px-2 text-[0.7rem]'

const say = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/**
 * Where words are typed: for a new comment, and for rewording one.
 *
 * `onSave` is a promise and the box stays open until it resolves. A refusal —
 * the server would not anchor the comment, the ticket was stale — is shown
 * here, under the words, with the words still in the box. Clearing a
 * paragraph somebody just wrote because the save failed is the one thing a
 * composer must never do.
 */
export function Composer({
  label,
  initial = '',
  saveLabel,
  onSave,
  onCancel,
  held,
}: {
  /** What the box is for, said to a screen reader and shown above it: "Comment on new line 12". */
  label: string
  initial?: string
  saveLabel: string
  onSave(body: string): Promise<void>
  onCancel(): void
  /**
   * Where these words are held while they are typed, so a reload of the page finds them: the
   * target they are aimed at, and that aim in words. Absent, nothing is held.
   */
  held?: { target: string; aim: string }
}) {
  const holding = useHolding()
  /* What was there when the typing started: the comment's own words for a reword, nothing for a new one. */
  const was = useRef(held ? holding.read(held.target) : null).current
  const base = was?.base ?? initial
  const keep = (text: string | null) => {
    if (held) holding.keep(held.target, text === null ? null : { base, text, aim: held.aim })
  }
  const [body, setBody] = useState(was?.text ?? initial)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const box = useRef<HTMLTextAreaElement>(null)

  /* Focused on the way in: the box appeared because of a press, and the next
     thing the person does is type. */
  useEffect(() => {
    box.current?.focus()
  }, [])

  const save = () => {
    if (!body.trim() || saving) return
    setSaving(true)
    setError(null)
    onSave(body)
      /* Kept by the store: there is nothing left to hold. A refusal leaves the words held, and in the box. */
      .then(() => keep(null))
      /* On success the parent unmounts this; nothing to reset. */
      .catch((e: unknown) => {
        setError(say(e))
        setSaving(false)
      })
  }

  /* Cancel is throwing the words away on purpose, the held copy with them. */
  const cancel = () => {
    keep(null)
    onCancel()
  }

  return (
    <div className="flex flex-col gap-1 border-y bg-card px-2 py-1.5 font-sans text-[0.7rem] leading-4">
      <label className="text-muted-foreground" htmlFor={`box-${label}`}>
        {label}
      </label>
      <textarea
        ref={box}
        id={`box-${label}`}
        value={body}
        maxLength={MAX_BODY}
        rows={3}
        disabled={saving}
        onChange={(event) => {
          setBody(event.target.value)
          keep(event.target.value)
        }}
        onKeyDown={(event) => {
          /* Enter is a newline in a comment, so saving is the chord every
             tracker's own box uses. Escape abandons only an empty box: losing
             a paragraph to a stray key is worse than pressing Cancel. */
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) save()
          if (event.key === 'Escape' && !body.trim()) cancel()
        }}
        className="w-full min-w-0 resize-y rounded-md border bg-background px-2 py-1 font-sans text-[0.75rem] leading-snug outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
      {was && was.base !== initial ? (
        <p data-testid="held-stale" className="rounded-md border border-del-mark/50 bg-del px-2 py-1">
          This comment was changed after these words were typed. It now says: “{initial.length > 160 ? `${initial.slice(0, 159)}…` : initial}” — saving
          replaces that.
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="rounded-md border border-del-mark/50 bg-del px-2 py-1">
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center justify-end gap-1">
        <Button type="button" variant="ghost" size="sm" className={SMALL} onClick={cancel} disabled={saving}>
          Cancel
        </Button>
        <Button type="button" size="sm" className={SMALL} onClick={save} disabled={saving || !body.trim()}>
          {saving ? 'Saving…' : saveLabel}
        </Button>
      </div>
    </div>
  )
}

/** Who wrote it, as a word. An agent's draft is the person's to check before it goes out under their name. */
export function Who({ by }: { by: Comment['by'] }) {
  return by === 'agent' ? (
    <Badge variant="outline" className="border-agent/50 px-1.5 text-[0.65rem] text-agent">
      agent
    </Badge>
  ) : (
    <Badge variant="outline" className="px-1.5 text-[0.65rem]">
      you
    </Badge>
  )
}

/** Where a comment is, in the words of the frame it was written in. */
export function place(comment: Comment): string {
  const lines = comment.startLine !== undefined ? `${comment.startLine}–${comment.line}` : String(comment.line)
  return `${comment.path}:${lines}${comment.side === 'old' ? ' (old)' : ''}`
}

/**
 * One draft comment: who wrote it, the words, and — while it is still a draft —
 * a way to change or remove it.
 *
 * A SENT comment is drawn the same and offers neither. It is on the tracker,
 * where people may have read and answered it; the copy here is a record of
 * what was said, and a record that can be edited is not one. The server
 * refuses both as well (`review/draft.ts`); this is the page not offering
 * what would be refused.
 */
export function CommentCard({
  comment,
  where,
  stale,
  onReword,
  onDrop,
  onJump,
}: {
  comment: Comment
  /** Shown in the review panel, where the comment is away from its line. */
  where?: string
  /** Why this comment is not against the current code, when it is not. */
  stale?: string | null
  onReword(id: string, body: string): Promise<void>
  onDrop(id: string): Promise<void>
  onJump?: () => void
}) {
  /*
   * A reword somebody was in the middle of when the page reloaded reopens — in the review panel's
   * copy of the card (the one with `where`), which is drawn whatever the diff is showing; the copy
   * beside the line is the same comment and would be a second box over the same words.
   */
  const holding = useHolding()
  const [editing, setEditing] = useState(() => where !== undefined && holding.read(`reword:${comment.id}`) !== null)
  /* Remove takes two presses. `confirm()` is not available to a framed page,
     and one press on a small button in a narrow frame is too easy to make by
     accident for something that deletes a paragraph. */
  const [armed, setArmed] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (editing) {
    return (
      <Composer
        label={`Reword the comment on ${place(comment)}`}
        initial={comment.body}
        saveLabel="Save"
        onSave={(body) => onReword(comment.id, body).then(() => setEditing(false))}
        onCancel={() => setEditing(false)}
        held={{ target: `reword:${comment.id}`, aim: `a rewording of the comment on ${place(comment)}` }}
      />
    )
  }

  return (
    <div
      className={cn('flex flex-col gap-1 border-y bg-card px-2 py-1.5 font-sans text-[0.7rem] leading-4', comment.by === 'agent' && !comment.sent && 'border-l-2 border-l-agent')}
      data-comment={comment.id}
      data-sent={comment.sent ? 'yes' : 'no'}
    >
      <div className="flex flex-wrap items-center gap-1">
        <Who by={comment.by} />
        {comment.sent ? (
          <Badge variant="secondary" className="px-1.5 text-[0.65rem]">
            {comment.sent.folded ? 'sent, in the summary' : 'sent'}
          </Badge>
        ) : null}
        {where ? (
          /* A path is one unbroken string. `min-w-0` and `truncate` are what
             stop it from sizing the row, and the row from sizing the page. */
          <span className="min-w-0 flex-1 truncate font-mono text-muted-foreground" title={where}>
            {where}
          </span>
        ) : null}
        {onJump ? (
          <Button type="button" variant="link" size="sm" className="h-auto p-0 text-[0.7rem]" onClick={onJump}>
            show
          </Button>
        ) : null}
        {comment.sent?.url ? (
          <a className="underline underline-offset-2" href={comment.sent.url} target="_blank" rel="noopener noreferrer">
            on the tracker
          </a>
        ) : null}
      </div>
      {stale ? <p className="text-del-mark">{stale}</p> : null}
      <p className="whitespace-pre-wrap text-[0.75rem] leading-snug">{comment.body}</p>
      {error ? (
        <p role="alert" className="rounded-md border border-del-mark/50 bg-del px-2 py-1">
          {error}
        </p>
      ) : null}
      {comment.sent ? null : (
        <div className="flex flex-wrap items-center justify-end gap-1">
          <Button type="button" variant="ghost" size="sm" className={SMALL} onClick={() => setEditing(true)}>
            Edit
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className={cn(SMALL, armed && 'text-destructive')}
            onBlur={() => setArmed(false)}
            onClick={() => {
              if (!armed) return setArmed(true)
              setError(null)
              onDrop(comment.id).catch((e: unknown) => {
                setError(say(e))
                setArmed(false)
              })
            }}
          >
            {armed ? 'Remove it?' : 'Remove'}
          </Button>
        </div>
      )}
    </div>
  )
}

/** A comment's frame, as a few words: which diff its line numbers are from. */
export function frameOf(comment: Comment): string {
  return comment.view === 'all' ? `all changes at ${short(comment.commit)}` : `commit ${short(comment.commit)}`
}
