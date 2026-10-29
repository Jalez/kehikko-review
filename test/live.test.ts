import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { watching } from 'kehikot-module-protocol/serve'

import { TICKET, answer, stream, type Deps } from '../doors.ts'
import { factorySend } from '../factory/door.ts'
import { KEY_FILE, ensureKey } from '../factory/key.ts'
import { locate } from '../forge/locate.ts'
import { forget } from '../forge/read.ts'
import type { Run } from '../forge/run.ts'
import { EVENTS_PATH, NEWS, stopWatching, topicOf, watcherCount } from '../live.ts'
import { keyOf } from '../review/key.ts'
import { reviewText } from '../store.ts'

import { GH_PULL, GH_URL, fake, githubReads, isPost, pathOf } from './fake.ts'

/**
 * The page's stream: the server says when a review changed, so the page never asks on a clock. Each
 * test opens the stream the way the doors do (`stream(method, path, query, emit)`), writes the review
 * down one of the real paths — the page's press, an agent's tool, Factory's send, a hand edit — and
 * checks the news arrived.
 */

const home = realpathSync(mkdtempSync(join(tmpdir(), 'kehikko-review-live-')))
afterAll(() => rmSync(home, { recursive: true, force: true }))
let n = 0
const project = () => mkdtempSync(join(home, `p${(n += 1)}-`))
const none = new URLSearchParams()
const settle = (ms = 200) => new Promise((resolve) => setTimeout(resolve, ms))

type Closable = { close: () => void }
const open: Closable[] = []
function follow(projectPath: string, url = GH_URL): unknown[] {
  const heard: unknown[] = []
  const live = stream('GET', EVENTS_PATH, new URLSearchParams({ projectPath, url }), (event) => heard.push(event), null) as Closable | null
  expect(live && 'close' in live).toBe(true)
  open.push(live!)
  return heard
}

beforeEach(forget)
afterEach(() => {
  while (open.length) open.pop()!.close()
  stopWatching()
})

function world() {
  const runner = fake((run: Run) => {
    if (isPost(run)) return JSON.stringify({ id: 1, html_url: `${GH_URL}#pullrequestreview-1` })
    if (pathOf(run) === 'repos/o/r/pulls/46' && !run.args.includes('Accept: application/vnd.github.diff')) return GH_PULL
    return githubReads(run)
  })
  let id = 0
  const deps: Deps = { run: runner.run, now: () => '2026-10-21T12:00:00.000Z', id: () => `c-${(id += 1)}` }
  const post = (path: string, body: Record<string, unknown>) => answer('POST', path, none, body, TICKET, deps)
  const tool = async (name: string, args: Record<string, unknown>) => {
    const reply = await answer('POST', '/mcp', none, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, null, deps)
    const got = (reply?.body as { result?: { content?: { text: string }[]; isError?: boolean } }).result
    if (got?.isError) throw new Error(got.content?.[0]?.text)
    return got?.content?.[0]?.text ?? ''
  }
  return { runner, deps, post, tool }
}

describe('the stream door', () => {
  test('opens on a review with the news once, follows its topic, and lets go when closed', () => {
    const dir = project()
    expect(follow(dir)).toEqual([NEWS])
    const topic = topicOf(dir, keyOf(locate(GH_URL)!))
    expect(watching(topic)).toBe(1)
    open.pop()!.close()
    expect(watching(topic)).toBe(0)
  })

  test('another path, no project, or an address that is not a change is not the stream', () => {
    const dir = project()
    expect(stream('GET', '/api/draft', new URLSearchParams({ projectPath: dir, url: GH_URL }), () => {}, null)).toBeNull()
    expect(stream('GET', EVENTS_PATH, new URLSearchParams({ url: GH_URL }), () => {}, null)).toBeNull()
    expect(stream('GET', EVENTS_PATH, new URLSearchParams({ projectPath: dir, url: 'https://example.com/nothing' }), () => {}, null)).toBeNull()
  })
})

describe('news is published where a review is written', () => {
  test('the page\'s press and an agent\'s tool', async () => {
    const dir = project()
    const w = world()
    const heard = follow(dir)
    await w.post('/api/verdict', { projectPath: dir, url: GH_URL, verdict: 'comment', summary: 'Mine.' })
    await settle()
    expect(heard).toEqual([NEWS, NEWS])
    await w.tool('add_comment', { project: dir, change: GH_URL, path: 'src/one.ts', line: 11, body: 'An agent\'s point.' })
    await settle()
    expect(heard).toEqual([NEWS, NEWS, NEWS])
  })

  test('Factory\'s send', async () => {
    const dir = project()
    const w = world()
    const file = join(home, `keys${n}`, KEY_FILE)
    const made = ensureKey(file)
    if (!made.ok) throw new Error(made.error)
    const meta = { run: 'run-1', severity: 'blocking', evidence: [{ kind: 'line', ref: 'src/one.ts:11' }], ruling: 'required', reason: 'It breaks the parser.' }
    await w.tool('add_comment', { project: dir, change: GH_URL, path: 'src/one.ts', line: 11, body: 'Point.', meta })
    await w.tool('propose_review', {
      project: dir, change: GH_URL, run: 'run-1', summary: 'One thing blocks this.', verdict: 'request-changes', door: 'two-way', uiux: false,
      pathToSuccess: ['Fix the parser at src/one.ts:11.'],
    })
    const heard = follow(dir)
    stopWatching() /* only the write itself can publish now */
    const reply = await factorySend(w.deps, made.key, { project: dir, change: GH_URL, run: 'run-1' }, file)
    expect(reply.status).toBe(200)
    await settle()
    expect(heard).toEqual([NEWS, NEWS])
  })

  test('a hand edit of the review file, seen by the watcher over the folder', async () => {
    const dir = project()
    const w = world()
    await w.post('/api/verdict', { projectPath: dir, url: GH_URL, verdict: 'comment', summary: 'Mine.' })
    const heard = follow(dir)
    expect(watcherCount()).toBe(1)
    const said = reviewText(dir, locate(GH_URL)!)
    if (!said.ok) throw new Error(said.error)
    writeFileSync(said.value.file, readFileSync(said.value.file, 'utf8').replace('Mine.', 'Edited by hand.'))
    await settle()
    expect(heard).toEqual([NEWS, NEWS])
    /* Another file in the same folder is not this review's news. */
    writeFileSync(join(said.value.file, '..', 'stray.txt'), 'x')
    await settle()
    expect(heard).toEqual([NEWS, NEWS])
  })

  test('a page that opened before the review folder existed is watched from the first write on', async () => {
    const dir = project()
    const w = world()
    const heard = follow(dir)
    expect(watcherCount()).toBe(0)
    await w.post('/api/verdict', { projectPath: dir, url: GH_URL, verdict: 'comment', summary: 'Mine.' })
    expect(watcherCount()).toBe(1)
    await settle()
    const said = reviewText(dir, locate(GH_URL)!)
    if (!said.ok) throw new Error(said.error)
    writeFileSync(said.value.file, readFileSync(said.value.file, 'utf8').replace('Mine.', 'Edited by hand.'))
    await settle()
    expect(heard).toEqual([NEWS, NEWS, NEWS])
  })
})
