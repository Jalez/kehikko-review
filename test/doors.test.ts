import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { WELL_KNOWN } from 'kehikot-module-protocol'

import { BUILD, MANIFEST, TICKET, answer, type Deps } from '../doors.ts'
import { forget } from '../forge/read.ts'
import type { Ran, Run } from '../forge/run.ts'
import { ID } from '../manifest.ts'
import type { Report } from '../review/send.ts'
import type { Draft } from '../review/shape.ts'

import { doorsFetch } from 'kehikot-module-protocol/serve'
import { FIRST, GH_URL, HEAD, PATCH, fake, githubReads, isPost, refused, sentBody } from './fake.ts'

/**
 * The doors, called as functions, with a tracker that is a function too.
 *
 * `deps` is handed in on every call. There is no test here that lets `answer`
 * fall back to the real runner on a path that could post.
 */
const home = mkdtempSync(join(tmpdir(), 'kehikko-review-doors-'))
afterAll(() => rmSync(home, { recursive: true, force: true }))

let n = 0
function project(): string {
  n += 1
  return mkdtempSync(join(home, `p${n}-`))
}

const none = new URLSearchParams()

function world(extra?: (run: Run, calls: Run[]) => Ran | string | undefined) {
  const runner = fake((run, calls) => extra?.(run, calls) ?? githubReads(run))
  let id = 0
  const deps: Deps = { run: runner.run, now: () => '2026-10-07T12:00:00.000Z', id: () => `c-${(id += 1)}` }
  const get = (path: string, query: Record<string, string>) => answer('GET', path, new URLSearchParams(query), null, null, deps)
  const post = (path: string, body: Record<string, unknown>, ticket: string | null = TICKET) => answer('POST', path, none, body, ticket, deps)
  const rpc = async (method: string, params: Record<string, unknown> = {}) => {
    const reply = await answer('POST', '/mcp', none, { jsonrpc: '2.0', id: 1, method, params }, null, deps)
    return reply?.body as { result?: { tools?: { name: string; description: string }[]; content?: { text: string }[]; isError?: boolean } }
  }
  const tool = async (name: string, args: Record<string, unknown>) => {
    const got = (await rpc('tools/call', { name, arguments: args })).result
    return { text: got?.content?.[0]?.text ?? '', isError: got?.isError === true }
  }
  return { runner, deps, get, post, rpc, tool }
}

const draftOf = (reply: Awaited<ReturnType<typeof answer>>) => (reply?.body as { draft: Draft }).draft
const errorOf = (reply: Awaited<ReturnType<typeof answer>>) => (reply?.body as { error?: string }).error ?? ''

beforeEach(forget)

describe('the doors', () => {
  test('the health check says which module this is', async () => {
    const reply = await answer('GET', '/healthz', none, null, null)
    expect(reply?.status).toBe(200)
    expect((reply?.body as { id: string }).id).toBe(ID)
  })

  test('the manifest is served at the well-known path by the config, and is this module’s', () => {
    /* vite.config.ts answers WELL_KNOWN with MANIFEST; this pins what it sends. */
    expect(WELL_KNOWN.startsWith('/')).toBe(true)
    expect(MANIFEST.id).toBe(ID)
  })

  test('a path that is not ours is left to Vite, and an unknown one under /api is ours to refuse', async () => {
    expect(await answer('GET', '/src/main.tsx', none, null, null)).toBeNull()
    const { get, post } = world()
    expect((await get('/api/nothing', { url: GH_URL }))?.status).toBe(404)
    expect((await post('/api/nothing', { url: GH_URL }))?.status).toBe(404)
  })
})

describe('reading through the page’s API', () => {
  test('a change is described with its commits, oldest first', async () => {
    const { get } = world()
    const reply = await get('/api/change', { url: GH_URL })
    expect(reply?.status).toBe(200)
    expect(reply?.body).toMatchObject({ ok: true, ref: 'o/r#46', head: HEAD, state: 'open', title: 'feat: an official module list', more: false })
    expect((reply?.body as { commits: { sha: string }[] }).commits.map((c) => c.sha)).toEqual([FIRST, HEAD])
  })

  test('a diff is read for the whole change or for one commit, and nothing but a sha is accepted as one', async () => {
    const { get, runner } = world()
    const all = await get('/api/diff', { url: GH_URL, view: 'all', sha: HEAD })
    expect(all?.body).toMatchObject({ ok: true, text: PATCH, truncated: false, view: 'all', sha: HEAD })
    expect((await get('/api/diff', { url: GH_URL, view: 'commit', sha: HEAD }))?.status).toBe(200)
    const before = runner.calls.length
    expect((await get('/api/diff', { url: GH_URL, view: 'commit', sha: '../../user' }))?.status).toBe(400)
    expect((await get('/api/diff', { url: GH_URL, view: 'sideways', sha: HEAD }))?.status).toBe(400)
    expect(runner.calls.length).toBe(before)
  })

  test('an address that is not a change is refused before anything is run', async () => {
    const { get, runner } = world()
    for (const url of ['', 'gh#46', 'https://github.com/o/r/issues/46', 'https://github.com/o/r;rm -rf/pull/1', 'javascript:alert(1)']) {
      expect((await get('/api/change', { url }))?.status).toBe(400)
    }
    expect(runner.calls).toHaveLength(0)
  })

  test('the tracker’s own words reach the page when a read fails', async () => {
    const { get } = world(() => refused(null, 'gh: To get started with GitHub CLI, please run: gh auth login'))
    const reply = await get('/api/change', { url: GH_URL })
    expect(reply?.status).toBe(502)
    expect(errorOf(reply)).toContain('gh auth login')
  })
})

describe('writing through the page’s API', () => {
  const comment = (projectPath: string, over: Record<string, unknown> = {}) => ({
    projectPath,
    url: GH_URL,
    view: 'all',
    commit: HEAD,
    path: 'src/one.ts',
    side: 'new',
    line: 11,
    body: 'This reads wrong.',
    ...over,
  })

  /*
   * Through the protocol's doors, as `vite.config.ts` mounts them, with a tracker that is a
   * function: the header is `x-module-ticket`, the page element is `#ticket`.
   */
  test('through the doors: a write carrying x-module-ticket lands; without it, 403 marked as the ticket', async () => {
    const dir = project()
    const { deps, runner } = world()
    const doors = doorsFetch({
      manifest: MANIFEST,
      build: BUILD,
      page: { title: 'Review', ticket: TICKET },
      answer: ((method, path, query, body, ticket) => answer(method, path, query, body, ticket, deps)) as typeof answer,
    })
    const through = async (method: string, url: string, { body, headers }: { body?: unknown; headers?: Record<string, string> } = {}) => {
      const sent = (await doors(new Request(`http://127.0.0.1${url}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })))!
      return { status: sent.status, headers: sent.headers, json: (await sent.clone().json().catch(() => null)) as Record<string, unknown>, text: await sent.text() }
    }
    const bare = await through('POST', '/api/comment', { body: comment(dir) })
    expect(bare.status).toBe(403)
    expect(bare.json.refused).toBe('ticket')
    expect(String(bare.json.error)).toContain('own page')
    expect(runner.calls).toHaveLength(0)

    const sent = await through('POST', '/api/comment', { body: comment(dir), headers: { 'x-module-ticket': TICKET } })
    expect(sent.status).toBe(200)
    expect((sent.json.draft as Draft).comments).toHaveLength(1)
    /* A draft is re-read on purpose; a cached answer would be an agent's comment that never appears. */
    expect(sent.headers.get('cache-control')).toBe('no-store')
    expect(sent.headers.get('x-module-build')).toBeTruthy()

    const page = await through('GET', '/app')
    expect(page.text).toContain(`<script id="ticket" type="application/json">${JSON.stringify(TICKET)}</script>`)
    expect(page.text).toContain('<script id="build" type="application/json">')
    expect(page.headers.get('cache-control')).toBe('no-store')
    const health = await through('GET', '/healthz')
    expect((health.json.build as { version: string }).version).toBe(BUILD.version)
    expect(health.json.id).toBe(ID)
  })

  test('every write, and the send, needs this page’s ticket — and without it nothing is even read', async () => {
    const dir = project()
    const { post, runner } = world()
    const writes: [string, Record<string, unknown>][] = [
      ['/api/comment', comment(dir)],
      ['/api/comment/reword', { projectPath: dir, url: GH_URL, id: 'c-1', body: 'x' }],
      ['/api/comment/drop', { projectPath: dir, url: GH_URL, id: 'c-1' }],
      ['/api/verdict', { projectPath: dir, url: GH_URL, verdict: 'approve' }],
      ['/api/send', { projectPath: dir, url: GH_URL, ids: [], verdict: 'approve', summary: '' }],
    ]
    for (const [path, body] of writes) {
      expect((await post(path, body, null))?.status).toBe(403)
      expect((await post(path, body, 'not-the-ticket'))?.status).toBe(403)
    }
    expect(runner.calls).toHaveLength(0)
    const read = await answer('GET', '/api/draft', new URLSearchParams({ projectPath: dir, url: GH_URL }), null, null)
    expect(draftOf(read)).toMatchObject({ comments: [], verdict: null, summary: '' })
  })

  test('a comment is anchored against the diff of its view, and stored with the quoted line', async () => {
    const dir = project()
    const { post, get } = world()
    const added = await post('/api/comment', comment(dir))
    expect(added?.status).toBe(200)
    expect(draftOf(added).comments).toEqual([
      { id: 'c-1', view: 'all', commit: HEAD, path: 'src/one.ts', side: 'new', line: 11, quote: 'is this', body: 'This reads wrong.', by: 'person', at: '2026-10-07T12:00:00.000Z' },
    ])
    /* The same file in one commit's diff has other lines: 12 is the added line
       there, and its frame is the commit, with the parent it is measured from. */
    const inCommit = await post('/api/comment', comment(dir, { view: 'commit', commit: HEAD.slice(0, 8), line: 12 }))
    expect(draftOf(inCommit).comments[1]).toMatchObject({ view: 'commit', commit: HEAD, parent: FIRST, line: 12, quote: 'and this too' })
    expect(draftOf(await get('/api/draft', { projectPath: dir, url: GH_URL })).comments).toHaveLength(2)
  })

  test('a comment that points at nothing is refused with the reason, and nothing is written', async () => {
    const dir = project()
    const { post, get } = world()
    const cases: [Record<string, unknown>, string][] = [
      [{ line: 25 }, 'is not in the diff of the whole change'],
      [{ path: 'src/elsewhere.ts' }, 'There is no file'],
      [{ line: 41, startLine: 13 }, 'cross from one hunk into another'],
      [{ body: '   ' }, 'empty comment'],
      [{ line: '11' }, 'whole number'],
      [{ side: 'sideways' }, 'side is'],
      [{ view: 'commit', commit: 'aaaaaaa' }, 'is not one of this change’s commits'],
      [{ view: 'commit', commit: 'HEAD' }, 'named by its id'],
      /* Line 40 is in the whole change's diff and not in the commit's. */
      [{ view: 'commit', commit: HEAD, line: 41 }, 'is not in the diff of commit'],
      [{ view: 'nowhere' }, 'view is'],
    ]
    for (const [over, why] of cases) {
      const reply = await post('/api/comment', comment(dir, over))
      expect(reply?.status).toBe(400)
      expect(errorOf(reply)).toContain(why)
    }
    expect(draftOf(await get('/api/draft', { projectPath: dir, url: GH_URL })).comments).toEqual([])
  })

  test('a whole-change comment aimed at a head the change has moved past is refused, not re-aimed', async () => {
    const dir = project()
    const { post } = world()
    const reply = await post('/api/comment', comment(dir, { commit: FIRST }))
    expect(reply?.status).toBe(400)
    expect(errorOf(reply)).toContain(`head is now ${HEAD.slice(0, 8)}`)
  })

  test('reword, drop and verdict change the draft; with no project there is nowhere to keep one', async () => {
    const dir = project()
    const { post } = world()
    await post('/api/comment', comment(dir))
    const reworded = await post('/api/comment/reword', { projectPath: dir, url: GH_URL, id: 'c-1', body: 'Clearer now.' })
    expect(draftOf(reworded).comments[0]).toMatchObject({ body: 'Clearer now.', editedAt: '2026-10-07T12:00:00.000Z', line: 11 })
    const verdict = await post('/api/verdict', { projectPath: dir, url: GH_URL, verdict: 'approve', summary: 'Fine.' })
    expect(draftOf(verdict)).toMatchObject({ verdict: 'approve', summary: 'Fine.' })
    expect(draftOf(await post('/api/comment/drop', { projectPath: dir, url: GH_URL, id: 'c-1' })).comments).toEqual([])
    expect((await post('/api/comment/drop', { projectPath: dir, url: GH_URL, id: 'c-1' }))?.status).toBe(400)

    expect((await post('/api/verdict', { url: GH_URL, verdict: 'approve' }))?.status).toBe(400)
    expect((await post('/api/comment', comment('relative/path')))?.status).toBe(400)
  })
})

describe('sending, against a tracker that is a function', () => {
  const reviewOk = JSON.stringify({ id: 1, html_url: `${GH_URL}#pullrequestreview-1` })

  async function drafted(extra?: Parameters<typeof world>[0]) {
    const dir = project()
    const w = world(extra)
    await w.post('/api/comment', { projectPath: dir, url: GH_URL, view: 'all', commit: HEAD, path: 'src/one.ts', side: 'new', line: 11, body: 'On the head.' })
    await w.post('/api/comment', { projectPath: dir, url: GH_URL, view: 'commit', commit: HEAD, path: 'src/one.ts', side: 'new', line: 12, body: 'In the commit.' })
    await w.post('/api/verdict', { projectPath: dir, url: GH_URL, verdict: 'approve', summary: 'Looks right.' })
    const confirmed = { projectPath: dir, url: GH_URL, ids: ['c-1', 'c-2'], verdict: 'approve', summary: 'Looks right.' }
    return { dir, confirmed, ...w }
  }

  test('what was confirmed is posted, the comments are stamped, and the draft keeps a record', async () => {
    const { post, runner, confirmed } = await drafted((run) => (isPost(run) ? reviewOk : undefined))
    const reply = await post('/api/send', confirmed)
    expect(reply?.status).toBe(200)
    const { draft, report } = reply?.body as { draft: Draft; report: Report }

    const posted = runner.calls.filter(isPost)
    expect(posted.map(sentBody)).toEqual([
      {
        commit_id: HEAD,
        event: 'APPROVE',
        body: 'Looks right.',
        comments: [
          { path: 'src/one.ts', line: 11, side: 'RIGHT', body: 'On the head.' },
          { path: 'src/one.ts', line: 12, side: 'RIGHT', body: 'In the commit.' },
        ],
      },
    ])
    expect(report).toMatchObject({ posted: ['c-1', 'c-2'], complete: true })
    expect(draft.comments.every((c) => c.sent?.url === `${GH_URL}#pullrequestreview-1`)).toBe(true)
    /* What went out is recorded, and the draft is ready for a next round. */
    expect(draft).toMatchObject({ summary: '', verdict: null })
    expect(draft.sent).toEqual([{ at: '2026-10-07T12:00:00.000Z', verdict: 'approve', head: HEAD, comments: 2, summary: 'Looks right.', notes: report.notes }])
  })

  test('pressing Send again posts nothing a second time', async () => {
    const { post, runner, confirmed } = await drafted((run) => (isPost(run) ? reviewOk : undefined))
    await post('/api/send', confirmed)
    const before = runner.calls.filter(isPost).length
    /* The same confirmation, replayed: those ids are no longer unsent. */
    expect((await post('/api/send', confirmed))?.status).toBe(409)
    /* And an honest second press, of the draft as it now is, has nothing to send. */
    const again = await post('/api/send', { ...confirmed, ids: [], verdict: null, summary: '' })
    expect(again?.status).toBe(400)
    expect(runner.calls.filter(isPost).length).toBe(before)
  })

  test('if the draft changed after the confirmation was shown, nothing is sent', async () => {
    const { post, tool, runner, confirmed, dir } = await drafted((run) => (isPost(run) ? reviewOk : undefined))
    /* An agent proposes a different verdict between the two presses. */
    await tool('set_verdict', { projectPath: dir, change: GH_URL, verdict: 'request-changes' })
    const reply = await post('/api/send', confirmed)
    expect(reply?.status).toBe(409)
    expect(errorOf(reply)).toContain('draft changed after you looked')
    expect(runner.calls.filter(isPost)).toEqual([])

    /* Likewise a comment it never showed, and a comment that does not exist. */
    await tool('set_verdict', { projectPath: dir, change: GH_URL, verdict: 'approve' })
    expect((await post('/api/send', { ...confirmed, ids: ['c-1', 'c-2', 'c-99'] }))?.status).toBe(409)
    expect(runner.calls.filter(isPost)).toEqual([])
  })

  test('a comment added after the confirmation is not swept along with it', async () => {
    const { post, tool, runner, confirmed, dir } = await drafted((run) => (isPost(run) ? reviewOk : undefined))
    await tool('add_comment', { projectPath: dir, change: GH_URL, path: 'src/one.ts', line: 12, body: 'Added late by an agent.' })
    const reply = await post('/api/send', confirmed)
    expect(reply?.status).toBe(200)
    const bodies = runner.calls.filter(isPost).map(sentBody)
    expect(JSON.stringify(bodies)).not.toContain('Added late')
    expect(draftOf(reply).comments.map((c) => Boolean(c.sent))).toEqual([true, true, false])
  })

  test('a partial failure is reported in the tracker’s words and the draft says exactly what was posted', async () => {
    const dir = project()
    const w = world((run, calls) => {
      if (!isPost(run)) return undefined
      /* The earlier commit's review lands; the final one finds the login gone. */
      return calls.filter(isPost).length === 1 ? reviewOk : refused(401, 'Bad credentials')
    })
    await w.post('/api/comment', { projectPath: dir, url: GH_URL, view: 'commit', commit: FIRST, path: 'src/one.ts', side: 'new', line: 12, body: 'On the first commit.' })
    await w.post('/api/comment', { projectPath: dir, url: GH_URL, view: 'all', commit: HEAD, path: 'src/one.ts', side: 'new', line: 11, body: 'On the head.' })
    await w.post('/api/verdict', { projectPath: dir, url: GH_URL, verdict: 'approve', summary: 'Looks right.' })

    const reply = await w.post('/api/send', { projectPath: dir, url: GH_URL, ids: ['c-1', 'c-2'], verdict: 'approve', summary: 'Looks right.' })
    expect(reply?.status).toBe(200)
    const { draft, report } = reply?.body as { draft: Draft; report: Report }
    expect(report).toMatchObject({ posted: ['c-1'], unsent: ['c-2'], complete: false, verdictSent: false })
    expect(report.error).toContain('Bad credentials')
    expect(draft.comments.map((c) => Boolean(c.sent))).toEqual([true, false])
    /* The verdict and summary did not go out, so they are still there to send. */
    expect(draft).toMatchObject({ verdict: 'approve', summary: 'Looks right.' })
    expect(draft.sent).toHaveLength(1)
    expect(draft.sent[0]).toMatchObject({ comments: 1 })
  })

  test('if the change cannot be read just before sending, nothing is posted', async () => {
    let down = false
    const { post, runner, confirmed } = await drafted((run) => (down ? refused(503, 'Service Unavailable') : isPost(run) ? reviewOk : undefined))
    down = true
    const reply = await post('/api/send', confirmed)
    expect(reply?.status).toBe(502)
    expect(errorOf(reply)).toContain('Nothing was sent')
    expect(runner.calls.filter(isPost)).toEqual([])
  })
})

describe('the MCP door', () => {
  test('lists its tools, and none of them sends', async () => {
    const { rpc } = world()
    expect((await answer('GET', '/mcp', none, null, null))?.status).toBe(405)
    const tools = (await rpc('tools/list')).result?.tools ?? []
    expect(tools.map((one) => one.name)).toEqual(['list_reviews', 'read_review', 'read_change', 'read_diff', 'add_comment', 'reword_comment', 'drop_comment', 'set_verdict'])
    /* The decision this module is built around: an agent drafts, a person sends. */
    for (const one of tools) expect(one.name).not.toMatch(/send|submit|post|publish|approve/i)
    /* And every tool that writes says so in its own description. */
    for (const one of tools.filter((t) => t.name !== 'read_change' && t.name !== 'read_diff')) expect(one.description).toContain('Nothing is posted to the tracker by this tool')
    expect(tools.find((t) => t.name === 'add_comment')!.description).toContain('HOW A COMMENT IS ANCHORED')
  })

  test('an agent cannot send by calling a tool that is not there, or by posting to the page’s door without its ticket', async () => {
    const dir = project()
    const { tool, post, runner } = world((run) => (isPost(run) ? '{}' : undefined))
    for (const name of ['send', 'send_review', 'submit_review', 'approve']) {
      const got = await tool(name, { projectPath: dir, change: GH_URL })
      expect(got.isError).toBe(true)
    }
    expect((await post('/api/send', { projectPath: dir, url: GH_URL, ids: [], verdict: 'approve', summary: '' }, null))?.status).toBe(403)
    expect(runner.calls.filter(isPost)).toEqual([])
  })

  test('each tool answers', async () => {
    const dir = project()
    const { tool } = world()
    const base = { projectPath: dir, change: GH_URL }

    expect((await tool('list_reviews', { projectPath: dir })).text).toContain('No draft reviews')

    const change = await tool('read_change', base)
    expect(change.isError).toBe(false)
    expect(change.text).toContain(`Head commit: ${HEAD}`)
    expect(change.text).toContain('11111111  first: lay the file down')
    expect(change.text).toContain('src/one.ts — changed, +3 −2')

    const whole = await tool('read_diff', base)
    expect(whole.text).toContain('call add_comment WITHOUT commit')
    /* Both numbers are printed beside every line, which is what an agent cites. */
    expect(whole.text).toContain('11    -was this')
    expect(whole.text).toContain('   11 +is this')
    const one = await tool('read_diff', { ...base, commit: HEAD.slice(0, 7), path: 'src/one.ts' })
    expect(one.text).toContain(`add_comment with commit: "${HEAD.slice(0, 8)}"`)
    expect(one.text).toContain('   12 +and this too')
    const cut = await tool('read_diff', { ...base, max_lines: 2 })
    expect(cut.text).toContain('more lines')

    const added = await tool('add_comment', { ...base, path: 'src/one.ts', line: 11, body: 'An agent thinks this is wrong.' })
    expect(added.isError).toBe(false)
    expect(added.text).toContain('It is not posted')
    const inCommit = await tool('add_comment', { ...base, commit: HEAD.slice(0, 8), path: 'src/one.ts', line: 12, start_line: 11, body: 'A range.' })
    expect(inCommit.isError).toBe(false)

    const review = await tool('read_review', base)
    expect(review.text).toContain('[c-1] src/one.ts:11 (new side, whole change at f982d895) — by an agent, draft')
    expect(review.text).toContain('[c-2] src/one.ts:11–12 (new side, commit f982d895) — by an agent, draft')

    expect((await tool('reword_comment', { ...base, id: 'c-1', body: 'Reworded.' })).isError).toBe(false)
    expect((await tool('drop_comment', { ...base, id: 'c-2' })).isError).toBe(false)
    const verdict = await tool('set_verdict', { ...base, verdict: 'request-changes', summary: 'Two things.' })
    expect(verdict.text).toContain('verdict “request-changes”')

    /* The short spelling works once a draft exists. */
    const byRef = await tool('read_review', { projectPath: dir, change: 'o/r#46' })
    expect(byRef.text).toContain('Reworded.')
    expect(byRef.text).toContain('Verdict proposed: request-changes')
    expect((await tool('list_reviews', { projectPath: dir })).text).toContain('o/r#46 — https://github.com/o/r/pull/46 — 1 draft comment, 0 sent, verdict proposed: request-changes')
  })

  test('a refusal is an answer with isError, not a transport failure', async () => {
    const dir = project()
    const { tool, rpc } = world()
    const base = { projectPath: dir, change: GH_URL }
    const refusals: [string, Record<string, unknown>, string][] = [
      ['list_reviews', {}, 'which project'],
      ['read_review', { projectPath: dir }, 'Say which change'],
      ['read_review', { projectPath: dir, change: 'o/r#46' }, 'no draft in this project is filed under it'],
      ['read_change', { projectPath: dir, change: 'https://github.com/o/r/issues/46' }, 'not a tracker URL'],
      ['read_diff', { ...base, commit: 'zzzzzzz' }, 'named by its id'],
      ['add_comment', { ...base, path: 'src/one.ts', line: 99, body: 'x' }, 'is not in the diff'],
      ['add_comment', { ...base, path: 'src/one.ts', line: 11 }, 'needs a body'],
      ['add_comment', { change: GH_URL, path: 'src/one.ts', line: 11, body: 'x' }, 'which project'],
      ['reword_comment', { ...base, id: 'c-nope', body: 'x' }, 'There is no comment'],
      ['drop_comment', { ...base, id: 'c-nope' }, 'There is no comment'],
      ['set_verdict', { ...base }, 'Give a verdict'],
      ['set_verdict', { ...base, verdict: 'ship-it' }, 'A verdict is one of'],
      ['set_verdict', { ...base, verdict: null }, 'A verdict is one of'],
      ['nonsense', { ...base }, 'no tool'],
    ]
    for (const [name, args, why] of refusals) {
      const got = await tool(name, args)
      expect(got.isError).toBe(true)
      expect(got.text).toContain(why)
    }
    /* The envelope is still a result. */
    const raw = await rpc('tools/call', { name: 'nonsense', arguments: {} })
    expect(raw.result?.isError).toBe(true)
  })

  test('an agent cannot touch a comment that has been sent', async () => {
    const dir = project()
    const { tool, post } = world((run) => (isPost(run) ? JSON.stringify({ html_url: 'u' }) : undefined))
    const base = { projectPath: dir, change: GH_URL }
    await tool('add_comment', { ...base, path: 'src/one.ts', line: 11, body: 'x' })
    await tool('set_verdict', { ...base, verdict: 'comment' })
    expect((await post('/api/send', { projectPath: dir, url: GH_URL, ids: ['c-1'], verdict: 'comment', summary: '' }))?.status).toBe(200)
    expect((await tool('reword_comment', { ...base, id: 'c-1', body: 'different' })).text).toContain('already been sent')
    expect((await tool('drop_comment', { ...base, id: 'c-1' })).text).toContain('already been sent')
    expect((await tool('read_review', base)).text).toContain('by an agent, SENT')
  })

  test('the handshake and a notification', async () => {
    const { rpc, deps } = world()
    expect((await rpc('initialize')).result).toMatchObject({ serverInfo: { name: ID } })
    expect((await answer('POST', '/mcp', none, { jsonrpc: '2.0', method: 'notifications/initialized' }, null, deps))?.status).toBe(202)
    expect((await answer('POST', '/mcp', none, { jsonrpc: '2.0', id: 1, method: 'resources/list' }, null, deps))?.status).toBe(404)
    expect((await answer('POST', '/mcp', none, null, null, deps))?.status).toBe(400)
  })
})
