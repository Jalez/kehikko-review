import { describe, expect, test } from 'bun:test'

import { current, readSeen, type SeenAll } from '../src/live/changes.ts'

import { GH_URL, HEAD } from './fake.ts'

/**
 * What a `tracker.get` answer says about each selected ref — including the
 * give-up rule, without which a ref the tracker will never return says
 * "asking…" for ever.
 */
const AT = '2026-10-07T10:00:00.000Z'
const LATER = '2026-10-07T10:01:00.000Z'

const row = (ref: string, over: Record<string, unknown> = {}) => ({
  ref,
  tracker: 'github',
  host: 'github.com',
  repo: 'o/r',
  number: 46,
  kind: 'change',
  state: 'open',
  title: 'feat: an official module list',
  url: GH_URL,
  readAt: AT,
  ...over,
})

const reading = (over: Record<string, unknown>) => ({ at: AT, refreshing: false, sources: [], rows: [], missing: [], ...over })

describe('readSeen', () => {
  test('a row is enough to begin: kind, address, title and state', () => {
    const got = readSeen(['gh#46', 'gh#12'], reading({ rows: [row('gh#46'), row('gh#12', { kind: 'issue', title: 'A bug', url: 'https://github.com/o/r/issues/12' })] }), {})
    expect(got).toEqual({
      'gh#46': { at: 'change', url: GH_URL, title: 'feat: an official module list', state: 'open', head: null },
      'gh#12': { at: 'issue', url: 'https://github.com/o/r/issues/12', title: 'A bug' },
    })
  })

  test('the detail’s head is kept as a hint, and survives an answer that did not re-read it', () => {
    const detailed = readSeen(['gh#46'], reading({ rows: [row('gh#46', { detail: { headSha: HEAD, readAt: AT } })] }), {})
    expect(detailed['gh#46']).toMatchObject({ at: 'change', head: HEAD })
    const again = readSeen(['gh#46'], reading({ rows: [row('gh#46')] }), detailed)
    expect(again['gh#46']).toMatchObject({ at: 'change', head: HEAD })
  })

  test('a ref not read yet is being asked; what was known stays known', () => {
    const first = readSeen(['!3105'], reading({ missing: [{ ref: '!3105', reason: 'pending' }], refreshing: true }), {})
    expect(first['!3105']).toEqual({ at: 'asking', since: AT })
    const known: SeenAll = { '!3105': { at: 'change', url: 'u', title: 't', state: 'open', head: null } }
    expect(readSeen(['!3105'], reading({ missing: [{ ref: '!3105', reason: 'pending' }] }), known)['!3105']).toEqual(known['!3105']!)
  })

  test('it gives up once a read has landed without the ref, and not before', () => {
    const asking: SeenAll = { '!3105': { at: 'asking', since: AT } }
    const pending = { missing: [{ ref: '!3105', reason: 'pending' }] }
    /* Same reading: nothing has landed. */
    expect(readSeen(['!3105'], reading(pending), asking)['!3105']).toEqual({ at: 'asking', since: AT })
    /* A later reading that is still running: keep waiting. */
    expect(readSeen(['!3105'], reading({ ...pending, at: LATER, refreshing: true }), asking)['!3105']).toEqual({ at: 'asking', since: AT })
    /* A later reading, finished, still without it: say so. */
    expect(readSeen(['!3105'], reading({ ...pending, at: LATER }), asking)['!3105']).toEqual({ at: 'none', why: 'the tracker was read and that reference did not come back' })
  })

  test('each reason the tracker has nothing gets its own words', () => {
    const got = readSeen(
      ['a', 'b', 'c', 'd'],
      reading({ missing: [{ ref: 'a', reason: 'not-found' }, { ref: 'b', reason: 'no-tracker' }, { ref: 'c', reason: 'failed' }] }),
      {},
    )
    expect(got.a).toEqual({ at: 'none', why: 'the tracker has nothing under that reference' })
    expect(got.b).toEqual({ at: 'none', why: 'this project reads no tracker that reference could belong to' })
    expect(got.c).toEqual({ at: 'none', why: 'the last read of its tracker failed' })
    expect(got.d).toEqual({ at: 'none', why: 'the host did not answer for that reference' })
  })

  test('an answer that is not a reading leaves every ref without one, and a ref named like a property is just a ref', () => {
    expect(readSeen(['gh#46'], { rows: 'nope' }, {})['gh#46']).toMatchObject({ at: 'none' })
    const got = readSeen(['constructor'], reading({ missing: [{ ref: 'constructor', reason: 'pending' }] }), {})
    expect(got['constructor'] as unknown).toEqual({ at: 'asking', since: AT })
  })
})

describe('current', () => {
  const seen: SeenAll = {
    'gh#12': { at: 'issue', url: 'i', title: 'A bug' },
    'gh#46': { at: 'change', url: 'a', title: 'A', state: 'open', head: null },
    'gh#47': { at: 'change', url: 'b', title: 'B', state: 'open', head: null },
  }

  test('the first selected ref that is a change, unless another selected change was picked', () => {
    expect(current(['gh#12', 'gh#46', 'gh#47'], seen, null)).toBe('gh#46')
    expect(current(['gh#12', 'gh#46', 'gh#47'], seen, 'gh#47')).toBe('gh#47')
    /* A pick that is no longer selected, or is not a change, does not hold. */
    expect(current(['gh#12', 'gh#46'], seen, 'gh#47')).toBe('gh#46')
    expect(current(['gh#12', 'gh#46'], seen, 'gh#12')).toBe('gh#46')
    expect(current(['gh#12'], seen, null)).toBeNull()
    expect(current([], seen, null)).toBeNull()
  })
})
