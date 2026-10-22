import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { isKehikkoBound, moduleSkillsSchema, skillPath, skillTextIssue } from 'kehikot-module-protocol'

import { TICKET, answer, type Deps } from '../doors.ts'
import { forgetFocus } from '../focus.ts'
import { locate } from '../forge/locate.ts'
import { forget } from '../forge/read.ts'
import type { Ran, Run } from '../forge/run.ts'
import { readDraft } from '../review/draft.ts'
import { keyOf } from '../review/key.ts'
import { readReview, sameReview } from '../review/md.ts'
import type { Draft } from '../review/shape.ts'
import { fill, skillDeclarations, skillTemplate, skillText } from '../skills.ts'
import { listDrafts, readDraftFor } from '../store.ts'

import { GH_URL, HEAD, fake, githubReads, isPost, pathOf, sentBody } from './fake.ts'

/**
 * Review as the review document: the Markdown store and the move from JSON, evidence kept beside
 * it, the guarantees about whose words are whose, the new tools, the replies, and the skills.
 */

const home = mkdtempSync(join(tmpdir(), 'kehikko-review-document-'))
afterAll(() => rmSync(home, { recursive: true, force: true }))
let n = 0
const project = (): string => mkdtempSync(join(home, `p${(n += 1)}-`))
const none = new URLSearchParams()
const gh = locate(GH_URL)!
const KEY = keyOf(gh)
const folder = (dir: string) => join(dir, '.kehikot', 'review')

/* A PNG's first bytes are all that is checked; the rest can be anything. */
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])

const THREADS = JSON.stringify([
  { id: 123, in_reply_to_id: null, user: { login: 'ada' }, body: 'Why is this here?', path: 'src/one.ts', line: 11, created_at: '2026-10-07T01:00:00Z' },
  { id: 124, in_reply_to_id: 123, user: { login: 'Jalez' }, body: 'Good question.', path: 'src/one.ts', line: 11, created_at: '2026-10-07T02:00:00Z' },
  { id: 200, user: { login: 'bo' }, body: 'Typo here.', path: 'README.md', original_line: 3, created_at: '2026-10-07T03:00:00Z' },
])
const REVIEWS = JSON.stringify([{ id: 1, user: { login: 'ada' }, body: 'Mostly fine.', state: 'COMMENTED', submitted_at: '2026-10-07T00:30:00Z' }])

function world(extra?: (run: Run) => Ran | string | undefined) {
  const runner = fake((run) => {
    const said = extra?.(run)
    if (said !== undefined) return said
    const path = pathOf(run)
    if (!isPost(run) && path === 'repos/o/r/pulls/46/comments?per_page=100') return THREADS
    if (!isPost(run) && path === 'repos/o/r/pulls/46/reviews?per_page=100') return REVIEWS
    if (!isPost(run) && path === 'repos/o/r/issues/46/comments?per_page=100') return '[]'
    return githubReads(run)
  })
  let id = 0
  const deps: Deps = { run: runner.run, now: () => '2026-10-07T12:00:00.000Z', id: () => `c-${(id += 1).toString(16).padStart(12, '0')}` }
  const get = (path: string, query: Record<string, string>) => answer('GET', path, new URLSearchParams(query), null, null, deps)
  const post = (path: string, body: Record<string, unknown>) => answer('POST', path, none, body, TICKET, deps)
  const tool = async (name: string, args: Record<string, unknown>) => {
    const reply = await answer('POST', '/mcp', none, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, null, deps)
    const got = (reply?.body as { result?: { content?: { text: string }[]; isError?: boolean } }).result
    return { text: got?.content?.[0]?.text ?? '', isError: got?.isError === true }
  }
  return { runner, get, post, tool }
}

const draftOf = (dir: string): Draft => {
  const read = readDraftFor(dir, gh)
  if (!read.ok) throw new Error(read.error)
  return read.value
}

beforeEach(() => {
  forget()
  forgetFocus()
})

describe('the move from JSON drafts', () => {
  const OLD = {
    version: 1,
    change: { url: GH_URL },
    comments: [
      { id: 'c-1', view: 'all', commit: HEAD, path: 'src/one.ts', side: 'new', line: 11, quote: 'is this', body: 'Mine.', by: 'person', at: 't' },
      {
        id: 'c-2',
        view: 'all',
        commit: HEAD,
        path: 'src/one.ts',
        side: 'new',
        line: 12,
        quote: 'and this too',
        body: 'An agent’s.',
        by: 'agent',
        at: 't',
        meta: { run: 'r1', severity: 'risk', evidence: [{ kind: 'line', ref: 'src/one.ts:12' }], ruling: 'optional', reason: 'Could break.', head: HEAD },
      },
    ],
    summary: 'So far:\n\n- one',
    verdict: 'comment',
    summaryBy: 'person',
    sent: [{ at: 't', verdict: 'comment', head: HEAD, comments: 1, summary: 'before', notes: ['n'] }],
    proposal: { run: 'r1', summary: 'Proposed.', verdict: 'approve', door: 'two-way', uiux: false, pathToSuccess: [], head: HEAD, at: 't' },
  }

  test('a JSON draft is read once into Markdown that says exactly the same, and kept as .json.bak', () => {
    const dir = project()
    mkdirSync(folder(dir), { recursive: true })
    writeFileSync(join(folder(dir), `${KEY}.json`), JSON.stringify(OLD))
    const read = draftOf(dir)
    expect(sameReview(read, readDraft(OLD)!)).toBe(true)
    expect(readdirSync(folder(dir)).sort()).toEqual([`${KEY}.json.bak`, `${KEY}.md`])
    /* The backup is the file as it was. */
    expect(JSON.parse(readFileSync(join(folder(dir), `${KEY}.json.bak`), 'utf8'))).toEqual(OLD)
    const md = readReview(readFileSync(join(folder(dir), `${KEY}.md`), 'utf8'))
    expect(md.ok && sameReview(md.draft, read)).toBe(true)
    /* Read again: from the Markdown; nothing moves twice. */
    expect(draftOf(dir)).toEqual(read)
    expect(readdirSync(folder(dir)).sort()).toEqual([`${KEY}.json.bak`, `${KEY}.md`])
  })

  test('a listing moves them too', () => {
    const dir = project()
    mkdirSync(folder(dir), { recursive: true })
    writeFileSync(join(folder(dir), `${KEY}.json`), JSON.stringify(OLD))
    const listed = listDrafts(dir)
    expect(listed.ok && listed.value.map((d) => d.change.url)).toEqual([GH_URL])
    expect(existsSync(join(folder(dir), `${KEY}.md`))).toBe(true)
  })

  test('a JSON file that is not a draft is refused and left exactly where it was, with no Markdown beside it', () => {
    const dir = project()
    mkdirSync(folder(dir), { recursive: true })
    writeFileSync(join(folder(dir), `${KEY}.json`), '{ broken')
    expect(readDraftFor(dir, gh).ok).toBe(false)
    expect(readdirSync(folder(dir))).toEqual([`${KEY}.json`])
  })
})

describe('evidence, kept beside the review', () => {
  const scratch = () => {
    const dir = mkdtempSync(join(tmpdir(), 'kehikko-review-evidence-'))
    return dir
  }

  test('a screenshot is copied into .kehikot/review/<key>/, listed, attached to its point, and served as a picture', async () => {
    const dir = project()
    const { tool, get } = world()
    await tool('add_comment', { project: dir, change: GH_URL, path: 'src/one.ts', line: 11, body: 'Looks off.' })
    const shot = join(scratch(), 'shot.png')
    writeFileSync(shot, PNG)
    const kept = await tool('add_evidence', { project: dir, change: GH_URL, kind: 'screenshot', path: shot, caption: 'The page after', point: 'c-000000000001' })
    expect(kept.isError).toBe(false)
    const proof = draftOf(dir).evidence[0]!
    expect(proof).toMatchObject({ kind: 'screenshot', caption: 'The page after', point: 'c-000000000001', by: 'agent', bytes: PNG.length })
    expect(proof.file).toMatch(/^e-[0-9a-f]{12}\.png$/)
    expect(readFileSync(join(folder(dir), KEY, proof.file))).toEqual(Buffer.from(PNG))
    expect(readFileSync(join(folder(dir), `${KEY}.md`), 'utf8')).toContain(`![screenshot](${KEY}/${proof.file})`)
    const served = await get('/api/evidence', { url: GH_URL, projectPath: dir, id: proof.id })
    expect(served?.status).toBe(200)
    expect(served?.raw?.type).toBe('image/png')
    expect(served?.headers?.['x-content-type-options']).toBe('nosniff')
    expect((await get('/api/evidence', { url: GH_URL, projectPath: dir, id: 'e-ffffffffffff' }))?.status).toBe(404)
  })

  test('a log is kept from text, as plain text', async () => {
    const dir = project()
    const { tool, get } = world()
    expect((await tool('add_evidence', { project: dir, change: GH_URL, kind: 'test', text: '3 pass\n1 fail', caption: 'bun test' })).isError).toBe(false)
    const proof = draftOf(dir).evidence[0]!
    expect(proof.file.endsWith('.txt')).toBe(true)
    const served = await get('/api/evidence', { url: GH_URL, projectPath: dir, id: proof.id })
    expect(served?.raw?.type).toBe('text/plain; charset=utf-8')
    expect(new TextDecoder().decode(served?.raw?.bytes as Uint8Array)).toBe('3 pass\n1 fail')
  })

  test('what is not evidence is refused, and nothing is left on disk', async () => {
    const dir = project()
    const { tool } = world()
    const base = { project: dir, change: GH_URL, caption: 'x' }
    const svg = join(scratch(), 'a.svg')
    writeFileSync(svg, '<svg onload="alert(1)"/>')
    const binary = join(scratch(), 'b.log')
    writeFileSync(binary, new Uint8Array([104, 0, 105]))
    /* A file outside the project and the temporary folder: this repository's own manifest. */
    const outside = join(import.meta.dir, '..', 'package.json')
    const cases: [Record<string, unknown>, string][] = [
      [{ kind: 'screenshot', path: svg }, 'PNG, JPEG, GIF or WebP'],
      [{ kind: 'log', path: binary }, 'NUL'],
      [{ kind: 'screenshot', text: 'words' }, 'give its file as path'],
      [{ kind: 'log', path: outside }, 'inside the project or the system’s temporary folder'],
      [{ kind: 'log', text: 'x', path: svg }, 'one of the two'],
      [{ kind: 'video', text: 'x' }, 'kind is one of'],
      [{ kind: 'log', text: 'x', caption: 'two\nlines' }, 'caption is one line'],
      [{ kind: 'log', text: 'x', point: 'c-nothere' }, 'no point "c-nothere"'],
    ]
    for (const [args, why] of cases) {
      const got = await tool('add_evidence', { ...base, ...args })
      expect(got.isError).toBe(true)
      expect(got.text).toContain(why)
    }
    expect(existsSync(join(folder(dir), KEY)) ? readdirSync(join(folder(dir), KEY)) : []).toEqual([])
  })

  test('the person removes a piece of evidence, and its file goes with it', async () => {
    const dir = project()
    const { tool, post } = world()
    await tool('add_evidence', { project: dir, change: GH_URL, kind: 'log', text: 'out', caption: 'log' })
    const proof = draftOf(dir).evidence[0]!
    expect((await post('/api/evidence/drop', { projectPath: dir, url: GH_URL, id: proof.id }))?.status).toBe(200)
    expect(draftOf(dir).evidence).toEqual([])
    expect(existsSync(join(folder(dir), KEY, proof.file))).toBe(false)
  })
})

describe('whose words are whose', () => {
  const META = { run: 'review-pass', severity: 'risk', evidence: [{ kind: 'line', ref: 'src/one.ts:12' }], ruling: 'optional', reason: 'Might break.' }

  test('a re-run replaces only its own unsent points the person has not kept, with the evidence it collected for them', async () => {
    const dir = project()
    const { tool, post } = world()
    const base = { project: dir, change: GH_URL }
    await tool('add_comment', { ...base, path: 'src/one.ts', line: 11, body: 'The person’s.' }) /* c-1, by the agent tool but… */
    await post('/api/comment', { projectPath: dir, url: GH_URL, view: 'all', commit: HEAD, path: 'src/one.ts', line: 12, body: 'Mine.' }) /* c-2, the person's */
    await tool('add_comment', { ...base, path: 'src/one.ts', line: 12, body: 'Run point, kept.', meta: META }) /* c-3 */
    await tool('add_comment', { ...base, path: 'src/one.ts', line: 11, body: 'Run point, not kept.', meta: META }) /* c-4 */
    await post('/api/comment/keep', { projectPath: dir, url: GH_URL, id: 'c-000000000003' })
    await tool('add_evidence', { ...base, kind: 'log', text: 'run log', caption: 'the run', run: 'review-pass' })
    await tool('add_evidence', { ...base, kind: 'log', text: 'on c-4', caption: 'on the point', point: 'c-000000000004' })
    await post('/api/comment', { projectPath: dir, url: GH_URL, view: 'all', commit: HEAD, path: 'src/one.ts', line: 11, body: 'Another of mine.' })
    const before = draftOf(dir)
    const files = before.evidence.map((p) => p.file)

    const dropped = await tool('drop_run_comments', { ...base, run: 'review-pass' })
    expect(dropped.text).toContain('Dropped 1 of run review-pass’s unsent comment,')
    const after = draftOf(dir)
    expect(after.comments.map((c) => c.body)).toEqual(['The person’s.', 'Mine.', 'Run point, kept.', 'Another of mine.'])
    expect(after.evidence).toEqual([])
    for (const file of files) expect(existsSync(join(folder(dir), KEY, file))).toBe(false)
    /* A kept point is the person's now: an agent may not change it. */
    expect((await tool('reword_comment', { ...base, id: 'c-000000000003', body: 'changed' })).text).toContain('kept that point')
    expect((await tool('drop_comment', { ...base, id: 'c-000000000003' })).text).toContain('kept that point')
  })

  test('the person editing an agent’s point keeps it', async () => {
    const dir = project()
    const { tool, post } = world()
    await tool('add_comment', { project: dir, change: GH_URL, path: 'src/one.ts', line: 11, body: 'agent words' })
    await post('/api/comment/reword', { projectPath: dir, url: GH_URL, id: 'c-000000000001', body: 'my words now' })
    expect(draftOf(dir).comments[0]).toMatchObject({ by: 'agent', body: 'my words now', kept: '2026-10-07T12:00:00.000Z' })
  })

  test('a sent point can be resolved and opened again; a draft cannot be resolved', async () => {
    const dir = project()
    const { post } = world((run) => (isPost(run) ? JSON.stringify({ html_url: 'https://github.com/o/r/pull/46#r' }) : undefined))
    await post('/api/comment', { projectPath: dir, url: GH_URL, view: 'all', commit: HEAD, path: 'src/one.ts', line: 11, body: 'Mine.' })
    expect((await post('/api/comment/resolve', { projectPath: dir, url: GH_URL, id: 'c-000000000001', resolved: true }))?.status).toBe(400)
    await post('/api/verdict', { projectPath: dir, url: GH_URL, verdict: 'comment' })
    expect((await post('/api/send', { projectPath: dir, url: GH_URL, ids: ['c-000000000001'], verdict: 'comment', summary: '' }))?.status).toBe(200)
    expect((await post('/api/comment/resolve', { projectPath: dir, url: GH_URL, id: 'c-000000000001', resolved: true }))?.status).toBe(200)
    expect(draftOf(dir).comments[0]?.resolved).toBe('2026-10-07T12:00:00.000Z')
    expect(readFileSync(join(folder(dir), `${KEY}.md`), 'utf8')).toContain('- State: resolved')
    await post('/api/comment/resolve', { projectPath: dir, url: GH_URL, id: 'c-000000000001', resolved: false })
    expect(draftOf(dir).comments[0]?.resolved).toBeUndefined()
  })
})

describe('the new tools', () => {
  test('read_review_md is the file itself, and it reads back as the review read_review prints', async () => {
    const dir = project()
    const { tool } = world()
    expect((await tool('read_review_md', { project: dir, change: GH_URL })).text).toContain('There is no review of o/r#46 in this project yet')
    await tool('add_comment', { project: dir, change: GH_URL, path: 'src/one.ts', line: 11, body: 'A point.' })
    const md = (await tool('read_review_md', { project: dir, change: GH_URL })).text
    const [file, ...rest] = md.split('\n\n')
    expect(file).toBe(join(realpathSync(folder(dir)), `${KEY}.md`))
    const parsed = readReview(rest.join('\n\n'))
    expect(parsed.ok && sameReview(parsed.draft, draftOf(dir))).toBe(true)
    expect(md).toContain(`- Code: src/one.ts:11@${HEAD}`)
  })

  test('read_focus says what the page has open and where somebody points', async () => {
    const dir = project()
    const { tool, post } = world()
    expect((await tool('read_focus', { project: dir })).text).toContain('has not said what it has open')
    const location = { change: 'gh#46', path: 'src/one.ts', line: 10, endLine: 12, side: 'new', commit: HEAD, intent: 'comment', by: 'kehikot.source', at: 'now' }
    expect((await post('/api/focus', { projectPath: dir, url: GH_URL, ref: 'gh#46', title: 'feat', location }))?.status).toBe(200)
    const said = (await tool('read_focus', { project: dir })).text
    expect(said).toContain('Review has o/r#46 open (gh#46 on the canvas): feat — https://github.com/o/r/pull/46')
    expect(said).toContain('Somebody asked for a point at src/one.ts:10-12 (new side, at f982d895), from kehikot.source')
    expect(said).toContain('path "src/one.ts", line 12, start_line 10, side "new"')
    /* A location in another change is not this page's to report. */
    await post('/api/focus', { projectPath: dir, url: GH_URL, ref: 'gh#46', title: 'feat', location: { ...location, change: 'gh#47' } })
    expect((await tool('read_focus', { project: dir })).text).toContain('Nobody is pointing')
    expect((await post('/api/focus', { projectPath: dir, url: GH_URL, ref: 'gh#46', location: { path: '../etc' } }))?.status).toBe(400)
  })

  test('read_threads lists the threads received, and who is signed in', async () => {
    const dir = project()
    const { tool } = world()
    const said = (await tool('read_threads', { project: dir, change: GH_URL })).text
    expect(said).toContain('The tracker is signed in as Jalez; o/r#46 is by Jalez.')
    expect(said).toContain('[gh-conversation] the conversation')
    expect(said).toContain('[gh-comment:123] src/one.ts:11')
    expect(said).toContain('[gh-comment:200] README.md:3')
    expect(said).toContain('Good question.')
  })

  test('draft_reply keeps one reply per thread, never over the person’s, and the page posts exactly what was shown', async () => {
    const dir = project()
    const { tool, post, runner } = world((run) => (isPost(run) ? JSON.stringify({ id: 9, html_url: 'https://github.com/o/r/pull/46#discussion_r9' }) : undefined))
    const base = { project: dir, change: GH_URL }
    expect((await tool('draft_reply', { ...base, thread: 'gh-comment:999', body: 'x' })).text).toContain('no thread gh-comment:999')
    expect((await tool('draft_reply', { ...base, thread: 'gh-comment:123', body: 'First try.', todo: 'Rename it.' })).isError).toBe(false)
    expect((await tool('draft_reply', { ...base, thread: 'gh-comment:123', body: 'Second try.' })).isError).toBe(false)
    let replies = draftOf(dir).replies
    expect(replies).toHaveLength(1)
    expect(replies[0]).toMatchObject({ thread: 'gh-comment:123', where: 'src/one.ts:11', from: 'Jalez', said: 'Good question.', body: 'Second try.', by: 'agent' })
    const id = replies[0]!.id
    await post('/api/reply/reword', { projectPath: dir, url: GH_URL, id, body: 'My reply.', todo: 'Rename the helper.' })
    expect((await tool('draft_reply', { ...base, thread: 'gh-comment:123', body: 'Agent again.' })).text).toContain('theirs')

    const posted = () => runner.calls.filter(isPost)
    expect((await post('/api/reply/send', { projectPath: dir, url: GH_URL, id, body: 'Not what was shown.' }))?.status).toBe(409)
    expect(posted()).toEqual([])
    expect((await post('/api/reply/send', { projectPath: dir, url: GH_URL, id, body: 'My reply.' }))?.status).toBe(200)
    expect(posted().map(pathOf)).toEqual(['repos/o/r/pulls/46/comments/123/replies'])
    expect(sentBody(posted()[0]!)).toEqual({ body: 'My reply.' })
    replies = draftOf(dir).replies
    expect(replies[0]?.sent).toEqual({ at: '2026-10-07T12:00:00.000Z', url: 'https://github.com/o/r/pull/46#discussion_r9' })
    expect((await post('/api/reply/send', { projectPath: dir, url: GH_URL, id, body: 'My reply.' }))?.status).toBe(409)
    expect(posted()).toHaveLength(1)
  })

  test('the reply to the conversation goes to the conversation; a GitLab discussion is answered in it', async () => {
    const { replyCommand } = await import('../forge/threads.ts')
    expect(replyCommand(gh, 'gh-conversation', 'hi')?.args[1]).toBe('repos/o/r/issues/46/comments')
    const gl = locate('https://gitlab.example/g/sub/p/-/merge_requests/7')!
    expect(replyCommand(gl, 'gl-discussion:0123456789abcdef', 'hi')?.args[1]).toBe('projects/g%2Fsub%2Fp/merge_requests/7/discussions/0123456789abcdef/notes')
    expect(replyCommand(gl, 'gh-conversation', 'hi')).toBeNull()
    expect(replyCommand(gh, 'gh-comment:1/../../x', 'hi')).toBeNull()
  })

  test('there is still no tool that sends', async () => {
    const reply = await answer('POST', '/mcp', none, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, null)
    const names = ((reply?.body as { result: { tools: { name: string }[] } }).result.tools).map((t) => t.name)
    for (const name of names) expect(name).not.toMatch(/send|submit|post|publish|approve|resolve/i)
  })
})

describe('the skills Review provides', () => {
  const NAMES = ['review-pass', 'review-point', 'review-reply'] as const
  const head = (text: string) => text.split('---')[1]!
  const ALLOWED: Record<(typeof NAMES)[number], string[]> = {
    'review-pass': ['read_focus', 'read_change', 'read_diff', 'read_review', 'read_review_md', 'add_comment', 'add_evidence', 'propose_review', 'drop_run_comments'],
    'review-point': ['read_focus', 'read_diff', 'read_review', 'add_comment'],
    'review-reply': ['read_focus', 'read_change', 'read_diff', 'read_review', 'read_threads', 'draft_reply'],
  }

  test('each passes skillTextIssue with the origin filled in, and names no port of its own', () => {
    for (const name of NAMES) {
      const text = skillText(name, 'http://127.0.0.1:18001')!
      expect(skillTextIssue(text, name)).toBeNull()
      expect(text).toContain('http://127.0.0.1:18001/app')
      expect(text).not.toContain('{{origin}}')
      expect(text).not.toContain('{{version}}')
      expect(skillTemplate(name)).not.toMatch(/127\.0\.0\.1:\d/)
    }
  })

  test('only a person runs them, and each may call exactly its own Review tools — no shell, no gh, no writes', async () => {
    const reply = await answer('POST', '/mcp', none, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, null)
    const tools = new Set(((reply?.body as { result: { tools: { name: string }[] } }).result.tools).map((t) => t.name))
    for (const name of NAMES) {
      const front = head(skillTemplate(name)!)
      expect(front).toContain(`name: ${name}`)
      expect(front).toContain('disable-model-invocation: true')
      const allowed = /allowed-tools:\s*(.+)/.exec(front)![1]!.split(/,\s*/)
      expect(allowed).toEqual(ALLOWED[name].map((tool) => `mcp__review__${tool}`))
      for (const tool of ALLOWED[name]) expect(tools.has(tool)).toBe(true)
      expect(/allowed-tools:\s*(.+)/.exec(front)![1]).not.toMatch(/Bash|Write|Edit|Read|gh|glab/)
      expect(skillTemplate(name)).toContain('Never post')
    }
  })

  test('none of them is kehikko-bound: Source and Diff are welcome, not needed', () => {
    const declared = skillDeclarations('http://127.0.0.1:8000')
    expect(moduleSkillsSchema.safeParse(declared).success).toBe(true)
    expect(declared.map((one) => one.name)).toEqual([...NAMES])
    for (const one of declared) expect(isKehikkoBound(one)).toBe(false)
  })

  test('the version follows the text and the origin; each is served at the protocol’s path', async () => {
    const a = fill(skillTemplate('review-pass')!, 'http://127.0.0.1:8000')
    const b = fill(skillTemplate('review-pass')!, 'http://127.0.0.1:8001')
    expect(a.version).not.toBe(b.version)
    expect(a.text).toContain(`[skill ${a.version}]`)
    for (const name of NAMES) {
      const served = await answer('GET', skillPath(name), none, null, null)
      expect(served?.status).toBe(200)
      expect(served?.raw?.type).toBe('text/markdown; charset=utf-8')
      expect(String(served?.raw?.bytes)).toContain(`name: ${name}`)
    }
    expect(await answer('GET', '/kehikot/skills/other.md', none, null, null)).toBeNull()
  })
})
