import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { opening } from '@/diff/budget'
import { parseDiff, totals, type FileDiff } from '@/diff/parse'
import type { Api, ChangeRead } from '@/wire/api'

import { short, type Comment, type Draft, type Side, type View } from '../../review/shape.ts'

import { CommentCard, Composer } from './comment.tsx'
import { FileSection, type Pick } from './file-diff.tsx'
import { HoldingContext, drafts, type Holding } from './holding.ts'
import { ReviewPanel } from './review-panel.tsx'

/**
 * One change, being reviewed: its header and commit picker, the diff of the
 * view that is picked, and the review being drafted.
 *
 * ## Three things are loaded, and they are deliberately separate
 *
 * - The CHANGE (what it is, its head, its commits) — from the tracker, through
 *   this app's server. Asked when the page opens on a change and again when
 *   the host's reading says the head moved.
 * - A DIFF — one per view. The whole change at its head, or one commit.
 * - The DRAFT — from a file in the project. Re-read when the window regains
 *   focus and on a slow interval, because an agent writes to the same file
 *   over MCP and a comment it adds should appear without anybody reloading.
 *
 * A failure of one is drawn where that one would have been, in the tracker's
 * own words, and does not take the other two with it: a diff that will not
 * load still leaves the review panel, and a project that is not open still
 * leaves the diff.
 */

type Loaded<T> = { at: 'loading' } | { at: 'error'; error: string } | { at: 'ok'; value: T }

/** Which diff is on screen. `all` has no sha of its own: it is always at the change's current head. */
type Showing = { view: 'all' } | { view: 'commit'; sha: string }

interface Patch {
  /** Which diff this is: the view and the commit it was read for. */
  of: string
  files: FileDiff[]
  truncated: boolean
  empty: boolean
}

/** How often the draft is re-read while the page is open. Slow: it is a file read, and focus catches the common case. */
const DRAFT_EVERY_MS = 20_000

const say = (error: unknown): string => (error instanceof Error ? error.message : String(error))

const note = (text: string) => <p className="text-[0.7rem] leading-4 text-muted-foreground">{text}</p>

function Failure({ error, onAgain }: { error: string; onAgain: () => void }) {
  return (
    <div className="flex flex-col gap-1">
      {/* The CLI's own words, verbatim: `gh` says "gh auth login" when a token
          has expired, and that is the sentence the person needs. */}
      <p role="alert" className="rounded-md border border-del-mark/50 bg-del px-2 py-1 font-mono text-[0.7rem] leading-4">
        {error}
      </p>
      <p className="text-[0.7rem] leading-4">
        <Button type="button" variant="link" size="sm" className="h-auto p-0 text-[0.7rem]" onClick={onAgain}>
          Try again
        </Button>
      </p>
    </div>
  )
}

export function ChangeReview({
  refName,
  url,
  title,
  hintHead,
  projectPath,
  api,
  round = 0,
}: {
  /** The ref as selected on the canvas: `gh#46`, `!3105`. */
  refName: string
  /** Its address on the tracker, from the host's reading. */
  url: string
  /** Its title from the host's reading, shown until the tracker's own arrives. */
  title: string
  /** The head the host's reading last heard, if any. Not trusted as the head — only as a reason to ask the forge again. */
  hintHead: string | null
  projectPath: string | null
  api: Api
  /** Bumped by the page when its own server is back after not answering: whatever failed here is asked again. */
  round?: number
}) {
  /* ---- the change ---- */
  const [change, setChange] = useState<Loaded<ChangeRead>>({ at: 'loading' })
  const [again, setAgain] = useState(0)
  /* What the last successful read was a read OF, and the head it found. */
  const read = useRef<{ key: string; head: string } | null>(null)
  useEffect(() => {
    const key = `${url}|${again}`
    /*
     * `hintHead` is a dependency on purpose: the host's reading naming a head
     * this page has not seen is the one signal it gets that somebody pushed.
     * The forge is then asked, and what IT says is the head. A hint that only
     * repeats what the forge already said — which is what arrives a moment
     * after every first load, when the host's detail read lands — costs
     * nothing.
     */
    if (read.current?.key === key && (hintHead === null || hintHead === read.current.head)) return
    let live = true
    setChange((was) => (was.at === 'ok' && read.current?.key === key ? was : { at: 'loading' }))
    api
      .change(url)
      .then((value) => {
        if (!live) return
        read.current = { key, head: value.head }
        setChange({ at: 'ok', value })
      })
      .catch((e: unknown) => live && setChange({ at: 'error', error: say(e) }))
    return () => {
      live = false
    }
  }, [api, url, again, hintHead])

  const head = change.at === 'ok' ? change.value.head : null
  const commits = change.at === 'ok' ? change.value.commits : []

  /* ---- which view ---- */
  const [showing, setShowing] = useState<Showing>({ view: 'all' })
  /* A commit that is no longer one of the change's (a force-push) cannot stay
     picked: there would be a diff on screen for something the change does not
     contain. */
  useEffect(() => {
    if (showing.view === 'commit' && change.at === 'ok' && !change.value.commits.some((c) => c.sha === showing.sha)) setShowing({ view: 'all' })
  }, [change, showing])
  const sha = showing.view === 'all' ? head : showing.sha

  /* ---- the diff of that view ---- */
  const [patch, setPatch] = useState<Loaded<Patch>>({ at: 'loading' })
  const [patchAgain, setPatchAgain] = useState(0)
  useEffect(() => {
    if (!sha) return
    let live = true
    setPatch({ at: 'loading' })
    api
      .diff(url, showing.view, sha)
      .then((got) => live && setPatch({ at: 'ok', value: { of: `${showing.view}:${sha}`, files: parseDiff(got.text), truncated: got.truncated, empty: !got.text.trim() } }))
      .catch((e: unknown) => live && setPatch({ at: 'error', error: say(e) }))
    return () => {
      live = false
    }
  }, [api, url, showing.view, sha, patchAgain])

  /* ---- the draft ---- */
  const [draft, setDraft] = useState<Loaded<Draft>>({ at: 'loading' })
  /* Counts writes. A re-read that started before a write finished would carry
     the draft from before it, and applying it would make a comment the person
     just saved vanish until the next re-read. */
  const writes = useRef(0)
  const reread = useCallback(() => {
    if (!projectPath) return
    const started = writes.current
    api
      .draft(projectPath, url)
      .then((value) => {
        if (writes.current === started) setDraft({ at: 'ok', value })
      })
      .catch((e: unknown) => {
        /* A failed RE-read leaves the draft on screen alone; only a first read
           that fails has nothing better to show than the error. */
        if (writes.current === started) setDraft((was) => (was.at === 'ok' ? was : { at: 'error', error: say(e) }))
      })
  }, [api, projectPath, url])

  useEffect(() => {
    setDraft({ at: 'loading' })
    reread()
    if (!projectPath) return
    const timer = setInterval(reread, DRAFT_EVERY_MS)
    window.addEventListener('focus', reread)
    return () => {
      clearInterval(timer)
      window.removeEventListener('focus', reread)
    }
  }, [reread, projectPath])

  /** Run a write and take the draft it answers with as the truth. */
  /*
   * The page's Try again, after its own server did not answer. Only what FAILED is asked again: a
   * diff that is on screen stays on screen, and nothing typed against it is disturbed.
   */
  const failed = useRef({ change: false, patch: false })
  failed.current = { change: change.at === 'error', patch: patch.at === 'error' }
  const asked = useRef(round)
  useEffect(() => {
    if (round === asked.current) return
    asked.current = round
    if (failed.current.change) setAgain((n) => n + 1)
    if (failed.current.patch) setPatchAgain((n) => n + 1)
    reread()
  }, [round, reread])

  const write = useCallback(async (does: () => Promise<Draft>): Promise<void> => {
    writes.current += 1
    const value = await does()
    writes.current += 1
    setDraft({ at: 'ok', value })
  }, [])

  /* ---- picking lines ---- */
  /*
   * What is being typed on this change, held across a reload of the page (the protocol's `held`), under
   * this project and this change. A stale page reloads itself — on the Save press that found it
   * out, or on the draft re-read every twenty seconds — and without this a comment half written
   * went with it.
   */
  const here = projectPath ? drafts.at(projectPath) : null
  const holding = useMemo<Holding>(
    () => ({
      read: (target) => here?.read(`${url}|${target}`) ?? null,
      keep: (target, draft) => here?.keep(`${url}|${target}`, draft),
    }),
    [here, url],
  )
  /** Where a new comment's words are held: the view, the commit, the file by PATH, the side and the lines. */
  const newTarget = (view: string, commit: string, path: string, at: Pick) => `new:${view}:${commit}:${at.side}:${at.start}:${at.line}:${path}`
  const [heldTick, setHeldTick] = useState(0)

  const [pick, setPick] = useState<Pick | null>(null)
  /* A pick is a place in ONE diff. Changing the view changes what every number
     means, so the pick does not survive it. */
  useEffect(() => setPick(null), [showing.view, sha, url])

  /* ---- which files are open ---- */
  /*
   * The files of the diff ON SCREEN, and of no other. For one render after the selector moves,
   * `patch` is still the diff that was showing; a held comment reopened against that list was
   * picked at the position its file has in the OTHER diff, and its box came back on whatever sits
   * there in this one — open and empty, with the words held somewhere nobody could see.
   */
  const files = patch.at === 'ok' && patch.value.of === `${showing.view}:${sha}` ? patch.value.files : null
  const plan = useMemo(() => (files ? opening(files) : null), [files])
  const [moved, setMoved] = useState<Record<number, boolean>>({})
  useEffect(() => setMoved({}), [files])

  /* ---- going to a comment ---- */
  const [goingTo, setGoingTo] = useState<string | null>(null)
  useEffect(() => {
    if (!goingTo || patch.at !== 'ok') return
    /* An id is this app's own `c-…`; anything else is not put into a selector. */
    const element = /^[\w-]+$/.test(goingTo) ? document.querySelector(`[data-comment="${goingTo}"]`) : null
    /* Optional call: not every DOM this renders in has it, and failing to
       scroll is not a reason to fail. */
    element?.scrollIntoView?.({ block: 'center' })
    setGoingTo(null)
  }, [goingTo, patch])

  const [login, setLogin] = useState<string | null>(null)

  const all = draft.at === 'ok' ? draft.value.comments : []
  /* The comments that belong to the diff on screen, and only those. An
     all-changes comment written at an older head is NOT one of them even in the
     all-changes view: its numbers are from a diff that is gone, and drawing it
     under today's line 40 would be this page moving it — the one thing a
     comment is promised never to suffer. It stays in the review panel, marked. */
  const inView = all.filter((c) => c.view === showing.view && c.commit === sha)
  const waitingIn = (view: View, commit: string | null) => all.filter((c) => !c.sent && c.view === view && c.commit === commit).length

  const tracker = /(^|\.)github\.com$/.test(safeHost(url)) ? 'GitHub' : 'GitLab'
  const shownTitle = change.at === 'ok' && change.value.title ? change.value.title : title

  const jump = (comment: Comment) => {
    if (comment.view === 'commit' && commits.some((c) => c.sha === comment.commit)) setShowing({ view: 'commit', sha: comment.commit })
    else if (comment.view === 'all') setShowing({ view: 'all' })
    setGoingTo(comment.id)
  }

  const pickLine = (file: number) => (side: Side, line: number, extend: boolean) => {
    /* Pressing another line leaves the box that was open, as it always has; its held copy goes with it. */
    if (pick && sha && files?.[pick.file]) holding.keep(newTarget(showing.view, sha, files[pick.file]!.path, pick), null)
    setPick((was) =>
      /* Shift extends a pick in the same column of the same file. Anything
         else starts a new one: a range across two files or two columns is not
         something either tracker can hold. */
      extend && was && was.file === file && was.side === side
        ? { file, side, start: Math.min(was.start, line), line: Math.max(was.line, line) }
        : { file, side, start: line, line },
    )
  }

  /*
   * A new comment that was half written when the page reloaded: its line is picked again and its
   * box opens with the words in it — once the diff it was written on is the one on screen, and
   * only there. The words are in the key with the view, the commit, the file and the lines, so
   * they cannot open on another line.
   */
  useEffect(() => {
    if (!here || !sha || !files || pick) return
    const prefix = `${url}|new:${showing.view}:${sha}:`
    for (const target of Object.keys(here.all())) {
      if (!target.startsWith(prefix)) continue
      const [side, start, line, ...path] = target.slice(prefix.length).split(':')
      const file = files.findIndex((f) => f.path === path.join(':'))
      if (file < 0 || (side !== 'new' && side !== 'old')) continue
      setPick({ file, side, start: Number(start), line: Number(line) })
      return
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per diff shown; `pick` is read, not followed
  }, [here, url, showing.view, sha, files])

  /*
   * Held words whose target is gone: a new comment on a commit that is no longer this change's
   * head (or one of its commits), on a file the diff no longer has, or a rewording of a comment
   * that was removed. They are SHOWN, with what they were about, rather than opened somewhere
   * they were not aimed at or dropped.
   */
  void heldTick
  const strays = !here || change.at !== 'ok' || draft.at !== 'ok'
    ? []
    : Object.entries(here.all()).filter(([target]) => {
        if (!target.startsWith(`${url}|`)) return false
        const rest = target.slice(url.length + 1)
        if (rest.startsWith('reword:')) return !draft.value.comments.some((c) => c.id === rest.slice('reword:'.length))
        if (!rest.startsWith('new:')) return false
        const [, view, commit, , , , ...path] = rest.split(':')
        if (view === 'all' ? commit !== head : !commits.some((c) => c.sha === commit)) return true
        const shownHere = view === showing.view && commit === sha && files !== null
        return shownHere && !files.some((f) => f.path === path.join(':'))
      })

  const canWrite = Boolean(projectPath) && draft.at === 'ok' && sha !== null

  const reword = (id: string, body: string) => write(() => api.reword(projectPath!, url, id, body))
  const drop = (id: string) => write(() => api.drop(projectPath!, url, id))

  return (
    <HoldingContext.Provider value={holding}>
    <section className="flex min-w-0 flex-col gap-2" data-ref={refName}>
      <header className="flex min-w-0 flex-col gap-1">
        <h2 className="text-[0.75rem] leading-4 font-semibold">
          <span className="font-mono">{refName}</span>
          {shownTitle ? <span className="font-normal"> {shownTitle}</span> : null}
        </h2>
        <p className="flex flex-wrap items-center gap-1 text-[0.7rem] leading-4 text-muted-foreground">
          {change.at === 'ok' ? (
            <>
              <Badge className="px-1.5 text-[0.65rem]">{change.value.state}</Badge>
              {change.value.draft ? (
                <Badge variant="outline" className="px-1.5 text-[0.65rem]">
                  draft
                </Badge>
              ) : null}
              {change.value.author ? <span>by {change.value.author}</span> : null}
              <span className="font-mono" title={`head ${change.value.head}`}>
                {short(change.value.head)}
              </span>
            </>
          ) : null}
          {/* `noreferrer` as well as `noopener`: a referrer would tell the
              tracker which host somebody is reading from, and buys nothing. */}
          <a className="underline underline-offset-2" href={url} target="_blank" rel="noopener noreferrer">
            open on the tracker
          </a>
        </p>

        {change.at === 'ok' ? (
          <label className="flex min-w-0 flex-col gap-0.5 text-[0.7rem] leading-4 text-muted-foreground">
            Showing
            {/* A native select: it cannot overflow a 220-pixel frame, it is
                keyboard- and screen-reader-operable without any code here, and
                its menu is drawn by the system OUTSIDE the frame, where a
                custom popover would be clipped by it. Each entry carries the
                number of draft comments in that view, so where the review's
                comments sit is visible without visiting every commit. */}
            <select
              aria-label="Which changes to show"
              className="w-full min-w-0 truncate rounded-md border bg-background px-1 py-0.5 text-[0.7rem] text-foreground"
              value={showing.view === 'all' ? 'all' : showing.sha}
              onChange={(event) => setShowing(event.target.value === 'all' ? { view: 'all' } : { view: 'commit', sha: event.target.value })}
            >
              <option value="all">
                All changes{counted(waitingIn('all', head))}
              </option>
              {commits.map((commit) => (
                <option key={commit.sha} value={commit.sha}>
                  {short(commit.sha)} {commit.title}
                  {counted(waitingIn('commit', commit.sha))}
                </option>
              ))}
            </select>
            {change.value.more ? <span>This change has more commits than the 100 listed here.</span> : null}
          </label>
        ) : null}
      </header>

      {strays.length ? (
        <div data-testid="kept-words" className="flex min-w-0 flex-col gap-1 rounded-md border bg-card p-2 text-[0.7rem] leading-4">
          <p className="text-muted-foreground">
            Typed here and not saved. What {strays.length === 1 ? 'it was' : 'they were'} written on is no longer part of this change, so{' '}
            {strays.length === 1 ? 'it is' : 'they are'} kept here rather than put on another line:
          </p>
          {strays.map(([target, one]) => (
            <div key={target} data-kept={target} className="flex min-w-0 flex-col gap-1 rounded-md border px-2 py-1">
              <p className="text-muted-foreground">{one.aim}</p>
              <p className="min-w-0 whitespace-pre-wrap text-[0.75rem] leading-snug [overflow-wrap:anywhere]">{one.text}</p>
              <p>
                <Button
                  type="button"
                  variant="link"
                  size="sm"
                  className="h-auto p-0 text-[0.7rem]"
                  onClick={() => {
                    here?.keep(target, null)
                    setHeldTick((n) => n + 1)
                  }}
                >
                  Discard
                </Button>
              </p>
            </div>
          ))}
        </div>
      ) : null}

      {change.at === 'loading' ? note(`Asking ${tracker} about ${refName}…`) : null}
      {change.at === 'error' ? <Failure error={change.error} onAgain={() => setAgain((n) => n + 1)} /> : null}

      {!projectPath
        ? note('No project is open, so there is nowhere to keep a draft: the diff can be read, and comments cannot be written. Open a project in Kehikot to review.')
        : draft.at === 'error'
          ? <Failure error={draft.error} onAgain={reread} />
          : null}

      {change.at === 'ok' ? (
        <div className="flex min-w-0 flex-col gap-1" data-view={showing.view}>
          {patch.at === 'loading' ? note(showing.view === 'all' ? 'Reading the diff of the whole change…' : `Reading the diff of commit ${short(showing.sha)}…`) : null}
          {patch.at === 'error' ? <Failure error={patch.error} onAgain={() => setPatchAgain((n) => n + 1)} /> : null}
          {patch.at === 'ok' && files && plan ? (
            <>
              <Totals files={files} closed={plan.closed} heldBack={plan.heldBack} />
              {patch.value.truncated ? (
                <p className="rounded-md border border-del-mark bg-del px-2 py-1 text-[0.7rem] leading-4">
                  This diff was longer than this app reads into memory and was cut off part-way. Every file below is real, and there may be
                  files after them that never arrived — so this is not the whole change, and a review of it is not a review of all of it.
                </p>
              ) : null}
              {!files.length
                ? note(
                    patch.value.empty
                      ? 'The tracker answered with an empty diff. That is what a change with no differences looks like, and it is not an error.'
                      : 'The tracker answered, and what it printed is not a unified diff this app can read.',
                  )
                : null}
              {files.map((file, at) => {
                const here = inView.filter((c) => c.path === file.path)
                const open = moved[at] ?? (plan.open.has(at) || here.length > 0 || pick?.file === at)
                const picking = pick && pick.file === at ? pick : null
                return (
                  <FileSection
                    /* Keyed by the view as well as the index: the same position
                       in another diff is another file, and must not inherit how
                       many of its lines were drawn. */
                    key={`${showing.view}:${sha}:${at}`}
                    file={file}
                    open={open}
                    onToggle={() => setMoved((was) => ({ ...was, [at]: !open }))}
                    comments={here}
                    pick={picking}
                    onPick={canWrite ? pickLine(at) : null}
                    composer={
                      picking && sha ? (
                        <Composer
                          label={`Comment on ${picking.side} ${picking.start === picking.line ? `line ${picking.line}` : `lines ${picking.start}–${picking.line}`} of ${file.path}`}
                          saveLabel="Add to review"
                          held={{
                            target: newTarget(showing.view, sha, file.path, picking),
                            aim: `a comment on ${picking.side} ${picking.start === picking.line ? `line ${picking.line}` : `lines ${picking.start}–${picking.line}`} of ${file.path} at ${short(sha)}`,
                          }}
                          onCancel={() => setPick(null)}
                          onSave={(body) =>
                            write(() =>
                              api.addComment(projectPath!, url, {
                                view: showing.view,
                                /* The frame, sent explicitly: the head this diff
                                   was read at, or the commit. The server refuses
                                   if the change has moved past it. */
                                commit: sha,
                                path: file.path,
                                side: picking.side,
                                line: picking.line,
                                ...(picking.start !== picking.line ? { startLine: picking.start } : {}),
                                body,
                              }),
                            ).then(() => setPick(null))
                          }
                        />
                      ) : null
                    }
                    renderComment={(comment) => <CommentCard comment={comment} onReword={reword} onDrop={drop} />}
                  />
                )
              })}
            </>
          ) : null}
        </div>
      ) : null}

      {projectPath && draft.at === 'ok' && change.at === 'ok' ? (
        <ReviewPanel
          draft={draft.value}
          head={change.value.head}
          commits={commits.map((c) => c.sha)}
          tracker={tracker}
          refName={change.value.ref}
          login={login}
          onJump={jump}
          onReword={reword}
          onDrop={drop}
          onSummary={(summary) => write(() => api.setVerdict(projectPath, url, undefined, summary))}
          onVerdict={(verdict) => write(() => api.setVerdict(projectPath, url, verdict, undefined))}
          onConfirming={() => {
            /* Asked only now: it is a subprocess, and whose login this is only
               matters to somebody about to post under it. */
            api
              .login(url)
              .then(setLogin)
              .catch(() => setLogin(null))
          }}
          onSend={async (confirmed) => {
            writes.current += 1
            try {
              const made = await api.send(projectPath, url, confirmed)
              setDraft({ at: 'ok', value: made.draft })
              return made.report
            } finally {
              writes.current += 1
              /* Whatever happened — including a refusal — the draft on disk is
                 the truth about what was posted. Read it. */
              reread()
            }
          }}
        />
      ) : null}
    </section>
    </HoldingContext.Provider>
  )
}

const counted = (n: number): string => (n ? ` — ${n} ${n === 1 ? 'comment' : 'comments'}` : '')

function safeHost(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return ''
  }
}

function Totals({ files, closed, heldBack }: { files: FileDiff[]; closed: number; heldBack: number }) {
  const sum = totals(files)
  if (!files.length) return null
  return (
    <p className="flex flex-wrap items-center gap-1 text-[0.7rem] leading-4 text-muted-foreground">
      <span>
        {sum.files} {sum.files === 1 ? 'file' : 'files'}
      </span>
      <span className="rounded-sm bg-add px-1 text-add-mark">+{sum.added}</span>
      <span className="rounded-sm bg-del px-1 text-del-mark">−{sum.removed}</span>
      {closed ? (
        <span className="min-w-0">
          {`${closed} ${closed === 1 ? 'file is' : 'files are'} closed to start with, holding ${heldBack} lines. Open any of them below; nothing is missing from this list.`}
        </span>
      ) : null}
    </p>
  )
}
