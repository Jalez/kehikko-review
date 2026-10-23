import { useEffect, useRef, useState } from 'react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

import { MAX_BODY, stateOf, type Comment, type EvidenceKind, type Meta, type PointState, type Severity } from '../../review/shape.ts'

import { useHolding } from './holding.ts'
import { codeLabel } from './where.ts'
import { OutLink } from './out-link.tsx'

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

/**
 * One point of the review, as a card: its code reference (pressing it points Source and Diff at the
 * lines), who wrote it and where it stands, its words, what a run said about it, the evidence
 * attached to it, and — while it is a draft — Edit, Keep and Remove.
 *
 * A SENT point offers none of those. It is on the tracker, where people may have read and answered
 * it; the copy here is a record of what was said, and a record that can be edited is not one. It can
 * be marked resolved (and opened again). The server refuses the rest as well (`review/draft.ts`);
 * this is the page not offering what would be refused.
 */
export function PointCard({
  comment,
  stale,
  located,
  evidence,
  onLocate,
  onReword,
  onDrop,
  onKeep,
  onResolve,
}: {
  comment: Comment
  /** Why this point is not against the current code, when it is not. */
  stale?: string | null
  /** What became of the last press on its code reference, when it was not taken. */
  located?: string | null
  /** The evidence attached to it, drawn small. */
  evidence?: React.ReactNode
  onLocate(): void
  onReword(id: string, body: string): Promise<void>
  onDrop(id: string): Promise<void>
  onKeep(id: string): Promise<void>
  onResolve(id: string, resolved: boolean): Promise<void>
}) {
  /* A reword somebody was in the middle of when the page reloaded reopens. */
  const holding = useHolding()
  const [editing, setEditing] = useState(() => holding.read(`reword:${comment.id}`) !== null)
  /* Remove takes two presses. `confirm()` is not available to a framed page, and one press on a
     small button in a narrow frame is too easy to make by accident for something that deletes a
     paragraph. */
  const [armed, setArmed] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const state = stateOf(comment)
  const act = (does: Promise<void>) => {
    setError(null)
    does.catch((e: unknown) => {
      setError(say(e))
      setArmed(false)
    })
  }

  if (editing) {
    return (
      <Composer
        label={`Reword the point on ${codeLabel(comment)}`}
        initial={comment.body}
        saveLabel="Save"
        onSave={(body) => onReword(comment.id, body).then(() => setEditing(false))}
        onCancel={() => setEditing(false)}
        held={{ target: `reword:${comment.id}`, aim: `a rewording of the point on ${codeLabel(comment)}` }}
      />
    )
  }

  return (
    <article
      className={cn(
        'flex min-w-0 flex-col gap-1 rounded-md border bg-card px-2 py-1.5 font-sans text-[0.7rem] leading-4',
        comment.by === 'agent' && state === 'draft' && 'border-l-2 border-l-agent',
      )}
      data-comment={comment.id}
      data-sent={comment.sent ? 'yes' : 'no'}
      data-state={state}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-1">
        <Who by={comment.by} />
        <Badge variant={state === 'draft' ? 'outline' : 'secondary'} className="px-1.5 text-[0.65rem]">
          {STATE_WORD[state]}
          {comment.sent?.folded ? ', in the summary' : ''}
        </Badge>
        {comment.meta ? (
          <Badge variant="outline" className="px-1.5 text-[0.65rem]">
            {SEVERITY_WORD[comment.meta.severity]}
          </Badge>
        ) : null}
        {/* A path is one unbroken string. `min-w-0` and `truncate` are what stop it from sizing the
            row, and the row from sizing the page. */}
        <button
          type="button"
          className="min-w-0 flex-1 truncate text-left font-mono text-muted-foreground underline decoration-dotted underline-offset-2 hover:text-foreground"
          title={`Show ${comment.path} at ${comment.startLine !== undefined ? `lines ${comment.startLine}–${comment.line}` : `line ${comment.line}`} in Source and Diff`}
          data-code={comment.id}
          onClick={onLocate}
        >
          {codeLabel(comment)}
        </button>
        {comment.sent?.url ? (
          <OutLink href={comment.sent.url}>on the tracker</OutLink>
        ) : null}
      </div>
      {located ? <p className="text-muted-foreground" data-testid="located">{located}</p> : null}
      {stale ? <p className="text-del-mark">{stale}</p> : null}
      {comment.quote.trim() ? (
        <pre className="max-h-24 min-w-0 overflow-auto rounded-sm bg-muted px-1.5 py-1 font-mono text-[0.65rem] leading-4 whitespace-pre">{comment.quote}</pre>
      ) : null}
      <p className="whitespace-pre-wrap text-[0.75rem] leading-snug [overflow-wrap:anywhere]">{comment.body}</p>
      {comment.meta ? <Point meta={comment.meta} /> : null}
      {evidence}
      {error ? (
        <p role="alert" className="rounded-md border border-del-mark/50 bg-del px-2 py-1">
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center justify-end gap-1">
        {comment.sent ? (
          <Button type="button" variant="ghost" size="sm" className={SMALL} onClick={() => act(onResolve(comment.id, !comment.resolved))}>
            {comment.resolved ? 'Open again' : 'Mark resolved'}
          </Button>
        ) : (
          <>
            <Button type="button" variant="ghost" size="sm" className={SMALL} onClick={() => setEditing(true)}>
              Edit
            </Button>
            {comment.by === 'agent' && !comment.kept ? (
              <Button type="button" variant="outline" size="sm" className={SMALL} onClick={() => act(onKeep(comment.id))}>
                Keep
              </Button>
            ) : null}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className={cn(SMALL, armed && 'text-destructive')}
              onBlur={() => setArmed(false)}
              onClick={() => (armed ? act(onDrop(comment.id)) : setArmed(true))}
            >
              {armed ? 'Remove it?' : 'Remove'}
            </Button>
          </>
        )}
      </div>
    </article>
  )
}

const STATE_WORD: Record<PointState, string> = { draft: 'draft', kept: 'kept', sent: 'sent', resolved: 'resolved' }

const SEVERITY_WORD: Record<Severity, string> = { blocking: 'Blocking', risk: 'Risk', nice: 'Nice to have' }
const EVIDENCE_WORD: Record<EvidenceKind, string> = { line: 'Line', test: 'Test', doc: 'Document', practice: 'Practice' }

/** An https address, or null: only such a source is drawn as a link. Anything else is text. */
export function httpsOnly(ref: string): string | null {
  try {
    const url = new URL(ref)
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null
  } catch {
    return null
  }
}

/**
 * What a review run says about one of its points, under the words that would be posted: how bad,
 * whether the judge ruled it required, why, on which evidence, and the case made against it. In
 * words, never colour alone. The severity is on the card's first row.
 */
export function Point({ meta }: { meta: Meta }) {
  return (
    <div data-testid="point" className="flex min-w-0 flex-col gap-0.5 rounded-md border bg-background px-2 py-1 text-[0.7rem] leading-4">
      <p className="flex min-w-0 flex-wrap items-center gap-1">
        <Badge variant={meta.ruling === 'required' ? 'default' : 'secondary'} className="px-1.5 text-[0.65rem]">
          {meta.ruling === 'required' ? 'Required' : 'Optional'}
        </Badge>
        <span className="min-w-0 [overflow-wrap:anywhere]">{meta.reason}</span>
      </p>
      <ul className="flex min-w-0 flex-col gap-0.5 text-muted-foreground">
        {meta.evidence.map((one, at) => {
          const link = httpsOnly(one.ref)
          return (
            <li key={at} className="min-w-0 [overflow-wrap:anywhere]">
              {EVIDENCE_WORD[one.kind]}:{' '}
              {link ? (
                <OutLink href={link}>{one.ref}</OutLink>
              ) : (
                <span className="font-mono">{one.ref}</span>
              )}
              {one.quote ? <span> — “{one.quote}”</span> : null}
            </li>
          )
        })}
      </ul>
      {meta.challenge ? <p className="[overflow-wrap:anywhere]">Challenge: {meta.challenge}</p> : null}
      {meta.checklist?.length ? <p className="text-muted-foreground">Checklist: {meta.checklist.join(', ')}</p> : null}
      <p className="text-muted-foreground">From review run {meta.run}.</p>
    </div>
  )
}
