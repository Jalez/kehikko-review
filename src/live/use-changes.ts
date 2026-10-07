import { useEffect, useRef, useState } from 'react'

import { HostRefused } from 'kehikot-module-protocol/client'
import { LIMITS } from 'kehikot-module-protocol'

import type { Host } from '@/wire/use-kehikot'

import { readSeen, type Seen, type SeenAll } from './changes.ts'

/**
 * The selected refs, each as what the tracker reading says it is.
 *
 * Asks `tracker.get { refs, detail: 'detail' }` when the selection changes and
 * again whenever `trackerAt` moves — the first answer is usually "not read
 * yet", and the reading moving is the only signal that the read landed.
 *
 * `detail: 'detail'` although a summary row would be enough to begin: it is
 * the question Diff asks about the same refs, so the host makes one read at
 * the tracker for both modules, and the head commit that comes with it tells
 * this page when a change has been pushed to.
 */
export function useChanges(host: Host): { seen: SeenAll; refused: string | null } {
  const [seen, setSeen] = useState<SeenAll>({})
  const [refused, setRefused] = useState<string | null>(null)
  /* Which question is the current one. A selection moves faster than a slow
     host answers, and the answer about the previous selection must not be
     filed under this one. */
  const asking = useRef(0)
  const { where, selection, trackerAt, request, epic } = host

  /* A ref spelled the same in another epic is that epic's to ask about. */
  useEffect(() => {
    asking.current += 1
    setSeen({})
    setRefused(null)
  }, [epic])

  useEffect(() => {
    if (where !== 'hosted' || !selection.length) return
    const asked = selection.slice(0, LIMITS.TRACKER_ASK)
    const mine = (asking.current += 1)
    /* Said at once, so the page reads "asking the tracker" rather than nothing.
       Only the selected refs are kept: what was learned about a ref that is no
       longer selected is not needed and should not grow without bound. */
    setSeen((was) =>
      Object.fromEntries(asked.map((ref) => [ref, Object.hasOwn(was, ref) ? was[ref]! : ({ at: 'asking', since: undefined } satisfies Seen)])),
    )
    request('tracker.get', { refs: asked, detail: 'detail' })
      .then((data) => {
        if (asking.current !== mine) return
        setRefused(null)
        setSeen((was) => ({ ...was, ...readSeen(asked, data, was) }))
      })
      .catch((error: unknown) => {
        if (asking.current !== mine) return
        /* A refusal is an answer: a host that keeps no tracker reading, or one
           that will not give this module `trackers:read`. The page says which,
           in the host's words, and does not retry. */
        setRefused(error instanceof HostRefused ? error.refusal.error : 'This app failed while reading the host’s answer.')
      })
  }, [where, selection, trackerAt, request])

  return { seen, refused }
}
