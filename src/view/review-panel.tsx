import { useEffect, useRef, useState } from 'react'

import { useHolding } from './holding.ts'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { Confirmed } from '@/wire/api'

import type { Report } from '../../review/send.ts'
import { MAX_SUMMARY, short, type Comment, type Draft, type Verdict } from '../../review/shape.ts'

import { CommentCard, SMALL, frameOf, place } from './comment.tsx'

/**
 * "Your review": everything that is waiting to be sent, and the sending.
 *
 * ## Why the whole draft is listed here as well as inline
 *
 * The diff shows the comments of ONE view — the whole change, or one commit —
 * because a comment's line numbers only mean something in the diff they were
 * written in. So at any moment most of a review is somewhere the person is not
 * looking. This panel is the one place the review exists as a whole: every
 * comment, whichever view it belongs to, with a way to go and see it.
 *
 * ## Sending is two presses, and the first one shows the receipt in advance
 *
 * A review is posted under the person's own name to people they work with, and
 * part of it may have been written by an agent. So the first press does not
 * send; it states exactly what would be posted — how many comments, how many of
 * them an agent wrote, where to, as whom, with which verdict — and the second
 * press posts THAT. The ids, verdict and summary shown are sent along and the
 * server refuses if the draft has changed since (see `send` in doors.ts), so
 * what was read is what goes out.
 */

const VERDICT_WORD: Record<Verdict, string> = { comment: 'Comment', approve: 'Approve', 'request-changes': 'Request changes' }

const say = (error: unknown): string => (error instanceof Error ? error.message : String(error))

export function ReviewPanel({
  draft,
  head,
  commits,
  tracker,
  refName,
  login,
  onJump,
  onReword,
  onDrop,
  onSummary,
  onVerdict,
  onConfirming,
  onSend,
}: {
  draft: Draft
  /** The change's head now. A whole-change comment written at another head is marked. */
  head: string
  /** The change's commits now. A commit comment whose commit has gone is marked. */
  commits: readonly string[]
  tracker: 'GitHub' | 'GitLab'
  refName: string
  /** Whose login it would go out under, when known. */
  login: string | null
  onJump(comment: Comment): void
  onReword(id: string, body: string): Promise<void>
  onDrop(id: string): Promise<void>
  onSummary(summary: string): Promise<void>
  onVerdict(verdict: Verdict): Promise<void>
  /** The confirmation has opened: the moment to find out whose login this is. */
  onConfirming(): void
  onSend(confirmed: Confirmed): Promise<Report>
}) {
  /*
   * The summary is saved when the box is left, so words typed and not yet left are only here — and
   * a page that reloads under them (it does, when it finds it is older than its server) would lose
   * them. They are held as they are typed (`holding.ts`) and come back in the box, still
   * counted as unsaved, so the next blur or Send saves them.
   */
  const holding = useHolding()
  const heldSummary = useRef(holding.read('summary')).current
  const [summaryFrom, setSummaryFrom] = useState<string | null>(heldSummary?.base ?? null)
  const [summary, setSummary] = useState(heldSummary?.text ?? draft.summary)
  /* Whether the box holds words the server has not got yet. While it does, a
     re-read of the draft (the slow interval, an agent's write) must not replace
     what the person is in the middle of typing. */
  const dirty = useRef(heldSummary !== null)
  useEffect(() => {
    if (!dirty.current) setSummary(draft.summary)
  }, [draft.summary])

  const [confirming, setConfirming] = useState<Confirmed | null>(null)
  const [sending, setSending] = useState(false)
  const [report, setReport] = useState<Report | null>(null)
  const [error, setError] = useState<string | null>(null)

  const waiting = draft.comments.filter((c) => !c.sent)
  const gone = draft.comments.filter((c) => c.sent)
  const cli = tracker === 'GitHub' ? 'gh' : 'glab'

  const staleness = (comment: Comment): string | null => {
    if (comment.sent) return null
    if (comment.view === 'all' && comment.commit !== head) {
      return `Written against ${short(comment.commit)}, an older head: the change has been pushed to since. It is not moved; it will be sent against the commit it was written on.`
    }
    if (comment.view === 'commit' && !commits.includes(comment.commit)) {
      return `Written on commit ${short(comment.commit)}, which is no longer one of this change’s commits. The tracker may not be able to place it, and it would then go into the summary as text.`
    }
    return null
  }

  const saveSummary = async () => {
    if (!dirty.current) return
    await onSummary(summary)
    dirty.current = false
    holding.keep('summary', null)
    setSummaryFrom(null)
  }

  const begin = () => {
    setError(null)
    setReport(null)
    /* The summary is saved first, so that the draft the server compares the
       confirmation against is the one on screen. */
    saveSummary()
      .then(() => {
        if (!draft.verdict) return setError('Choose a verdict first: Comment, Approve or Request changes.')
        setConfirming({ ids: waiting.map((c) => c.id), verdict: draft.verdict, summary })
        onConfirming()
      })
      .catch((e: unknown) => setError(say(e)))
  }

  const post = () => {
    if (!confirming || sending) return
    setSending(true)
    setError(null)
    onSend(confirming)
      .then((made) => {
        setReport(made)
        setConfirming(null)
      })
      .catch((e: unknown) => {
        setError(say(e))
        setConfirming(null)
      })
      .finally(() => setSending(false))
  }

  const byAgent = confirming ? waiting.filter((c) => confirming.ids.includes(c.id) && c.by === 'agent').length : 0
  const nothing = !waiting.length && !summary.trim() && (!draft.verdict || draft.verdict === 'comment')

  return (
    <section className="flex min-w-0 flex-col gap-1.5 rounded-md border bg-card p-2 text-[0.7rem] leading-4" aria-label="Your review">
      <h2 className="text-[0.75rem] font-semibold">
        Your review
        <span className="font-normal text-muted-foreground">
          {' '}
          — {waiting.length} draft {waiting.length === 1 ? 'comment' : 'comments'}
          {gone.length ? `, ${gone.length} sent` : ''}
        </span>
      </h2>

      {waiting.length ? (
        <ul className="flex min-w-0 flex-col gap-1">
          {waiting.map((comment) => (
            <li key={comment.id} className="min-w-0">
              <CommentCard
                comment={comment}
                where={`${place(comment)} · ${frameOf(comment)}`}
                stale={staleness(comment)}
                onReword={onReword}
                onDrop={onDrop}
                onJump={() => onJump(comment)}
              />
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-muted-foreground">
          No draft comments yet. Press a line number in the diff to comment on that line; shift-press a second one to cover a range.
        </p>
      )}

      <label htmlFor="summary" className="pt-1 text-muted-foreground">
        Summary — the review’s overall comment
      </label>
      <textarea
        id="summary"
        value={summary}
        rows={3}
        maxLength={MAX_SUMMARY}
        disabled={sending || confirming !== null}
        onChange={(event) => {
          dirty.current = true
          setSummary(event.target.value)
          const base = summaryFrom ?? draft.summary
          if (summaryFrom === null) setSummaryFrom(base)
          holding.keep('summary', { base, text: event.target.value, aim: 'the review’s summary' })
        }}
        /* Saved when the box is left, not on every key: each save is a write to
           a file in the project, and an agent reading the draft mid-word gains
           nothing from half a sentence. */
        onBlur={() => void saveSummary().catch((e: unknown) => setError(say(e)))}
        className="w-full min-w-0 resize-y rounded-md border bg-background px-2 py-1 text-[0.75rem] leading-snug outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />

      {dirty.current && summaryFrom !== null && summaryFrom !== draft.summary ? (
        <p data-testid="summary-stale" className="rounded-md border border-del-mark/50 bg-del px-2 py-1">
          The saved summary was changed after these words were typed. It now says: “
          {draft.summary.length > 160 ? `${draft.summary.slice(0, 159)}…` : draft.summary}” — leaving this box, or sending, replaces that.
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-1" role="radiogroup" aria-label="Verdict">
        {(Object.keys(VERDICT_WORD) as Verdict[]).map((verdict) => (
          <Button
            key={verdict}
            type="button"
            role="radio"
            aria-checked={draft.verdict === verdict}
            variant={draft.verdict === verdict ? 'default' : 'outline'}
            size="sm"
            className={SMALL}
            disabled={sending || confirming !== null}
            onClick={() => void onVerdict(verdict).catch((e: unknown) => setError(say(e)))}
          >
            {VERDICT_WORD[verdict]}
          </Button>
        ))}
      </div>

      {confirming ? (
        <div className="flex flex-col gap-1 rounded-md border border-ring bg-background p-2" data-testid="confirm">
          <p className="font-semibold">Nothing has been posted yet. This is what will be:</p>
          <ul className="list-disc pl-4">
            <li>
              To <span className="font-mono">{refName}</span> on {tracker}, through your own <code>{cli}</code> login
              {login ? (
                <>
                  {' '}
                  — as <span className="font-mono">{login}</span>
                </>
              ) : null}
              .
            </li>
            <li>
              {confirming.ids.length} {confirming.ids.length === 1 ? 'comment' : 'comments'}
              {byAgent ? `, ${byAgent} of them drafted by an agent and posted under your name` : ''}.
            </li>
            <li>{confirming.summary.trim() ? `A summary of ${confirming.summary.trim().length} characters.` : 'No summary.'}</li>
            <li>
              Verdict: <strong>{VERDICT_WORD[confirming.verdict]}</strong>
              {tracker === 'GitLab' && confirming.verdict === 'request-changes'
                ? ' — said in words at the top of the summary; GitLab is not asked to set a reviewer state.'
                : '.'}
            </li>
          </ul>
          <p className="text-muted-foreground">
            A comment the tracker will not attach to its line is not dropped: it is written into the summary, with its file, line and quoted
            source.
          </p>
          <div className="flex flex-wrap items-center justify-end gap-1">
            <Button type="button" variant="ghost" size="sm" className={SMALL} onClick={() => setConfirming(null)} disabled={sending}>
              Not yet
            </Button>
            <Button type="button" size="sm" className={SMALL} onClick={post} disabled={sending}>
              {sending ? 'Posting…' : `Post it to ${tracker}`}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-1">
          <span className="min-w-0 text-muted-foreground">Only you send. Nothing is posted until you confirm.</span>
          <Button type="button" size="sm" className={SMALL} onClick={begin} disabled={nothing || sending}>
            Send review…
          </Button>
        </div>
      )}

      {error ? (
        /* The tracker's own words where it said any: "gh auth login" and "Can
           not approve your own pull request" are worth more than a paraphrase. */
        <p role="alert" className="rounded-md border border-del-mark/50 bg-del px-2 py-1">
          {error}
        </p>
      ) : null}

      {report ? (
        <div
          className={cn('flex flex-col gap-1 rounded-md border px-2 py-1', report.complete ? 'border-add-mark/50 bg-add' : 'border-del-mark/50 bg-del')}
          role="status"
          data-testid="report"
        >
          <p className="font-semibold">{report.complete ? 'Sent.' : 'Sending stopped part-way.'}</p>
          <ul className="list-disc pl-4">
            {report.notes.map((note, at) => (
              <li key={at}>{note}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {gone.length ? (
        <details className="min-w-0">
          <summary className="cursor-pointer text-muted-foreground">
            {gone.length} sent {gone.length === 1 ? 'comment' : 'comments'}
          </summary>
          <ul className="flex min-w-0 flex-col gap-1 pt-1">
            {gone.map((comment) => (
              <li key={comment.id} className="min-w-0">
                <CommentCard comment={comment} where={`${place(comment)} · ${frameOf(comment)}`} onReword={onReword} onDrop={onDrop} onJump={() => onJump(comment)} />
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  )
}
