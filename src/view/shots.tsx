import { useEffect, useMemo, useState } from 'react'

import { Button } from '@/components/ui/button'
import type { Api } from '@/wire/api'

import { locate } from '../../forge/locate.ts'
import { allowedImage, type Shot, type Shots } from '../../review/shots.ts'
import { OutLink } from './out-link.tsx'

/**
 * The Before / after view: the pictures the change's author posted, before beside after.
 *
 * The server has already kept only `https:` images on the forge's own hosts (`review/shots.ts`);
 * the page asks the same question again of every address before it makes an `<img>` of it, so a
 * server answer is never the only thing between a stranger's address and a request from this
 * browser. An image is loaded with no referrer, and its "open" link opens it in a new tab and
 * nothing else. What was refused is said in words — its host and why — with no link and no image.
 */

type Loaded = { at: 'loading' } | { at: 'error'; error: string } | { at: 'ok'; shots: Shots; unread?: string }

const say = (error: unknown): string => (error instanceof Error ? error.message : String(error))

const note = (text: string) => <p className="text-[0.7rem] leading-4 text-muted-foreground">{text}</p>

export function ShotsView({ api, url }: { api: Api; url: string }) {
  const [loaded, setLoaded] = useState<Loaded>({ at: 'loading' })
  const [again, setAgain] = useState(0)
  const target = useMemo(() => locate(url), [url])
  useEffect(() => {
    let live = true
    setLoaded({ at: 'loading' })
    api
      .shots(url)
      .then((got) => live && setLoaded({ at: 'ok', shots: got.shots, ...(got.unread ? { unread: got.unread } : {}) }))
      .catch((e: unknown) => live && setLoaded({ at: 'error', error: say(e) }))
    return () => {
      live = false
    }
  }, [api, url, again])

  const safe = (shot: Shot): string | null => {
    if (!target) return null
    const allowed = allowedImage(shot.url, target)
    return allowed.ok && allowed.url === shot.url ? allowed.url : null
  }
  const forge = target?.forge === 'gitlab' ? 'GitLab' : 'GitHub'

  return (
    <section data-testid="shots" aria-label="Before and after" className="flex min-w-0 flex-col gap-2 text-[0.7rem] leading-4">
      {loaded.at === 'loading' ? note('Looking for pictures in the description and the comments…') : null}
      {loaded.at === 'error' ? (
        <div className="flex flex-col gap-1">
          <p role="alert" className="rounded-md border border-del-mark/50 bg-del px-2 py-1 font-mono">
            {loaded.error}
          </p>
          <p>
            <Button type="button" variant="link" size="sm" className="h-auto p-0 text-[0.7rem]" onClick={() => setAgain((n) => n + 1)}>
              Try again
            </Button>
          </p>
        </div>
      ) : null}
      {loaded.at === 'ok' ? (
        <>
          {!loaded.shots.pairs.length && !loaded.shots.single.length
            ? note(
                'No pictures were found in the description or the comments. A change to what people see should show before and after pictures of the screens it changes.',
              )
            : null}
          {loaded.shots.pairs.map((pair, at) => (
            <div key={at} data-pair className="grid min-w-0 grid-cols-2 gap-1">
              <Figure shot={pair.before} label="Before" src={safe(pair.before)} forge={forge} />
              <Figure shot={pair.after} label="After" src={safe(pair.after)} forge={forge} />
            </div>
          ))}
          {loaded.shots.single.length ? (
            <>
              <p className="text-muted-foreground">Not paired — no “before” or “after” next to {loaded.shots.single.length === 1 ? 'it' : 'them'}:</p>
              <div className="grid min-w-0 grid-cols-2 gap-1">
                {loaded.shots.single.map((shot, at) => (
                  <Figure key={at} shot={shot} label={shot.label === 'before' ? 'Before' : shot.label === 'after' ? 'After' : 'Picture'} src={safe(shot)} forge={forge} />
                ))}
              </div>
            </>
          ) : null}
          {loaded.shots.refused.length ? (
            <ul data-refused className="flex min-w-0 flex-col gap-0.5 text-muted-foreground">
              {loaded.shots.refused.map((one, at) => (
                <li key={at} className="min-w-0 [overflow-wrap:anywhere]">
                  A picture in {one.where} is not shown: {one.why}.
                </li>
              ))}
            </ul>
          ) : null}
          {loaded.shots.more ? note('There are more pictures than this view lists; the rest are on the tracker.') : null}
          {loaded.unread ? note(loaded.unread) : null}
        </>
      ) : null}
    </section>
  )
}

function Figure({ shot, label, src, forge }: { shot: Shot; label: string; src: string | null; forge: string }) {
  const [failed, setFailed] = useState(false)
  return (
    <figure className="flex min-w-0 flex-col gap-0.5">
      <figcaption className="min-w-0 [overflow-wrap:anywhere]">
        <span className="font-semibold">{label}</span>
        <span className="text-muted-foreground">
          {' '}
          · {shot.where}
          {shot.alt ? ` — ${shot.alt}` : ''}
        </span>
      </figcaption>
      {src && !failed ? (
        <img
          src={src}
          alt={shot.alt || label}
          referrerPolicy="no-referrer"
          loading="lazy"
          decoding="async"
          onError={() => setFailed(true)}
          className="h-auto max-w-full rounded-sm border"
        />
      ) : (
        <p className="text-muted-foreground">
          {src ? `This picture could not be loaded here; a private repository’s pictures need you signed in to ${forge}.` : 'Not shown: its address is not one this view loads.'}
        </p>
      )}
      {src ? (
        <OutLink href={src}>open</OutLink>
      ) : null}
    </figure>
  )
}
