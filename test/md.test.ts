import { describe, expect, test } from 'bun:test'

import { locate } from '../forge/locate.ts'
import { emptyDraft } from '../review/draft.ts'
import { keyOf } from '../review/key.ts'
import { inline, readReview, sameReview, statusOf, writeReview } from '../review/md.ts'
import { changeOf, type Draft } from '../review/shape.ts'

import { FIRST, GH_URL, GL_URL, HEAD, MERGE_BASE } from './fake.ts'

/**
 * The review as Markdown: written, read back strictly, and the same — down to the byte.
 */

const gh = locate(GH_URL)!
const gl = locate(GL_URL)!
const KEY = keyOf(gh)
const T = '2026-10-22T10:00:00.000Z'

/** A review with every part a review can have, and words chosen to break a careless format. */
export function full(): Draft {
  return {
    ...emptyDraft(changeOf(gh)),
    head: HEAD,
    summary: 'Line one.\n\n```js\nconst fence = "inside"\n```\n## Points\n---\nNot a heading, not front matter.',
    summaryBy: 'person',
    verdict: 'request-changes',
    verdictBy: 'agent',
    proposal: {
      run: 'review-pass',
      summary: 'One thing blocks this.',
      verdict: 'request-changes',
      door: 'two-way',
      uiux: true,
      pathToSuccess: ['Fix the parser at `src/one.ts:11`.', 'A step "quoted"\nover two lines'],
      head: HEAD,
      at: T,
      taken: { verdict: T },
      sent: { at: T, head: HEAD },
    },
    comments: [
      {
        id: 'c-0123456789ab',
        view: 'all',
        commit: HEAD,
        path: 'src/with space:and colon.ts',
        side: 'new',
        line: 12,
        startLine: 10,
        quote: '  indented\n\ttabbed   \n',
        body: 'Has ```` four backticks, a trailing space \nand "quotes".',
        by: 'agent',
        at: T,
        editedAt: T,
        kept: T,
        meta: {
          run: 'review-pass',
          severity: 'blocking',
          evidence: [
            { kind: 'line', ref: 'src/one.ts:11', quote: 'multi\nline' },
            { kind: 'practice', ref: 'https://example.org/a b' },
          ],
          challenge: 'It may be deliberate: \\ backslash.',
          ruling: 'required',
          reason: 'It breaks the parser.',
          checklist: ['Tests pass', ' leading space'.trim()],
          head: HEAD,
        },
      },
      {
        id: 'c-ffffffffffff',
        view: 'commit',
        commit: FIRST,
        parent: MERGE_BASE,
        path: 'a/now.ts',
        oldPath: 'a/was.ts',
        side: 'old',
        line: 3,
        otherLine: 4,
        quote: '',
        body: 'sent and resolved',
        by: 'person',
        at: T,
        sent: { at: T, url: 'https://github.com/o/r/pull/46#discussion_r1', folded: true },
        resolved: T,
      },
      { id: 'legacy id from json', view: 'all', commit: HEAD, path: 'x.ts', side: 'new', line: 1, quote: 'q', body: '', by: 'person', at: '' },
    ],
    evidence: [
      { id: 'e-0123456789ab', kind: 'screenshot', caption: 'The settings page, after', file: 'e-0123456789ab.png', bytes: 1234, point: 'c-0123456789ab', run: 'review-pass', by: 'agent', at: T },
      { id: 'e-aaaaaaaaaaaa', kind: 'test', caption: '"bun test" output', file: 'e-aaaaaaaaaaaa.txt', bytes: 0, by: 'person', at: T },
    ],
    replies: [
      { id: 'r-0123456789ab', thread: 'gh-comment:123', where: 'src/one.ts:11', from: 'ada', said: 'Why?\n> quoted', body: 'Because.', todo: '', by: 'agent', at: T },
      { id: 'r-bbbbbbbbbbbb', thread: 'gh-conversation', where: 'the conversation', from: 'bo', said: '', body: 'Thanks!', todo: 'Rename it.', by: 'person', at: T, editedAt: T, sent: { at: T } },
    ],
    sent: [
      { at: T, verdict: 'comment', head: '', comments: 0, summary: '', notes: [] },
      { at: T, verdict: 'approve', head: HEAD, comments: 2, summary: 'Fine.\n', notes: ['1 comment was folded.', 'Two\nlines'] },
    ],
  }
}

describe('a review as Markdown', () => {
  test('write → read → the same review, and writing it again is the same text', () => {
    for (const draft of [full(), emptyDraft(changeOf(gh)), emptyDraft(changeOf(gl))]) {
      const key = keyOf(locate(draft.change.url)!)
      const text = writeReview(draft, key)
      const back = readReview(text)
      if (!back.ok) throw new Error(back.error)
      expect(sameReview(back.draft, draft)).toBe(true)
      expect(back.draft).toEqual(draft)
      expect(writeReview(back.draft, key)).toBe(text)
    }
  })

  test('it reads as a document: front matter, the sections in order, link-like code references', () => {
    const text = writeReview(full(), KEY)
    expect(text.startsWith('---\nreview: 1\nchange: https://github.com/o/r/pull/46\n')).toBe(true)
    expect(text).toContain(`head: ${HEAD}\nverdict: request-changes\n`)
    expect(text).toContain('door: two-way\nuiux: yes\nstatus: draft\n---')
    const headings = writeReview({ ...full(), summary: 'plain' }, KEY).split('\n').filter((line) => line.startsWith('## '))
    expect(headings).toEqual(['## Summary', '## Points', '## Evidence', '## Replies', '## Sent'])
    expect(text).toContain(`- Code: src/with space:and colon.ts:10-12@${HEAD}`)
    expect(text).toContain('- Severity: blocking\n- Ruling: required\n- Reason: It breaks the parser.')
    expect(text).toContain('- State: kept')
    expect(text).toContain('- State: resolved')
    expect(text).toContain('To get this approved:\n\n1. Fix the parser at `src/one.ts:11`.\n2. "A step \\"quoted\\"\\nover two lines"')
    expect(text).toContain(`![screenshot](${KEY}/e-0123456789ab.png)`)
    expect(text).toContain(`[e-aaaaaaaaaaaa.txt](${KEY}/e-aaaaaaaaaaaa.txt)`)
    /* Words with a fence of four backticks get a fence of five. */
    expect(text).toContain('`````text body\nHas ```` four backticks')
  })

  test('a value is written as it is when it is one plain line, and as a JSON string otherwise', () => {
    expect(inline('plain words: fine')).toBe('plain words: fine')
    expect(inline('')).toBe('""')
    expect(inline(' leading')).toBe('" leading"')
    expect(inline('trailing ')).toBe('"trailing "')
    expect(inline('two\nlines')).toBe('"two\\nlines"')
    expect(inline('"quoted"')).toBe('"\\"quoted\\""')
    expect(inline('back\\slash')).toBe('"back\\\\slash"')
  })

  test('the status in the front matter says where the review stands', () => {
    const empty = emptyDraft(changeOf(gh))
    expect(statusOf(empty)).toBe('empty')
    expect(statusOf(full())).toBe('draft')
    expect(statusOf({ ...empty, sent: full().sent })).toBe('sent')
  })
})

describe('the strict reader', () => {
  const text = () => writeReview(full(), KEY)
  const refused = (changed: string, why: RegExp) => {
    const read = readReview(changed)
    expect(read.ok).toBe(false)
    if (!read.ok) expect(read.error).toMatch(why)
  }

  test('refuses what it did not write, and says at which line', () => {
    refused('# just notes\n', /^line 1: expected "---"/)
    refused(text().replace('review: 1', 'review: 2'), /reads format 1/)
    refused(text().replace('change: https://github.com/o/r/pull/46', 'change: https://evil.example/x'), /change is the pull or merge request/)
    refused(text().replace('- Side: new', '- Side: sideways'), /Side is one of new, old/)
    refused(text().replace('- State: kept', '- State: sent'), /State says sent/)
    refused(text().replace(`- Code: src/with space:and colon.ts:10-12@${HEAD}`, '- Code: src/one.ts@nope'), /Code is path:line@commit/)
    refused(text().replace('- Severity: blocking', '- Severity: dire'), /severity/)
    refused(text().replace('## Evidence', '## Proof'), /expected "## Evidence"/)
    refused(text().replace('- Point: c-0123456789ab', '- Point: c-nothere'), /no point c-nothere/)
    refused(text().replace('File: e-0123456789ab.png', 'File: ../../etc/passwd'), /File is the evidence’s id/)
    refused(text().replace(`![screenshot](${KEY}/`, '![screenshot](elsewhere/'), /link to the evidence’s file/)
    refused(text().slice(0, -1), /does not end with a newline/)
    refused(`${text()}extra\n`, /^line \d+: expected ""/)
  })

  test('a fence is closed only by its own backticks, so words cannot end their block', () => {
    const draft = { ...emptyDraft(changeOf(gh)), summary: '```\n````\n```text summary\n' }
    const back = readReview(writeReview(draft, KEY))
    expect(back.ok && back.draft.summary).toBe(draft.summary)
  })

  test('a file for another change than its key is still read as that change: the store refuses it, not the reader', () => {
    const back = readReview(writeReview(emptyDraft(changeOf(gl)), keyOf(gl)))
    expect(back.ok && back.draft.change.url).toBe(GL_URL)
  })
})
