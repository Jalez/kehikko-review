import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DATA_FILE } from 'kehikot-module-protocol'

import { locate, type Target } from '../forge/locate.ts'
import { addComment, dropComment, emptyDraft, readDraft, rewordComment, setVerdict, stamp, bodyOf } from '../review/draft.ts'
import { keyOf } from '../review/key.ts'
import { MAX_BODY, MAX_COMMENTS, MAX_SUMMARY, changeOf, type Draft } from '../review/shape.ts'
import { changeDraft, listDrafts, readDraftFor } from '../store.ts'

import { GH_URL, GL_URL, HEAD } from './fake.ts'

const home = mkdtempSync(join(tmpdir(), 'kehikko-review-store-'))
afterAll(() => rmSync(home, { recursive: true, force: true }))

function project(name: string): string {
  const dir = join(home, name)
  mkdirSync(dir, { recursive: true })
  return dir
}

const gh = locate(GH_URL)!
const gl = locate(GL_URL)!
const anchor = { path: 'src/one.ts', side: 'new' as const, line: 11, quote: 'is this' }
const add = (draft: Draft, id: string, body = 'words') => addComment(draft, { view: 'all', commit: HEAD, anchor }, body, 'person', '2026-10-07T00:00:00Z', id)

describe('the key a draft is filed under', () => {
  test('is a name the protocol lets a module give a file, whatever the repository is called', () => {
    const awkward: Target[] = [
      gh,
      gl,
      { forge: 'gitlab', repo: 'Group.With.Dots/Sub_Group/A-Very-Long-Project-Name-That-Goes-On-And-On-And-On-For-Ever', number: 123456789, host: 'git.example:8443' },
      { forge: 'github', repo: '_/_', number: 1 },
    ]
    for (const target of awkward) expect(DATA_FILE.test(keyOf(target))).toBe(true)
    expect(keyOf(gh)).toMatch(/^gh-o-r-46-[0-9a-f]{8}$/)
  })

  test('two repositories that slug to the same word still get two files', () => {
    const dotted = keyOf({ forge: 'github', repo: 'a.b/c', number: 1 })
    const dashed = keyOf({ forge: 'github', repo: 'a-b/c', number: 1 })
    expect(dotted.slice(0, -8)).toBe(dashed.slice(0, -8))
    expect(dotted).not.toBe(dashed)
  })

  test('the same number on another host, forge or repository is another change', () => {
    const keys = new Set([
      keyOf({ forge: 'gitlab', repo: 'g/p', number: 7 }),
      keyOf({ forge: 'gitlab', repo: 'g/p', number: 7, host: 'gitlab.example' }),
      keyOf({ forge: 'github', repo: 'g/p', number: 7 }),
      keyOf({ forge: 'gitlab', repo: 'g/p', number: 8 }),
    ])
    expect(keys.size).toBe(4)
  })
})

describe('the store', () => {
  test('a draft written is the draft read, kept inside the project, one file per change', () => {
    const dir = project('round-trip')
    expect(readDraftFor(dir, gh)).toEqual({ ok: true, value: emptyDraft(changeOf(gh)) })
    const written = changeDraft(dir, gh, (draft) => add(draft, 'c-1'))
    expect(written.ok).toBe(true)
    changeDraft(dir, gl, (draft) => setVerdict(draft, 'approve', 'fine'))

    const read = readDraftFor(dir, gh)
    expect(read.ok && read.value.comments.map((c) => c.id)).toEqual(['c-1'])
    expect(existsSync(join(dir, '.kehikot', 'review', `${keyOf(gh)}.json`))).toBe(true)
    expect(existsSync(join(dir, '.kehikot', 'review', `${keyOf(gl)}.json`))).toBe(true)

    const listed = listDrafts(dir)
    expect(listed.ok && listed.value.map((d) => d.change.url).sort()).toEqual([GH_URL, GL_URL].sort())
  })

  test('with no project there is nowhere to read or write', () => {
    expect(readDraftFor(null, gh).ok).toBe(false)
    expect(changeDraft(null, gh, (draft) => add(draft, 'c-1')).ok).toBe(false)
    expect(changeDraft('relative/path', gh, (draft) => add(draft, 'c-1')).ok).toBe(false)
    expect(listDrafts(join(home, 'does-not-exist')).ok).toBe(false)
  })

  test('a .kehikot that points out of the project is refused', () => {
    const dir = project('escaping')
    const elsewhere = project('elsewhere')
    symlinkSync(elsewhere, join(dir, '.kehikot'))
    expect(changeDraft(dir, gh, (draft) => add(draft, 'c-1')).ok).toBe(false)
    expect(readDraftFor(dir, gh).ok).toBe(false)
    expect(listDrafts(dir).ok).toBe(false)
    expect(existsSync(join(elsewhere, 'review'))).toBe(false)
  })

  test('a draft file that is a link out of the project is refused, not followed', () => {
    const dir = project('linked-file')
    const outside = join(project('outside'), 'secret.json')
    writeFileSync(outside, JSON.stringify(emptyDraft(changeOf(gh))))
    mkdirSync(join(dir, '.kehikot', 'review'), { recursive: true })
    symlinkSync(outside, join(dir, '.kehikot', 'review', `${keyOf(gh)}.json`))
    expect(readDraftFor(dir, gh).ok).toBe(false)
    expect(listDrafts(dir)).toEqual({ ok: true, value: [] })
  })

  test('a refused change writes nothing', () => {
    const dir = project('refused')
    const got = changeDraft(dir, gh, () => ({ ok: false, error: 'no' }))
    expect(got).toEqual({ ok: false, error: 'no' })
    expect(existsSync(join(dir, '.kehikot'))).toBe(false)
  })

  test('a file that is not a draft is an error to read and is left alone', () => {
    const dir = project('garbage')
    changeDraft(dir, gh, (draft) => add(draft, 'c-1'))
    const file = join(dir, '.kehikot', 'review', `${keyOf(gh)}.json`)
    writeFileSync(file, '{ not json')
    expect(readDraftFor(dir, gh).ok).toBe(false)
    expect(changeDraft(dir, gh, (draft) => add(draft, 'c-2')).ok).toBe(false)
    expect(readFileSync(file, 'utf8')).toBe('{ not json')
  })

  test('a file holding another change’s draft under this change’s name is not used', () => {
    /* The address a draft is sent to is never taken from a field somebody
       could edit: a draft whose URL is a different change is in the wrong file. */
    const dir = project('misfiled')
    mkdirSync(join(dir, '.kehikot', 'review'), { recursive: true })
    writeFileSync(join(dir, '.kehikot', 'review', `${keyOf(gh)}.json`), JSON.stringify(emptyDraft(changeOf(gl))))
    expect(readDraftFor(dir, gh).ok).toBe(false)
    expect(listDrafts(dir)).toEqual({ ok: true, value: [] })
  })
})

describe('what may happen to a draft', () => {
  const base = emptyDraft(changeOf(gh))

  test('a body is trimmed, must say something, and has a length', () => {
    expect(bodyOf('  hello  ')).toEqual({ ok: true, body: 'hello' })
    expect(bodyOf('   ').ok).toBe(false)
    expect(bodyOf(12).ok).toBe(false)
    expect(bodyOf('x'.repeat(MAX_BODY + 1)).ok).toBe(false)
    expect(bodyOf('x'.repeat(MAX_BODY)).ok).toBe(true)
  })

  test('a draft holds a bounded number of unsent comments, and sent ones do not count against it', () => {
    let draft = base
    for (let i = 0; i < MAX_COMMENTS; i += 1) {
      const next = add(draft, `c-${i}`)
      if (!next.ok) throw new Error(next.error)
      draft = next.draft
    }
    const over = add(draft, 'c-over')
    expect(!over.ok && over.error).toContain(`${MAX_COMMENTS} unsent comments`)
    const afterSend = stamp(draft, ['c-0'], { at: 'now' })
    expect(add(afterSend, 'c-more').ok).toBe(true)
  })

  test('a summary has a length, a verdict is one of three, and either can be set alone', () => {
    expect(setVerdict(base, 'approve', undefined)).toEqual({ ok: true, draft: { ...base, verdict: 'approve' } })
    expect(setVerdict({ ...base, verdict: 'approve' }, undefined, 'looks right')).toEqual({ ok: true, draft: { ...base, verdict: 'approve', summary: 'looks right' } })
    expect(setVerdict({ ...base, verdict: 'approve' }, null, undefined)).toEqual({ ok: true, draft: base })
    expect(setVerdict(base, 'merge', undefined).ok).toBe(false)
    expect(setVerdict(base, undefined, 'x'.repeat(MAX_SUMMARY + 1)).ok).toBe(false)
    expect(setVerdict(base, undefined, 42).ok).toBe(false)
  })

  test('a sent comment is neither reworded nor dropped: it is on the tracker now', () => {
    const one = add(base, 'c-1')
    if (!one.ok) throw new Error(one.error)
    const sent = stamp(one.draft, ['c-1'], { at: '2026-10-07T01:00:00Z', url: 'https://github.com/o/r/pull/46#pullrequestreview-1' })

    const reworded = rewordComment(sent, 'c-1', 'different words', 'later')
    expect(!reworded.ok && reworded.error).toContain('already been sent')
    const dropped = dropComment(sent, 'c-1')
    expect(!dropped.ok && dropped.error).toContain('already been sent')

    /* And a stamp is not rewritten by a later one. */
    expect(stamp(sent, ['c-1'], { at: 'again', folded: true }).comments[0]!.sent).toEqual(sent.comments[0]!.sent)
  })

  test('an unsent comment can be reworded and dropped, and an unknown id is refused', () => {
    const one = add(base, 'c-1')
    if (!one.ok) throw new Error(one.error)
    const reworded = rewordComment(one.draft, 'c-1', 'better', 'later')
    expect(reworded.ok && reworded.draft.comments[0]).toMatchObject({ body: 'better', editedAt: 'later', line: 11, path: 'src/one.ts' })
    expect(dropComment(one.draft, 'c-1')).toEqual({ ok: true, draft: base })
    expect(dropComment(one.draft, 'c-nope').ok).toBe(false)
    expect(rewordComment(one.draft, { evil: true }, 'x', 'later').ok).toBe(false)
  })

  test('a draft read off disk is bounded and re-addressed from its own URL', () => {
    const read = readDraft({
      version: 1,
      /* The fields beside the URL disagree with it. The URL wins: it went
         through the whitelist, they did not. */
      change: { url: GH_URL, forge: 'gitlab', repo: 'somebody/elses', number: 999, host: 'evil.example' },
      comments: [
        { id: 'c-1', view: 'commit', commit: HEAD, path: 'a.ts', side: 'old', line: 3, startLine: 9, quote: 'q', body: 'b'.repeat(MAX_BODY * 2), by: 'agent', at: 't' },
        { id: 'c-2', commit: 'not-a-sha', path: 'a.ts', line: 3 },
        { id: 'c-3', commit: HEAD, path: 'a.ts', line: -1 },
        'nonsense',
      ],
      summary: 's'.repeat(MAX_SUMMARY * 2),
      verdict: 'ship it',
      sent: [{ at: 't', verdict: 'approve', head: HEAD, comments: 2, notes: ['fine', 7] }, { verdict: 'approve' }],
    })
    expect(read?.change).toEqual(changeOf(gh))
    expect(read?.comments).toHaveLength(1)
    expect(read?.comments[0]).toMatchObject({ id: 'c-1', view: 'commit', side: 'old', line: 3, by: 'agent' })
    /* A start after the line is not a range. */
    expect(read?.comments[0]?.startLine).toBeUndefined()
    expect(read?.comments[0]?.body).toHaveLength(MAX_BODY)
    expect(read?.summary).toHaveLength(MAX_SUMMARY)
    expect(read?.verdict).toBeNull()
    expect(read?.sent).toEqual([{ at: 't', verdict: 'approve', head: HEAD, comments: 2, summary: '', notes: ['fine'] }])

    expect(readDraft({ version: 2, change: { url: GH_URL } })).toBeNull()
    expect(readDraft({ version: 1, change: { url: 'https://github.com/o/r/issues/46' } })).toBeNull()
    expect(readDraft(null)).toBeNull()
  })
})
