import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { TICKET, answer, type Deps } from '../doors.ts'
import { forget } from '../forge/read.ts'
import type { Ran, Run } from '../forge/run.ts'
import { locate } from '../forge/locate.ts'
import type { Draft } from '../review/shape.ts'
import { readDraftFor } from '../store.ts'

import { GH_PULL, GH_URL, HEAD, GL_URL, fake, githubReads, isPost, pathOf } from './fake.ts'

/**
 * A review run, through the MCP door: its points carry meta, its summary and verdict are proposed
 * BESIDE the person's, and a re-run replaces only its own unsent comments. The person's comments,
 * summary and verdict survive every one of these, byte for byte.
 */
const home = mkdtempSync(join(tmpdir(), 'kehikko-review-runs-'))
afterAll(() => rmSync(home, { recursive: true, force: true }))
let n = 0
const project = () => mkdtempSync(join(home, `p${(n += 1)}-`))
const none = new URLSearchParams()
beforeEach(forget)

const REVIEWS = JSON.stringify([
  { user: { login: 'ada' }, state: 'APPROVED' },
  { user: { login: 'bo' }, state: 'CHANGES_REQUESTED' },
])

function world(extra?: (run: Run) => Ran | string | undefined) {
  const runner = fake((run) => {
    const said = extra?.(run)
    if (said !== undefined) return said
    if (pathOf(run) === 'repos/o/r/pulls/46/reviews?per_page=100') return REVIEWS
    return githubReads(run)
  })
  let id = 0
  const deps: Deps = { run: runner.run, now: () => '2026-10-21T12:00:00.000Z', id: () => `c-${(id += 1)}` }
  const post = (path: string, body: Record<string, unknown>) => answer('POST', path, none, body, TICKET, deps)
  const tool = async (name: string, args: Record<string, unknown>) => {
    const reply = await answer('POST', '/mcp', none, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, null, deps)
    const got = (reply?.body as { result?: { content?: { text: string }[]; isError?: boolean } }).result
    return { text: got?.content?.[0]?.text ?? '', isError: got?.isError === true }
  }
  return { runner, deps, post, tool }
}

const META = (run: string, over: Record<string, unknown> = {}) => ({
  run,
  severity: 'blocking',
  evidence: [{ kind: 'line', ref: 'src/one.ts:11', quote: 'is this' }],
  challenge: 'Maybe deliberate.',
  ruling: 'required',
  reason: 'It breaks the parser.',
  ...over,
})

const PROPOSE = (run: string, over: Record<string, unknown> = {}) => ({
  run,
  summary: 'One thing blocks this.',
  verdict: 'request-changes',
  door: 'two-way',
  uiux: false,
  pathToSuccess: ['Fix the parser at src/one.ts:11.'],
  ...over,
})

const draftAt = (dir: string): Draft => {
  const got = readDraftFor(dir, locate(GH_URL)!)
  if (!got.ok) throw new Error(got.error)
  return got.value
}

describe('a run’s points', () => {
  test('add_comment takes meta; it is kept with the head it was read at and printed for an agent', async () => {
    const dir = project()
    const { tool } = world()
    const base = { project: dir, change: GH_URL }
    const added = await tool('add_comment', { ...base, path: 'src/one.ts', line: 11, body: 'Wrong.', meta: META('run-1', { checklist: ['tests-pass'] }) })
    expect(added.isError).toBe(false)
    const kept = draftAt(dir).comments[0]!
    expect(kept.by).toBe('agent')
    expect(kept.meta).toEqual({ ...META('run-1', { checklist: ['tests-pass'] }), head: HEAD } as never)
    const read = await tool('read_review', base)
    expect(read.text).toContain('run run-1: blocking, required — It breaks the parser.')
    expect(read.text).toContain('evidence (line): src/one.ts:11')
    expect(read.text).toContain('challenged: Maybe deliberate.')
  })

  test('a meta that is not the contract’s is refused before anything is read or written', async () => {
    const dir = project()
    const { tool, runner } = world()
    const got = await tool('add_comment', { project: dir, change: GH_URL, path: 'src/one.ts', line: 11, body: 'x', meta: META('run-1', { evidence: [] }) })
    expect(got.isError).toBe(true)
    expect(got.text).toContain('evidence')
    expect(runner.calls).toHaveLength(0)
    expect(draftAt(dir).comments).toHaveLength(0)
  })
})

describe('propose_review', () => {
  test('is kept beside the person’s summary and verdict, never over them', async () => {
    const dir = project()
    const { tool, post } = world()
    await post('/api/verdict', { projectPath: dir, url: GH_URL, verdict: 'approve', summary: 'My own words.' })
    const got = await tool('propose_review', { project: dir, change: GH_URL, ...PROPOSE('run-1') })
    expect(got.isError).toBe(false)
    expect(got.text).toContain('beside the person’s')
    const draft = draftAt(dir)
    expect(draft.summary).toBe('My own words.')
    expect(draft.verdict).toBe('approve')
    expect(draft.proposal).toMatchObject({ ...PROPOSE('run-1'), head: HEAD })
    const read = await tool('read_review', { project: dir, change: GH_URL })
    expect(read.text).toContain('Proposed by run run-1')
    expect(read.text).toContain('To get this approved:')
  })

  test('refuses what is not a proposal', async () => {
    const dir = project()
    const { tool } = world()
    for (const [over, word] of [
      [{ door: 'maybe' }, 'door'],
      [{ uiux: 'yes' }, 'uiux'],
      [{ pathToSuccess: [] }, 'To get this approved'],
      [{ verdict: 'merge' }, 'verdict'],
    ] as const) {
      const got = await tool('propose_review', { project: dir, change: GH_URL, ...PROPOSE('run-1', over) })
      expect(got.isError).toBe(true)
      expect(got.text).toContain(word)
    }
    expect(draftAt(dir).proposal).toBeUndefined()
  })

  test('an agent cannot replace the person’s summary or verdict with set_verdict either', async () => {
    const dir = project()
    const { tool, post } = world()
    await post('/api/verdict', { projectPath: dir, url: GH_URL, verdict: 'approve', summary: 'Mine.' })
    expect((await tool('set_verdict', { project: dir, change: GH_URL, summary: 'Theirs.' })).text).toContain('propose_review')
    expect((await tool('set_verdict', { project: dir, change: GH_URL, verdict: 'request-changes' })).isError).toBe(true)
    expect(draftAt(dir)).toMatchObject({ summary: 'Mine.', verdict: 'approve' })
  })
})

describe('a re-run never deletes the person’s comments or summary', () => {
  test('drop_run_comments and a new run leave the person’s comments, summary and verdict exactly as they were', async () => {
    const dir = project()
    const { tool, post } = world()
    const base = { project: dir, change: GH_URL }
    /* The person writes first. */
    expect((await post('/api/comment', { projectPath: dir, url: GH_URL, view: 'all', commit: HEAD, path: 'src/one.ts', side: 'new', line: 12, body: 'My comment.' }))?.status).toBe(200)
    await post('/api/verdict', { projectPath: dir, url: GH_URL, verdict: 'comment', summary: 'My summary.' })
    const person = draftAt(dir)

    /* Run 1. */
    await tool('add_comment', { ...base, path: 'src/one.ts', line: 11, body: 'Run one, first.', meta: META('run-1') })
    await tool('add_comment', { ...base, path: 'src/one.ts', line: 12, body: 'Run one, second.', meta: META('run-1', { ruling: 'optional', severity: 'nice' }) })
    /* An agent's comment that belongs to no run, and another run's. */
    await tool('add_comment', { ...base, path: 'src/one.ts', line: 11, body: 'Loose agent comment.' })
    await tool('add_comment', { ...base, path: 'src/one.ts', line: 11, body: 'Run zero.', meta: META('run-0') })
    await tool('propose_review', { ...base, ...PROPOSE('run-1') })

    /* Run 2 replaces run 1. */
    const dropped = await tool('drop_run_comments', { ...base, run: 'run-1' })
    expect(dropped.isError).toBe(false)
    expect(dropped.text).toContain('Dropped 2')
    await tool('add_comment', { ...base, path: 'src/one.ts', line: 11, body: 'Run two.', meta: META('run-2') })
    await tool('propose_review', { ...base, ...PROPOSE('run-2', { summary: 'Now one thing.' }) })

    const after = draftAt(dir)
    expect(after.summary).toBe(person.summary)
    expect(after.verdict).toBe(person.verdict)
    expect(after.summaryBy).toBe('person')
    expect(after.comments.find((c) => c.by === 'person')).toEqual(person.comments[0]!)
    expect(after.comments.map((c) => c.body)).toEqual(['My comment.', 'Loose agent comment.', 'Run zero.', 'Run two.'])
    expect(after.proposal?.run).toBe('run-2')

    /* Dropping again, or another run, never reaches the person's. */
    await tool('drop_run_comments', { ...base, run: 'run-2' })
    await tool('drop_run_comments', { ...base, run: 'run-0' })
    expect(draftAt(dir).comments.map((c) => c.body)).toEqual(['My comment.', 'Loose agent comment.'])
    expect((await tool('drop_run_comments', { ...base, run: '../../x' })).isError).toBe(true)
  })

  test('an agent cannot reword or drop the person’s comment, and still can its own', async () => {
    const dir = project()
    const { tool, post } = world()
    const base = { project: dir, change: GH_URL }
    await post('/api/comment', { projectPath: dir, url: GH_URL, view: 'all', commit: HEAD, path: 'src/one.ts', side: 'new', line: 12, body: 'Mine.' })
    await tool('add_comment', { ...base, path: 'src/one.ts', line: 11, body: 'Theirs.' })
    for (const got of [await tool('reword_comment', { ...base, id: 'c-1', body: 'Changed.' }), await tool('drop_comment', { ...base, id: 'c-1' })]) {
      expect(got.isError).toBe(true)
      expect(got.text).toContain('the person’s own')
    }
    expect(draftAt(dir).comments[0]!.body).toBe('Mine.')
    expect((await tool('reword_comment', { ...base, id: 'c-2', body: 'Theirs, better.' })).isError).toBe(false)
    expect((await tool('drop_comment', { ...base, id: 'c-2' })).isError).toBe(false)
    /* The person still can, from the page. */
    expect((await post('/api/comment/reword', { projectPath: dir, url: GH_URL, id: 'c-1', body: 'Mine, better.' }))?.status).toBe(200)
  })
})

describe('read_change says who reviews it', () => {
  test('GitHub: reviewers and approvals from the forge', async () => {
    const dir = project()
    const { tool } = world((run) => (pathOf(run) === 'repos/o/r/pulls/46' && !run.args.includes('Accept: application/vnd.github.diff') ? JSON.stringify({ ...JSON.parse(GH_PULL), requested_reviewers: [{ login: 'cy' }] }) : undefined))
    const got = await tool('read_change', { project: dir, change: GH_URL })
    expect(got.text).toContain('Reviewers: cy (asked), ada (approved), bo (changes requested)')
    expect(got.text).toContain('Approvals: 1 — ada')
  })

  test('GitLab: reviewers, approvals and how many are still needed', async () => {
    const dir = project()
    const mr = JSON.stringify({ iid: 7, title: 't', state: 'opened', author: { username: 'ada' }, web_url: GL_URL, reviewers: [{ username: 'bo' }], diff_refs: { base_sha: HEAD, head_sha: HEAD, start_sha: HEAD } })
    const { tool } = world((run) => {
      const path = pathOf(run)
      if (path === 'projects/g%2Fsub%2Fp/merge_requests/7') return mr
      if (path === 'projects/g%2Fsub%2Fp/merge_requests/7/commits?per_page=100') return '[]'
      if (path === 'projects/g%2Fsub%2Fp/merge_requests/7/approvals') return JSON.stringify({ approved_by: [], approvals_required: 1, approvals_left: 1 })
      if (run.args[0] === 'mr') return ''
      return undefined
    })
    const got = await tool('read_change', { project: dir, change: GL_URL })
    expect(got.text).toContain('Reviewers: bo (asked)')
    expect(got.text).toContain('Approvals: none — 1 required, 1 still needed')
  })

  test('when they cannot be read, the rest of the change still is', async () => {
    const dir = project()
    const { tool } = world((run) => (pathOf(run).endsWith('/reviews?per_page=100') && !isPost(run) ? { ok: false, status: 403, text: '', error: 'gh: Forbidden (HTTP 403)' } : undefined))
    const got = await tool('read_change', { project: dir, change: GH_URL })
    expect(got.isError).toBe(false)
    expect(got.text).toContain('Reviewers and approvals could not be read: gh: Forbidden')
    expect(got.text).toContain(`Head commit: ${HEAD}`)
  })
})
