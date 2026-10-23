import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { CodeLocation, HeaderItemInput, LocationIntent, LocationSetResult, SharedLocation } from 'kehikot-module-protocol'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { HeaderFallback } from '@/header-fallback'
import { DOCUMENT, SHOTS, headerOf } from '@/header'
import type { Host } from '@/wire/use-kehikot'
import type { Api, ChangeRead } from '@/wire/api'

import { ID } from '../../id.ts'
import { short, type Comment, type Draft } from '../../review/shape.ts'

import { ReviewDocument } from './document.tsx'
import { HoldingContext, drafts, type Holding } from './holding.ts'
import { ShotsView } from './shots.tsx'
import { askOf, commentAsked, locationOf, placeOf, type Place } from './where.ts'
import { heldAtProject } from '../wire/held-at-project.ts'
import { OutLink } from './out-link.tsx'

/**
 * One change, being reviewed: its header, and the review of it as a document.
 *
 * Review draws no diff. A point's code reference is a place in the change's code; pressing it says
 * so to the kehikko (`location.set`, intent `show`), and Source opens the file there while Diff
 * shows the old and the new at that spot. The other way round, somebody asking for a comment at a
 * place (`context.location`, intent `comment`) opens "New point at path:line" here. The server still
 * checks every point against the change's real diff when it is written.
 *
 * ## Two things are loaded, and they are deliberately separate
 *
 * - The CHANGE (what it is, its head, its commits) — from the tracker, through this app's server.
 *   Asked when the page opens on a change and again when the host's reading says the head moved.
 * - The REVIEW — from a file in the project. Re-read when the window regains focus and on a slow
 *   interval, because an agent writes to the same file over MCP and a point it adds should appear
 *   without anybody reloading.
 *
 * A failure of one is drawn where that one would have been, in the tracker's own words, and does not
 * take the other with it.
 */

type Loaded<T> = { at: 'loading' } | { at: 'error'; error: string } | { at: 'ok'; value: T }

/** How often the review is re-read while the page is open. Slow: it is a file read, and focus catches the common case. */
const DRAFT_EVERY_MS = 20_000

const say = (error: unknown): string => (error instanceof Error ? error.message : String(error))

const note = (text: string) => <p className="text-[0.7rem] leading-4 text-muted-foreground">{text}</p>

function Failure({ error, onAgain }: { error: string; onAgain: () => void }) {
  return (
    <div className="flex flex-col gap-1">
      {/* The CLI's own words, verbatim: `gh` says "gh auth login" when a token has expired, and that
          is the sentence the person needs. */}
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

/** What a press on a code reference is told when it was not taken, in a sentence. Null when it was. */
export function locatedSaid(result: LocationSetResult | null): string | null {
  if (!result) return 'Nothing is framing this page, so there is no Source or Diff to show those lines in.'
  if (result.outcome === 'taken') return null
  if (result.outcome === 'not-selected') return `Kehikot did not point there: this change is not selected on the canvas any more.${result.why ? ` ${result.why}` : ''}`
  return `Kehikot did not point there${result.why ? `: ${result.why}` : '.'}`
}

export function ChangeReview({
  refName,
  url,
  title,
  hintHead,
  projectPath,
  projectId = null,
  api,
  round = 0,
  chrome,
  location = null,
  locate,
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
  /** The project's id: typed words are held by it, so a renamed folder keeps them. */
  projectId?: string | null
  api: Api
  /** Bumped by the page when its own server is back after not answering: whatever failed here is asked again. */
  round?: number
  /** The page's header: what to declare it through, whether a host draws it, and which changes there are to choose between. */
  chrome?: {
    header: Host['header']
    presses: Host['presses']
    drawn: boolean
    changes: readonly string[]
    onChange(ref: string): void
  }
  /** Where somebody is pointing in a change's code on this kehikko (`context.location`). */
  location?: SharedLocation | null
  /** Point the kehikko at a place (`location.set`). Absent when nothing frames the page. */
  locate?(location: CodeLocation | null, intent?: LocationIntent): Promise<LocationSetResult | null>
}) {
  /* ---- the change ---- */
  const [change, setChange] = useState<Loaded<ChangeRead>>({ at: 'loading' })
  const [again, setAgain] = useState(0)
  /* What the last successful read was a read OF, and the head it found. */
  const read = useRef<{ key: string; head: string } | null>(null)
  useEffect(() => {
    const key = `${url}|${again}`
    /* `hintHead` is a dependency on purpose: the host's reading naming a head this page has not seen
       is the one signal it gets that somebody pushed. The forge is then asked, and what IT says is
       the head. */
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
  const [showing, setShowing] = useState<typeof DOCUMENT | typeof SHOTS>(DOCUMENT)

  /* ---- the review ---- */
  const [draft, setDraft] = useState<Loaded<Draft>>({ at: 'loading' })
  /* Counts writes. A re-read that started before a write finished would carry the review from
     before it, and applying it would make a point the person just saved vanish until the next re-read. */
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
        /* A failed RE-read leaves the review on screen alone; only a first read that fails has
           nothing better to show than the error. */
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

  /* The page's Try again, after its own server did not answer: what failed is asked again. */
  const failed = useRef(false)
  failed.current = change.at === 'error'
  const roundSeen = useRef(round)
  useEffect(() => {
    if (round === roundSeen.current) return
    roundSeen.current = round
    if (failed.current) setAgain((n) => n + 1)
    reread()
  }, [round, reread])

  /** Run a write and take the review it answers with as the truth. */
  const write = useCallback(async (does: () => Promise<Draft>): Promise<void> => {
    writes.current += 1
    const value = await does()
    writes.current += 1
    setDraft({ at: 'ok', value })
  }, [])

  /* ---- what is being typed, held across a reload ---- */
  const here = heldAtProject(drafts, { projectId, projectPath }) ?? null
  const holding = useMemo<Holding>(
    () => ({
      read: (target) => here?.read(`${url}|${target}`) ?? null,
      keep: (target, held) => here?.keep(`${url}|${target}`, held),
    }),
    [here, url],
  )

  /* ---- "comment here": a place somebody asked for a point at ---- */
  const [asked, setAsked] = useState<Place | null>(null)
  const handled = useRef(new Set<string>())
  useEffect(() => {
    if (!location || !commentAsked(location, refName, handled.current, ID)) return
    handled.current.add(askOf(location))
    setAsked(placeOf(location))
    setShowing(DOCUMENT)
  }, [location, refName])

  /* ---- what the page has open, for an agent's `read_focus` ---- */
  const shownTitle = change.at === 'ok' && change.value.title ? change.value.title : title
  const focusKey = projectPath ? JSON.stringify([projectPath, url, refName, shownTitle, location ?? null]) : ''
  useEffect(() => {
    if (!focusKey || !projectPath) return
    /* A report that does not land is not worth a sentence: an agent is then told nothing is open. */
    void api.focus(projectPath, url, refName, shownTitle, location ?? null).catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the key is everything it says
  }, [focusKey])

  const [login, setLogin] = useState<string | null>(null)

  const all = draft.at === 'ok' ? draft.value.comments : []
  const waiting = all.filter((c) => !c.sent).length
  const tracker = /(^|\.)github\.com$/.test(safeHost(url)) ? 'GitHub' : 'GitLab'

  /*
   * The header: the view switch and, when several changes are selected, the change switch. Declared
   * whole, and again only when it is a different list: a keystroke in a point changes none of it.
   */
  const items = useMemo<HeaderItemInput[]>(
    () => (chrome ? headerOf({ changes: chrome.changes, change: refName, waiting, showing }) : []),
    [chrome, refName, waiting, showing],
  )
  const itemsKey = chrome && change.at === 'ok' ? JSON.stringify(items) : ''
  const declare = chrome?.header
  useEffect(() => {
    declare?.(itemsKey ? (JSON.parse(itemsKey) as HeaderItemInput[]) : [])
  }, [declare, itemsKey])
  useEffect(() => () => declare?.([]), [declare])
  const press = (pressing: { item: string; value?: string | boolean }): string | boolean => {
    const { item, value } = pressing
    if (item === 'change') {
      const to = typeof value === 'string' && value.startsWith('c') ? chrome?.changes[Number(value.slice(1))] : undefined
      if (!to) return 'That is no longer one of the selected changes.'
      chrome?.onChange(to)
      return true
    }
    if (item === 'showing') {
      if (value === DOCUMENT || value === SHOTS) setShowing(value)
      else return 'Review shows the review or the Before / after pictures.'
      return true
    }
    return 'That is not something this page has.'
  }
  const presses = chrome?.presses
  if (presses) presses.current = press
  useEffect(
    () => () => {
      if (presses) presses.current = null
    },
    [presses],
  )

  const onLocate = async (comment: Comment): Promise<string | null> => {
    if (!locate) return locatedSaid(null)
    return locatedSaid(await locate(locationOf(comment, refName), 'show'))
  }

  return (
    <HoldingContext.Provider value={holding}>
      <section className="flex min-w-0 flex-col gap-2" data-ref={refName}>
        {/* No toolbar: View is the host's. This control is for a page no host draws it for. */}
        {chrome && !chrome.drawn && change.at === 'ok' ? <HeaderFallback items={items} onPress={press} className="fixed top-1 right-1" /> : null}
        <header className="flex min-w-0 flex-col gap-1">
          <h2 className={`text-[0.75rem] leading-4 font-semibold${chrome && !chrome.drawn ? ' pr-6' : ''}`}>
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
            {/* `noreferrer` as well as `noopener`: a referrer would tell the tracker which host somebody is reading from. */}
            <OutLink href={url}>open on the tracker</OutLink>
          </p>
        </header>

        {change.at === 'loading' ? note(`Asking ${tracker} about ${refName}…`) : null}
        {change.at === 'error' ? <Failure error={change.error} onAgain={() => setAgain((n) => n + 1)} /> : null}

        {!projectPath
          ? note('No project is open, so there is nowhere to keep a review. Open a project in Kehikot to review.')
          : draft.at === 'error'
            ? <Failure error={draft.error} onAgain={reread} />
            : null}

        {change.at === 'ok' && showing === SHOTS ? <ShotsView api={api} url={url} /> : null}

        {showing === DOCUMENT && projectPath && draft.at === 'ok' && change.at === 'ok' ? (
          <ReviewDocument
            draft={draft.value}
            head={change.value.head}
            commits={commits.map((c) => c.sha)}
            tracker={tracker}
            refName={change.value.ref}
            login={login}
            access={{ src: (id) => api.evidenceUrl(projectPath, url, id), text: (id) => api.evidenceText(projectPath, url, id) }}
            asked={asked}
            onAsked={() => setAsked(null)}
            actions={{
              onLocate,
              onAddPoint: (place, body) =>
                write(() =>
                  api.addComment(projectPath, url, {
                    view: 'all',
                    /* The head the place was counted at: what the pointer said for a new-side line,
                       else the head this page read. The server refuses if the change has moved past it. */
                    commit: place.side === 'new' && place.commit ? place.commit : head!,
                    path: place.path,
                    side: place.side,
                    line: place.line,
                    ...(place.start !== place.line ? { startLine: place.start } : {}),
                    body,
                  }),
                ),
              onReword: (id, body) => write(() => api.reword(projectPath, url, id, body)),
              onDrop: (id) => write(() => api.drop(projectPath, url, id)),
              onKeep: (id) => write(() => api.keep(projectPath, url, id)),
              onResolve: (id, resolved) => write(() => api.resolve(projectPath, url, id, resolved)),
              onDropEvidence: (id) => write(() => api.dropEvidence(projectPath, url, id)),
              onSummary: (summary) => write(() => api.setVerdict(projectPath, url, undefined, summary)),
              onVerdict: (verdict) => write(() => api.setVerdict(projectPath, url, verdict, undefined)),
              onConfirming: () => {
                /* Asked only now: it is a subprocess, and whose login this is only matters to somebody about to post under it. */
                api
                  .login(url)
                  .then(setLogin)
                  .catch(() => setLogin(null))
              },
              onTake: (which, run) => write(() => api.takeProposal(projectPath, url, which, run)),
              onSend: async (confirmed) => {
                writes.current += 1
                try {
                  const made = await api.send(projectPath, url, confirmed)
                  setDraft({ at: 'ok', value: made.draft })
                  return made.report
                } finally {
                  writes.current += 1
                  /* Whatever happened — including a refusal — the review on disk is the truth about what was posted. Read it. */
                  reread()
                }
              },
              onReplyReword: (id, body, todo) => write(() => api.rewordReply(projectPath, url, id, body, todo)),
              onReplyDrop: (id) => write(() => api.dropReply(projectPath, url, id)),
              onReplySend: (id, body) => write(() => api.sendReply(projectPath, url, id, body)),
            }}
          />
        ) : null}
      </section>
    </HoldingContext.Provider>
  )
}

function safeHost(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return ''
  }
}
