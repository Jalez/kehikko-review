import { useState } from 'react'

import { Cover, useServerStanding, type CoverState } from 'kehikot-module-protocol/client/react'

import { Button } from '@/components/ui/button'
import { current, type Seen } from '@/live/changes'
import { useChanges } from '@/live/use-changes'
import { ChangeReview } from '@/view/change-review'
import { api as realApi, knock, type Api } from '@/wire/api'
import { useKehikot, type Host } from '@/wire/use-kehikot'

export function App() {
  return <Screen host={useKehikot()} />
}

/**
 * The whole page, rendered from a plain `Host` and an injectable `Api`, so a
 * test can draw any state of it with two objects and no host, no server and no
 * tracker (see test/render.test.tsx).
 *
 * ## Every absence has its own sentence
 *
 * There are six ways for this page to have no change to review, and each sends
 * the reader somewhere different: nothing is framing it; a host is and nothing
 * is selected; the host will not say what the selection is; what is selected
 * is an issue; the tracker has never heard of it; or it is still being asked.
 * One "no change selected" for all of them would be true every time and useful
 * none.
 *
 * The first two — and this app's own server not answering, and this page being
 * older than that server — are the protocol's shared `Cover`: the same mark and
 * the same sentence every module says them with. The rest are this module's.
 *
 * ## What is drawn stays mounted under a cover
 *
 * `down` and `stale` can arrive with a half-written comment on screen. So the
 * review is hidden under those covers rather than unmounted, and Try again asks
 * the server and then has the review re-ask whatever of it had failed (`round`)
 * — nothing somebody typed is thrown away to draw a sentence.
 *
 * ## One change at a time
 *
 * A review is of one change, sent to one place, with one verdict. So of
 * everything selected, the page works on the first that IS a change; when
 * several are, a row of buttons picks between them. The other selected refs
 * are still named below with what they are, because a selected reference that
 * produced nothing on screen is indistinguishable from a selection that never
 * happened.
 */
export function Screen({ host, api = realApi }: { host: Host; api?: Api }) {
  const { seen, refused } = useChanges(host)
  const [picked, setPicked] = useState<string | null>(null)
  /* How this page's own server last answered: `down` when nothing did, `stale` when it has restarted under this page. */
  const server = useServerStanding()
  const [round, setRound] = useState(0)

  const refName = current(host.selection, seen, picked)
  const row = refName && Object.hasOwn(seen, refName) ? seen[refName] : undefined
  const changes = host.selection.filter((ref) => Object.hasOwn(seen, ref) && seen[ref]?.at === 'change')
  const others = host.selection.filter((ref) => !changes.includes(ref))

  /*
   * Which cover, if any. Not `coverFor`: that helper says "unhosted" only for a module that needs a
   * project, and this one reads a diff without one — what it needs is a selection, which is its own
   * sentence below.
   */
  const cover: CoverState | null =
    server === 'stale'
      ? 'stale'
      : host.where === 'listening'
        ? 'waiting'
        : host.where === 'unhosted'
          ? 'unhosted'
          : server === 'down'
            ? 'down'
            : null

  return (
    /* `min-w-0` and `overflow-x-hidden` on the one scroller: nothing on this
       page may make it scroll sideways. A diff that is wider than the frame
       scrolls inside its own file, and everything else wraps or truncates. */
    <main className="flex h-screen min-w-0 flex-col gap-2 overflow-x-hidden overflow-y-auto p-2 text-sm">
      {cover ? (
        <Cover
          state={cover}
          name="Review"
          onRetry={() => void knock().then(() => setRound((n) => n + 1))}
          /* What this module is for, which the shared sentence cannot say. */
          detail={cover === 'unhosted' ? UNHOSTED : null}
        />
      ) : null}

      <div hidden={cover !== null} className={cover ? undefined : 'contents'}>
      {host.where === 'hosted' && !host.selection.length ? (
        <Note>
          Nothing is selected. Select a pull request or merge request anywhere on the canvas — in References, Journeys or any module that
          lists them — and its diff and your review of it appear here.
        </Note>
      ) : null}

      {host.where === 'hosted' && host.selection.length && refused ? (
        <Note>
          {`Kehikot would not say what ${host.selection.join(', ')} ${host.selection.length === 1 ? 'is' : 'are'}: ${refused} Without the tracker reading this app has a reference and no address for it, so there is nothing it can review.`}
        </Note>
      ) : null}

      {changes.length > 1 ? (
        <div className="flex min-w-0 flex-wrap items-center gap-1 text-[0.7rem] leading-4" role="group" aria-label="Which change to review">
          <span className="text-muted-foreground">{changes.length} changes are selected; reviewing one:</span>
          {changes.map((ref) => (
            <Button
              key={ref}
              type="button"
              size="sm"
              variant={ref === refName ? 'default' : 'outline'}
              aria-pressed={ref === refName}
              className="h-6 max-w-full px-2 font-mono text-[0.7rem]"
              onClick={() => setPicked(ref)}
            >
              <span className="truncate">{ref}</span>
            </Button>
          ))}
        </div>
      ) : null}

      {refName && row?.at === 'change' ? (
        <ChangeReview
          /* Keyed by the change: another change is another review, and no
             state of this one — the view, a half-picked range, a confirmation
             in progress — may carry over to it. */
          key={`${host.projectPath ?? ''}|${row.url}`}
          refName={refName}
          url={row.url}
          title={row.title}
          hintHead={row.head}
          projectPath={host.projectPath}
          api={api}
          round={round}
        />
      ) : null}

      {host.where === 'hosted' && !refused
        ? others.map((ref) => <Other key={ref} refName={ref} seen={Object.hasOwn(seen, ref) ? seen[ref] : undefined} />)
        : null}
      </div>
    </main>
  )
}

/** The second line under the unhosted cover: what this module is, and how a change gets here. */
export const UNHOSTED =
  'Review is a module for a Kehikot canvas: place it there, select a pull request or merge request, and it is shown here to be '
  + 'reviewed line by line.'

function Note({ children }: { children: React.ReactNode }) {
  return <p className="text-[0.7rem] leading-4 text-muted-foreground">{children}</p>
}

/** A selected reference that is not a change being reviewed, said as what it is. */
function Other({ refName, seen }: { refName: string; seen: Seen | undefined }) {
  const text = !seen || seen.at === 'asking'
    ? `Asking Kehikot’s tracker reading what ${refName} is…`
    : seen.at === 'issue'
      ? `${refName} is an issue rather than a change, so there is nothing to review: an issue has no commits and no diff. Nothing went wrong.`
      : seen.at === 'none'
        ? `${refName} cannot be reviewed — ${seen.why}.${/failed|did not come back/.test(seen.why) ? ' Refreshing the trackers may bring it.' : ''}`
        : null
  if (!text) return null
  return (
    <p className="text-[0.7rem] leading-4 text-muted-foreground" data-ref={refName} data-kind={seen?.at ?? 'asking'}>
      {text}
    </p>
  )
}
