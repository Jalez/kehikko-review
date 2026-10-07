import { trackerReadingResult } from 'kehikot-module-protocol'

/**
 * What each selected reference IS, as the host's tracker reading says.
 *
 * ## Why this has to be asked
 *
 * A selection is `['gh#46']`. That string does not say whether it is an issue
 * or a pull request (GitHub numbers both in one sequence), which repository it
 * belongs to, or where its page is — and this app can do nothing with a change
 * it has no address for. The host keeps one shared reading of the trackers for
 * every module, and `tracker.get` answers from it: a row per ref with its
 * `kind`, its `url`, its title and its state.
 *
 * ## Asking is not waiting
 *
 * `tracker.get` answers at once from what the host holds. A ref it has not
 * read comes back under `missing` as `pending` and the host starts the read;
 * `context.tracker.at` moves when it lands, and the question is asked again
 * then. So a ref is `asking` until an answer has a row for it — or until a
 * read has landed without one, at which point this gives up and says so,
 * because "asking…" for ever is a sentence that is not true.
 *
 * This is the same reading, with the same give-up rule, as Diff's
 * `live/heads.ts`. It differs in what it needs: Diff cannot fetch without the
 * head commit in a ref's DETAIL, and waits for it. Review reads the head from
 * the forge itself (see `forge/read.ts`), so a row is enough to begin, and the
 * detail's head — when it arrives — is kept only as a hint that the change has
 * moved since the page last asked the forge.
 */
export type Seen =
  /** `since` is the reading's `at` when this was first asked; a later `at` means a read has landed since. */
  | { at: 'asking'; since: string | null | undefined }
  | { at: 'change'; url: string; title: string; state: string; head: string | null }
  | { at: 'issue'; url: string; title: string }
  | { at: 'none'; why: string }

export type SeenAll = Readonly<Record<string, Seen>>

const NONE = {
  'not-found': 'the tracker has nothing under that reference',
  'no-tracker': 'this project reads no tracker that reference could belong to',
  failed: 'the last read of its tracker failed',
} as const

/**
 * What one `tracker.get` answer says about each ref that was asked.
 *
 * `was` is what was believed before, and it matters twice: a ref already known
 * is not un-known by an answer that merely has not read it again, and a ref
 * that was already being asked gives up once a read has landed without it.
 */
export function readSeen(refs: readonly string[], answer: unknown, was: SeenAll): Record<string, Seen> {
  const parsed = trackerReadingResult.safeParse(answer)
  const out: Record<string, Seen> = {}
  if (!parsed.success) {
    for (const ref of refs) out[ref] = { at: 'none', why: 'the host answered with something that is not a tracker reading' }
    return out
  }
  const reading = parsed.data
  for (const ref of refs) {
    /* `hasOwn`, because a ref is a string a stranger chose and `was['constructor']`
       is a function on every object. */
    const before = Object.hasOwn(was, ref) ? was[ref] : undefined
    const row = reading.rows.find((one) => one.ref === ref)
    if (row) {
      out[ref] =
        row.kind === 'change'
          ? {
              at: 'change',
              url: row.url,
              title: row.title,
              state: row.state,
              /* A head already heard is kept when this answer carries no detail:
                 the detail is read per ref on request and may simply not have
                 been re-read. */
              head: row.detail?.headSha ?? (before?.at === 'change' ? before.head : null),
            }
          : { at: 'issue', url: row.url, title: row.title }
      continue
    }
    const missing = reading.missing.find((one) => one.ref === ref)
    if (missing && missing.reason !== 'pending') {
      out[ref] = { at: 'none', why: NONE[missing.reason] }
      continue
    }
    if (!missing) {
      out[ref] = { at: 'none', why: 'the host did not answer for that reference' }
      continue
    }
    /* Not read yet. Keep what was known; otherwise wait — unless a read has
       landed since this was first asked and nothing is running now. */
    if (before?.at === 'change' || before?.at === 'issue') {
      out[ref] = before
      continue
    }
    const since = before?.at === 'asking' && before.since !== undefined ? before.since : reading.at
    const landed = before?.at === 'asking' && before.since !== undefined && reading.at !== before.since
    out[ref] = landed && !reading.refreshing ? { at: 'none', why: 'the tracker was read and that reference did not come back' } : { at: 'asking', since }
  }
  return out
}

/**
 * Which change the page shows: the one the person picked from the switcher if
 * it is still a selected change, and otherwise the first selected ref that is
 * one. Review works on one change at a time, because a review is of one.
 */
export function current(selection: readonly string[], seen: SeenAll, picked: string | null): string | null {
  const changes = selection.filter((ref) => Object.hasOwn(seen, ref) && seen[ref]?.at === 'change')
  if (picked && changes.includes(picked)) return picked
  return changes[0] ?? null
}
