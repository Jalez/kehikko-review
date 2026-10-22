import { useEffect, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { Confirmed } from '@/wire/api'

import { personMaySend, proposalBody } from '../../review/draft.ts'
import type { Report } from '../../review/send.ts'
import { MAX_SUMMARY, short, type Comment, type Draft, type Proposal, type Verdict } from '../../review/shape.ts'

import { Composer, PointCard, SMALL } from './comment.tsx'
import { EvidenceList, type EvidenceAccess } from './evidence.tsx'
import { useHolding } from './holding.ts'
import { Replies } from './replies.tsx'
import { codeLabel, placeLabel, type Place } from './where.ts'

/**
 * The review, as one document: what a person reads top to bottom and sends once.
 *
 * 1. **Verdict and summary**, with a review run's proposal beside them ("To get this approved:").
 * 2. **Points**, each a card with its code reference — pressing it points Source and Diff at those
 *    lines — its severity, the evidence attached to it, the challenge and the ruling, and Edit,
 *    Keep and Remove. A new point opens here when somebody asks for a comment at a place.
 * 3. **Evidence**: screenshots, run logs and test output kept beside the review.
 * 4. **Replies**, on a change the person authored.
 * 5. **Send**: two presses, the first showing exactly what would be posted.
 *
 * The file behind it is `.kehikot/review/<key>.md`; this page is how a person reads and changes it.
 *
 * ## Only what the person decided is sent
 *
 * An agent's point is a draft until the person keeps it (Keep, or by editing its words). The send
 * posts the person's own points and the ones they kept, and says how many agent points stay behind.
 * The ids, verdict and summary shown are sent along and the server refuses if the review has changed
 * since (`send` in doors.ts), so what was read is what goes out.
 */

const VERDICT_WORD: Record<Verdict, string> = { comment: 'Comment', approve: 'Approve', 'request-changes': 'Request changes' }

const say = (error: unknown): string => (error instanceof Error ? error.message : String(error))

export interface DocumentActions {
  onLocate(comment: Comment): Promise<string | null>
  onAddPoint(place: Place, body: string): Promise<void>
  onReword(id: string, body: string): Promise<void>
  onDrop(id: string): Promise<void>
  onKeep(id: string): Promise<void>
  onResolve(id: string, resolved: boolean): Promise<void>
  onDropEvidence(id: string): Promise<void>
  onSummary(summary: string): Promise<void>
  onVerdict(verdict: Verdict): Promise<void>
  /** The confirmation has opened: the moment to find out whose login this is. */
  onConfirming(): void
  onSend(confirmed: Confirmed): Promise<Report>
  /** The person takes a review run's proposed summary or verdict. Absent, the proposal is shown and cannot be taken. */
  onTake?(which: 'summary' | 'verdict', run: string): Promise<void>
  onReplyReword(id: string, body: string, todo: string): Promise<void>
  onReplyDrop(id: string): Promise<void>
  onReplySend(id: string, body: string): Promise<void>
}

export function ReviewDocument({
  draft,
  head,
  commits,
  tracker,
  refName,
  login,
  access,
  asked,
  onAsked,
  actions,
}: {
  draft: Draft
  /** The change's head now. A whole-change point written at another head is marked. */
  head: string
  /** The change's commits now. A commit's point whose commit has gone is marked. */
  commits: readonly string[]
  tracker: 'GitHub' | 'GitLab'
  refName: string
  /** Whose login it would go out under, when known. */
  login: string | null
  access: EvidenceAccess
  /** A place somebody asked for a comment at (`context.location`, intent `comment`). */
  asked: Place | null
  /** The new point at `asked` was saved or cancelled. */
  onAsked(): void
  actions: DocumentActions
}) {
  /*
   * The summary is saved when the box is left, so words typed and not yet left are only here — and
   * a page that reloads under them (it does, when it finds it is older than its server) would lose
   * them. They are held as they are typed (`holding.ts`) and come back in the box, still counted as
   * unsaved, so the next blur or Send saves them.
   */
  const holding = useHolding()
  const heldSummary = useRef(holding.read('summary')).current
  const [summaryFrom, setSummaryFrom] = useState<string | null>(heldSummary?.base ?? null)
  const [summary, setSummary] = useState(heldSummary?.text ?? draft.summary)
  /* Whether the box holds words the server has not got yet. While it does, a re-read of the review
     (the slow interval, an agent's write) must not replace what the person is in the middle of typing. */
  const dirty = useRef(heldSummary !== null)
  useEffect(() => {
    if (!dirty.current) setSummary(draft.summary)
  }, [draft.summary])

  const [confirming, setConfirming] = useState<Confirmed | null>(null)
  const [sending, setSending] = useState(false)
  const [report, setReport] = useState<Report | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [located, setLocated] = useState<{ id: string; said: string } | null>(null)

  const waiting = draft.comments.filter((c) => !c.sent)
  const gone = draft.comments.filter((c) => c.sent)
  const sendable = draft.comments.filter(personMaySend)
  const notKept = waiting.length - sendable.length
  const cli = tracker === 'GitHub' ? 'gh' : 'glab'
  const labels = new Map(draft.comments.map((c) => [c.id, codeLabel(c)]))

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
    await actions.onSummary(summary)
    dirty.current = false
    holding.keep('summary', null)
    setSummaryFrom(null)
  }

  const begin = () => {
    setError(null)
    setReport(null)
    /* The summary is saved first, so that the review the server compares the confirmation against is the one on screen. */
    saveSummary()
      .then(() => {
        if (!draft.verdict) return setError('Choose a verdict first: Comment, Approve or Request changes.')
        setConfirming({ ids: sendable.map((c) => c.id), verdict: draft.verdict, summary })
        actions.onConfirming()
      })
      .catch((e: unknown) => setError(say(e)))
  }

  const post = () => {
    if (!confirming || sending) return
    setSending(true)
    setError(null)
    actions
      .onSend(confirming)
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

  const locate = (comment: Comment) => {
    setLocated(null)
    void actions.onLocate(comment).then((said) => setLocated(said ? { id: comment.id, said } : null))
  }

  const byAgent = confirming ? sendable.filter((c) => confirming.ids.includes(c.id) && c.by === 'agent').length : 0
  const nothing = !sendable.length && !summary.trim() && (!draft.verdict || draft.verdict === 'comment')
  const card = (comment: Comment) => (
    <li key={comment.id} className="min-w-0">
      <PointCard
        comment={comment}
        stale={staleness(comment)}
        located={located?.id === comment.id ? located.said : null}
        evidence={<EvidenceList proofs={draft.evidence.filter((p) => p.point === comment.id)} access={access} small />}
        onLocate={() => locate(comment)}
        onReword={actions.onReword}
        onDrop={actions.onDrop}
        onKeep={actions.onKeep}
        onResolve={actions.onResolve}
      />
    </li>
  )

  return (
    <article className="flex min-w-0 flex-col gap-3 text-[0.7rem] leading-4" aria-label="The review">
      {/* ---- 1. verdict and summary ---- */}
      <section className="flex min-w-0 flex-col gap-1.5 rounded-md border bg-card p-2" aria-label="Verdict and summary">
        <h3 className="text-[0.75rem] font-semibold">Verdict and summary</h3>
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
              onClick={() => void actions.onVerdict(verdict).catch((e: unknown) => setError(say(e)))}
            >
              {VERDICT_WORD[verdict]}
            </Button>
          ))}
        </div>
        <label htmlFor="summary" className="text-muted-foreground">
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
          /* Saved when the box is left, not on every key: each save is a write to a file in the
             project, and an agent reading the review mid-word gains nothing from half a sentence. */
          onBlur={() => void saveSummary().catch((e: unknown) => setError(say(e)))}
          className="w-full min-w-0 resize-y rounded-md border bg-background px-2 py-1 text-[0.75rem] leading-snug outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        {dirty.current && summaryFrom !== null && summaryFrom !== draft.summary ? (
          <p data-testid="summary-stale" className="rounded-md border border-del-mark/50 bg-del px-2 py-1">
            The saved summary was changed after these words were typed. It now says: “
            {draft.summary.length > 160 ? `${draft.summary.slice(0, 159)}…` : draft.summary}” — leaving this box, or sending, replaces that.
          </p>
        ) : null}
        {draft.proposal ? (
          <ProposalBox
            proposal={draft.proposal}
            yours={summary}
            disabled={sending || confirming !== null || !actions.onTake}
            onTake={async (which) => {
              await actions.onTake!(which, draft.proposal!.run)
              if (which === 'summary') {
                /* Taken on purpose, so whatever was being typed is replaced, held copy and all. */
                dirty.current = false
                holding.keep('summary', null)
                setSummaryFrom(null)
                setSummary(proposalBody(draft.proposal!))
              }
            }}
          />
        ) : null}
      </section>

      {/* ---- 2. points ---- */}
      <section className="flex min-w-0 flex-col gap-1.5" aria-label="Points">
        <h3 className="text-[0.75rem] font-semibold">
          Points
          <span className="font-normal text-muted-foreground">
            {' '}
            — {waiting.length} draft{waiting.length === 1 ? '' : 's'}
            {gone.length ? `, ${gone.length} sent` : ''}
          </span>
        </h3>
        <NewPoint asked={asked} onAsked={onAsked} onAdd={actions.onAddPoint} />
        {waiting.length ? (
          <ul className="flex min-w-0 flex-col gap-1.5">{waiting.map(card)}</ul>
        ) : (
          <p className="text-muted-foreground">
            No draft points. Point at a line in Source or Diff and ask for a comment there, press New point, or run /review-pass in Claude Code.
          </p>
        )}
        {gone.length ? (
          <details className="min-w-0" open={gone.some((c) => !c.resolved)}>
            <summary className="cursor-pointer text-muted-foreground">
              {gone.length} sent {gone.length === 1 ? 'point' : 'points'}
              {gone.some((c) => c.resolved) ? `, ${gone.filter((c) => c.resolved).length} resolved` : ''}
            </summary>
            <ul className="flex min-w-0 flex-col gap-1.5 pt-1">{gone.map(card)}</ul>
          </details>
        ) : null}
      </section>

      {/* ---- 3. evidence ---- */}
      <section className="flex min-w-0 flex-col gap-1.5" aria-label="Evidence">
        <h3 className="text-[0.75rem] font-semibold">
          Evidence
          <span className="font-normal text-muted-foreground"> — screenshots, run logs and test output</span>
        </h3>
        {draft.evidence.length ? (
          <EvidenceList proofs={draft.evidence} access={access} onDrop={actions.onDropEvidence} points={labels} />
        ) : (
          <p className="text-muted-foreground">None yet. An agent keeps it here with add_evidence.</p>
        )}
      </section>

      {/* ---- 4. replies ---- */}
      <Replies replies={draft.replies} tracker={tracker} onReword={actions.onReplyReword} onDrop={actions.onReplyDrop} onSend={actions.onReplySend} />

      {/* ---- 5. send ---- */}
      <section className="flex min-w-0 flex-col gap-1.5 rounded-md border bg-card p-2" aria-label="Send">
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
                {confirming.ids.length} {confirming.ids.length === 1 ? 'point' : 'points'}
                {byAgent ? `, ${byAgent} of them drafted by an agent and kept by you, posted under your name` : ''}.
              </li>
              {notKept ? (
                <li>
                  {notKept} agent {notKept === 1 ? 'point you have not kept stays' : 'points you have not kept stay'} here as {notKept === 1 ? 'a draft' : 'drafts'}, unsent.
                </li>
              ) : null}
              <li>{confirming.summary.trim() ? `A summary of ${confirming.summary.trim().length} characters.` : 'No summary.'}</li>
              <li>
                Verdict: <strong>{VERDICT_WORD[confirming.verdict]}</strong>
                {tracker === 'GitLab' && confirming.verdict === 'request-changes'
                  ? ' — said in words at the top of the summary; GitLab is not asked to set a reviewer state.'
                  : '.'}
              </li>
            </ul>
            <p className="text-muted-foreground">
              A point the tracker will not attach to its line is not dropped: it is written into the summary, with its file, line and quoted source.
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
            <span className="min-w-0 text-muted-foreground">
              Only you send. Nothing is posted until you confirm{notKept ? `; ${notKept} agent ${notKept === 1 ? 'point is' : 'points are'} not kept yet` : ''}.
            </span>
            <Button type="button" size="sm" className={SMALL} onClick={begin} disabled={nothing || sending}>
              Send review…
            </Button>
          </div>
        )}
        {error ? (
          /* The tracker's own words where it said any: "gh auth login" and "Can not approve your own
             pull request" are worth more than a paraphrase. */
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
      </section>
    </article>
  )
}

/**
 * A new point: at the place somebody asked for one ("New point at src/app.ts:42"), or at a file and
 * lines the person types. The words are held as they are typed, under the place, so a reload of the
 * page finds them; the server checks the place against the change's real diff when it is saved.
 */
function NewPoint({ asked, onAsked, onAdd }: { asked: Place | null; onAsked(): void; onAdd(place: Place, body: string): Promise<void> }) {
  const [typing, setTyping] = useState(false)
  const [chosen, setChosen] = useState<Place | null>(null)
  const [path, setPath] = useState('')
  const [lines, setLines] = useState('')
  const [side, setSide] = useState<'new' | 'old'>('new')
  const typed = parseLines(path, lines, side)
  const place = asked ?? chosen
  const target = (p: Place) => `new:${p.side}:${p.start}:${p.line}:${p.path}`

  if (place) {
    return (
      <div className="min-w-0 rounded-md border" data-testid="new-point" data-place={placeLabel(place)}>
        <Composer
          key={target(place)}
          label={`New point at ${placeLabel(place)}`}
          saveLabel="Add to review"
          held={{ target: target(place), aim: `a new point at ${placeLabel(place)}` }}
          onCancel={() => {
            setChosen(null)
            setTyping(false)
            if (asked) onAsked()
          }}
          onSave={(body) =>
            onAdd(place, body).then(() => {
              setChosen(null)
              setTyping(false)
              setLines('')
              if (asked) onAsked()
            })
          }
        />
      </div>
    )
  }

  if (!typing) {
    return (
      <p>
        <Button type="button" variant="outline" size="sm" className={SMALL} onClick={() => setTyping(true)}>
          New point…
        </Button>
      </p>
    )
  }
  const field = 'min-w-0 rounded-md border bg-background px-1.5 py-0.5 font-mono text-[0.7rem] outline-none focus-visible:ring-2 focus-visible:ring-ring'
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1 rounded-md border bg-card p-1.5" data-testid="new-point-where">
      <input aria-label="File" placeholder="src/file.ts" className={cn(field, 'flex-1')} value={path} onChange={(e) => setPath(e.target.value)} />
      <input aria-label="Lines" placeholder="42 or 40-42" className={cn(field, 'w-20')} value={lines} onChange={(e) => setLines(e.target.value)} />
      <select aria-label="Side" className={field} value={side} onChange={(e) => setSide(e.target.value === 'old' ? 'old' : 'new')}>
        <option value="new">new</option>
        <option value="old">removed</option>
      </select>
      <Button type="button" variant="ghost" size="sm" className={SMALL} onClick={() => setTyping(false)}>
        Cancel
      </Button>
      <Button type="button" size="sm" className={SMALL} disabled={!typed} onClick={() => setChosen(typed)}>
        Write the point
      </Button>
      <span className="w-full text-muted-foreground">Lines of the whole change at its head, as Diff and Source number them.</span>
    </div>
  )
}

/** A place out of what the person typed, or null while it is not one yet. */
export function parseLines(path: string, lines: string, side: 'new' | 'old'): Place | null {
  const m = /^\s*([1-9][0-9]{0,9})(?:\s*[-–]\s*([1-9][0-9]{0,9}))?\s*$/.exec(lines)
  const file = path.trim()
  if (!m || !file) return null
  const start = Number(m[1])
  const end = m[2] ? Number(m[2]) : start
  if (end < start) return null
  return { path: file, side, start, line: end }
}

/**
 * A review run's proposed summary and verdict, BESIDE the person's: never written into theirs except
 * by their own press. "Use this summary" asks first when their box has words in it.
 */
function ProposalBox({ proposal, yours, disabled, onTake }: { proposal: Proposal; yours: string; disabled: boolean; onTake(which: 'summary' | 'verdict'): Promise<void> }) {
  const [armed, setArmed] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const body = proposalBody(proposal)
  const asks = yours.trim() !== '' && yours !== body
  const take = (which: 'summary' | 'verdict') => {
    setError(null)
    setArmed(false)
    onTake(which).catch((e: unknown) => setError(say(e)))
  }
  return (
    <div data-testid="proposal" className="flex min-w-0 flex-col gap-1 rounded-md border border-agent/50 bg-background p-2">
      <p className="font-semibold">
        Proposed by review run {proposal.run}
        <span className="font-normal text-muted-foreground"> — at {short(proposal.head)}, beside your summary and verdict</span>
      </p>
      <p>
        Verdict: <strong>{VERDICT_WORD[proposal.verdict]}</strong>
      </p>
      <p className="text-muted-foreground">
        {proposal.door === 'one-way' ? 'One-way: hard or impossible to undo, so it waits for you.' : 'Two-way: cheap to undo.'}
        {proposal.uiux ? ' It touches what people see, so it waits for you.' : ''}
      </p>
      <p className="min-w-0 whitespace-pre-wrap text-[0.75rem] leading-snug [overflow-wrap:anywhere]">{proposal.summary}</p>
      {proposal.pathToSuccess.length ? (
        <>
          <p className="font-semibold">To get this approved:</p>
          <ol className="list-decimal pl-4">
            {proposal.pathToSuccess.map((step, at) => (
              <li key={at} className="[overflow-wrap:anywhere]">
                {step}
              </li>
            ))}
          </ol>
        </>
      ) : null}
      {proposal.sent ? (
        <p>
          Sent by Factory at {proposal.sent.at}, at {short(proposal.sent.head)}.
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="rounded-md border border-del-mark/50 bg-del px-2 py-1">
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center justify-end gap-1">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className={cn(SMALL, armed && 'text-destructive')}
          disabled={disabled}
          onBlur={() => setArmed(false)}
          onClick={() => (asks && !armed ? setArmed(true) : take('summary'))}
        >
          {armed ? 'Replace your summary?' : 'Use this summary'}
        </Button>
        <Button type="button" variant="outline" size="sm" className={SMALL} disabled={disabled} onClick={() => take('verdict')}>
          Use this verdict
        </Button>
      </div>
    </div>
  )
}
