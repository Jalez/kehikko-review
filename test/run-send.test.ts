import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { TICKET, answer, type Deps } from '../doors.ts'
import { SERVICE_CALLER_HEADER, SERVICE_PASS_HEADER } from 'kehikot-module-protocol'
import { vouchCaller, type DoorRequest } from 'kehikot-module-protocol/serve'

import { locate } from '../forge/locate.ts'
import { forget } from '../forge/read.ts'
import type { Run } from '../forge/run.ts'
import { proposalBody } from '../review/draft.ts'
import type { Draft } from '../review/shape.ts'
import { SEND_PATH, sendHandler, sendRun, type Vouch } from '../send/door.ts'
import { readDraftFor } from '../store.ts'

import { GH_PULL, GH_URL, HEAD, PATCH, fake, githubReads, isPost, pathOf, sentBody } from './fake.ts'

/**
 * The send only a module's server that proves who it is can make (the `send` route of the
 * `review.drafts` service): a run's comments and its proposal, posted without the person —
 * and only when the change is two-way, touches nothing people see, has not moved on, and every
 * required point is matched by a request for changes. Every refusal is asserted with nothing
 * posted; the tracker here is a function that records what it would have been sent.
 */
const home = mkdtempSync(join(tmpdir(), 'kehikko-review-run-send-'))
afterAll(() => rmSync(home, { recursive: true, force: true }))
let n = 0
const project = () => mkdtempSync(join(home, `p${(n += 1)}-`))
const none = new URLSearchParams()
beforeEach(forget)

const MOVED = 'abcdef1234567890abcdef1234567890abcdef12'
const reviewOk = JSON.stringify({ id: 1, html_url: `${GH_URL}#pullrequestreview-1` })

const META = (run: string, over: Record<string, unknown> = {}) => ({
  run,
  severity: 'blocking',
  evidence: [{ kind: 'line', ref: 'src/one.ts:11' }],
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

/** A change whose head and state can move under the test, and a draft with the person's work and a run's. */
async function ready(options: { proposal?: Record<string, unknown> | null; points?: Record<string, unknown>[] } = {}) {
  const dir = project()
  const change = { head: HEAD, state: 'open', merged: false }
  const runner = fake((run: Run) => {
    if (isPost(run)) return reviewOk
    if (pathOf(run) === 'repos/o/r/pulls/46' && !run.args.includes('Accept: application/vnd.github.diff')) {
      return JSON.stringify({ ...JSON.parse(GH_PULL), head: { sha: change.head }, state: change.state, merged: change.merged })
    }
    if (pathOf(run) === 'repos/o/r/pulls/46' && change.head !== HEAD) return PATCH
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
  const base = { project: dir, change: GH_URL }

  /* The person's own comment, summary and verdict. */
  await post('/api/comment', { projectPath: dir, url: GH_URL, view: 'all', commit: HEAD, path: 'src/one.ts', side: 'new', line: 12, body: 'My comment.' })
  await post('/api/verdict', { projectPath: dir, url: GH_URL, verdict: 'comment', summary: 'My summary.' })
  /* The run's points. */
  for (const meta of options.points ?? [META('run-1'), META('run-1', { ruling: 'optional', severity: 'nice' })]) {
    await tool('add_comment', { ...base, path: 'src/one.ts', line: 11, body: `Point (${String(meta.ruling)}).`, meta })
  }
  if (options.proposal !== null) await tool('propose_review', { ...base, ...PROPOSE('run-1', options.proposal ?? {}) })

  const send = (body: Record<string, unknown> = { project: dir, change: GH_URL, run: 'run-1' }) => sendRun(deps, CALLER, body)
  const draft = (): Draft => {
    const got = readDraftFor(dir, locate(GH_URL)!)
    if (!got.ok) throw new Error(got.error)
    return got.value
  }
  const posts = () => runner.calls.filter(isPost)
  return { dir, change, runner, deps, tool, base, send, draft, posts }
}

const CALLER = 'kehikot.caller'
const errorOf = (reply: { body: unknown }) => (reply.body as { error?: string }).error ?? ''

describe('what a run may send', () => {
  test('the run’s comments and its proposal, and nothing of the person’s', async () => {
    const w = await ready()
    const before = w.draft()
    const reply = await w.send()
    expect(reply.status).toBe(200)
    expect(w.posts()).toHaveLength(1)
    const body = sentBody(w.posts()[0]!)
    expect(body).toMatchObject({ commit_id: HEAD, event: 'REQUEST_CHANGES', body: proposalBody(before.proposal!) })
    expect((body.comments as { body: string }[]).map((c) => c.body)).toEqual(['Point (required).', 'Point (optional).'])
    expect(JSON.stringify(body)).not.toContain('My comment.')
    expect(JSON.stringify(body)).not.toContain('My summary.')

    const after = w.draft()
    expect(after.comments.find((c) => c.body === 'My comment.')).toEqual(before.comments.find((c) => c.body === 'My comment.')!)
    expect(after.comments.filter((c) => c.by === 'agent').every((c) => c.sent)).toBe(true)
    expect(after.summary).toBe('My summary.')
    expect(after.verdict).toBe('comment')
    expect(after.proposal?.sent).toEqual({ at: '2026-10-21T12:00:00.000Z', head: HEAD })
    expect(after.sent.at(-1)).toMatchObject({ verdict: 'request-changes', head: HEAD, comments: 2, summary: proposalBody(before.proposal!) })
    expect(after.sent.at(-1)!.notes[0]).toContain(`Sent by ${CALLER} for review run run-1`)
  })

  test('a run with nothing required may approve', async () => {
    const w = await ready({ points: [META('run-1', { ruling: 'optional', severity: 'nice' })], proposal: { verdict: 'approve', pathToSuccess: [] } })
    const reply = await w.send()
    expect(reply.status).toBe(200)
    expect(sentBody(w.posts()[0]!)).toMatchObject({ event: 'APPROVE' })
  })

  test('sent once: a second send is refused and posts nothing', async () => {
    const w = await ready()
    expect((await w.send()).status).toBe(200)
    const again = await w.send()
    expect(again.status).toBe(409)
    expect(errorOf(again)).toContain('already been sent')
    expect(w.posts()).toHaveLength(1)
  })
})

describe('what a run may not send, with nothing posted', () => {
  test('a one-way change', async () => {
    const w = await ready({ proposal: { door: 'one-way' } })
    const reply = await w.send()
    expect(reply.status).toBe(409)
    expect(errorOf(reply)).toContain('one-way')
    expect(w.posts()).toEqual([])
    expect(w.draft().comments.some((c) => c.sent)).toBe(false)
  })

  test('a change to what people see', async () => {
    const w = await ready({ proposal: { uiux: true } })
    const reply = await w.send()
    expect(reply.status).toBe(409)
    expect(errorOf(reply)).toContain('what people see')
    expect(w.posts()).toEqual([])
  })

  test('a change whose head moved after the run read it', async () => {
    const w = await ready()
    w.change.head = MOVED
    const reply = await w.send()
    expect(reply.status).toBe(409)
    expect(errorOf(reply)).toContain('moved on')
    expect(w.posts()).toEqual([])
  })

  test('a proposal made at the new head does not carry comments read at the old one', async () => {
    const w = await ready({ proposal: null })
    w.change.head = MOVED
    await w.tool('propose_review', { ...w.base, ...PROPOSE('run-1') })
    expect(w.draft().proposal?.head).toBe(MOVED)
    const reply = await w.send()
    expect(reply.status).toBe(409)
    expect(errorOf(reply)).toContain('moved on')
    expect(w.posts()).toEqual([])
  })

  test('required points with any verdict but a request for changes', async () => {
    for (const verdict of ['approve', 'comment']) {
      const w = await ready({ proposal: { verdict, pathToSuccess: [] } })
      const reply = await w.send()
      expect(reply.status).toBe(409)
      expect(errorOf(reply)).toContain('required')
      expect(w.posts()).toEqual([])
    }
  })

  test('a change that is no longer open', async () => {
    const w = await ready()
    w.change.state = 'closed'
    w.change.merged = true
    const reply = await w.send()
    expect(reply.status).toBe(409)
    expect(errorOf(reply)).toContain('merged')
    expect(w.posts()).toEqual([])
  })

  test('no proposal, or another run’s', async () => {
    const w = await ready({ proposal: null })
    expect((await w.send()).status).toBe(409)
    await w.tool('propose_review', { ...w.base, ...PROPOSE('run-2') })
    const other = await w.send()
    expect(other.status).toBe(409)
    expect(errorOf(other)).toContain('run-1')
    expect(w.posts()).toEqual([])
  })

  test('a body that does not say which project, change and run', async () => {
    const w = await ready()
    for (const body of [{}, { project: w.dir, change: GH_URL }, { project: w.dir, change: GH_URL, run: '../x' }, { project: w.dir, change: 'gh#46', run: 'run-1' }, { project: 'relative', change: GH_URL, run: 'run-1' }]) {
      const reply = await w.send(body)
      expect(reply.status).toBe(400)
    }
    expect(w.posts()).toEqual([])
  })

  test('a second send while one is under way', async () => {
    const w = await ready()
    const [one, two] = await Promise.all([w.send(), w.send()])
    expect([one.status, two.status].sort()).toEqual([200, 409])
    expect(w.posts()).toHaveLength(1)
  })
})

describe('the route', () => {
  test('is not reachable through the page’s doors, ticket or not', async () => {
    const w = await ready()
    const calls = w.runner.calls.length
    for (const ticket of [TICKET, null]) {
      expect((await answer('POST', SEND_PATH, none, { project: w.dir, change: GH_URL, run: 'run-1' }, ticket, w.deps))?.status).toBe(404)
    }
    expect((await answer('GET', SEND_PATH, none, null, null, w.deps))?.status).toBe(404)
    expect(w.runner.calls.length).toBe(calls)
  })

  test('the MCP door never gains a send', async () => {
    const w = await ready()
    for (const name of ['send_run', 'send', 'send_review']) await expect(w.tool(name, { ...w.base, run: 'run-1' })).rejects.toThrow('no tool')
    expect(w.posts()).toEqual([])
  })
})

/** A node-style request and response, enough for the middleware. */
function request(method: string, headers: Record<string, string>, body?: unknown): DoorRequest & { method: string } {
  const listeners: Record<string, ((chunk?: Uint8Array) => void)[]> = {}
  const made = {
    method,
    url: `${SEND_PATH}?x=1`,
    headers,
    on(event: string, listener: (chunk?: Uint8Array) => void) {
      ;(listeners[event] ??= []).push(listener)
      if (event === 'end') {
        setTimeout(() => {
          if (body !== undefined) for (const one of listeners.data ?? []) one(new TextEncoder().encode(JSON.stringify(body)))
          for (const one of listeners.end ?? []) one()
        }, 0)
      }
      return this
    },
  }
  return made as unknown as DoorRequest & { method: string }
}

function response() {
  const out = { status: 0, headers: {} as Record<string, string>, body: '', done: Promise.withResolvers<void>() }
  return {
    out,
    res: {
      get statusCode() {
        return out.status
      },
      set statusCode(value: number) {
        out.status = value
      },
      setHeader(name: string, value: string) {
        out.headers[name.toLowerCase()] = value
      },
      write(chunk: string) {
        out.body += chunk
      },
      end(chunk?: string | Uint8Array) {
        out.body += typeof chunk === 'string' ? chunk : chunk ? new TextDecoder().decode(chunk) : ''
        out.done.resolve()
      },
    },
  }
}

const PASS = 'p'.repeat(40)
const PROVED = { [SERVICE_CALLER_HEADER]: CALLER, [SERVICE_PASS_HEADER]: PASS }

/** A vouch that says yes or no, and counts how often it was asked. */
function vouching(yes: boolean): Vouch & { asked: number } {
  const vouch = (async () => {
    vouch.asked += 1
    return yes ? { ok: true as const, module: CALLER } : { ok: false as const, why: `${CALLER} did not vouch for that pass.` }
  }) as unknown as Vouch & { asked: number }
  vouch.asked = 0
  return vouch
}

describe('the middleware', () => {
  test('another path is not this route’s: it goes on, unread, and nobody is asked to vouch', async () => {
    const w = await ready()
    const vouch = vouching(true)
    const { res, out } = response()
    const asked = { ...request('POST', { ...PROVED, 'content-type': 'application/json' }, { project: w.dir }), url: '/api/send' }
    const read: string[] = []
    const on = asked.on.bind(asked)
    ;(asked as unknown as { on: typeof on }).on = ((event: string, listener: () => void) => {
      read.push(event)
      return on(event as 'end', listener)
    }) as typeof on
    const went = Promise.withResolvers<void>()
    sendHandler(w.deps, vouch)(asked, res, () => went.resolve())
    await went.promise
    expect(out.status).toBe(0)
    /* Nothing listened for the body: the doors and Vite get it whole. */
    expect(read).toEqual([])
    expect(vouch.asked).toBe(0)
  })

  test('a browser asking — another origin or this app’s own page — is refused before anybody is asked to vouch', async () => {
    const w = await ready()
    const vouch = vouching(true)
    for (const headers of [{ origin: 'http://evil.example' }, { origin: 'http://127.0.0.1:8000', host: '127.0.0.1:8000' }, { 'sec-fetch-site': 'same-origin' }, { 'sec-fetch-site': 'cross-site' }] as Record<string, string>[]) {
      const { res, out } = response()
      sendHandler(w.deps, vouch)(request('POST', { ...headers, ...PROVED, 'content-type': 'application/json' }, { project: w.dir, change: GH_URL, run: 'run-1' }), res, () => {})
      await out.done.promise
      expect(out.status).toBe(403)
    }
    expect(vouch.asked).toBe(0)
    expect(w.posts()).toEqual([])
  })

  test('only POST', async () => {
    const w = await ready()
    const { res, out } = response()
    sendHandler(w.deps, vouching(true))(request('GET', PROVED), res, () => {})
    await out.done.promise
    expect(out.status).toBe(405)
  })

  test('a sender that does not prove which module it is is refused, and nothing is posted', async () => {
    const w = await ready()
    const { res, out } = response()
    sendHandler(w.deps, vouching(false))(request('POST', { ...PROVED, 'content-type': 'application/json' }, { project: w.dir, change: GH_URL, run: 'run-1' }), res, () => {})
    await out.done.promise
    expect(out.status).toBe(403)
    expect(JSON.parse(out.body).error).toContain('did not prove which module it is')
    expect(w.posts()).toEqual([])
    expect(w.draft().proposal?.sent).toBeUndefined()
  })

  test('a module’s server that proves who it is sends', async () => {
    const w = await ready()
    const { res, out } = response()
    sendHandler(w.deps, vouching(true))(request('POST', { ...PROVED, 'content-type': 'application/json' }, { project: w.dir, change: GH_URL, run: 'run-1' }), res, () => {})
    await out.done.promise
    expect(out.status).toBe(200)
    expect(out.headers['content-type']).toContain('application/json')
    expect(out.headers['cache-control']).toBe('no-store')
    expect(JSON.parse(out.body)).toMatchObject({ ok: true, report: { complete: true } })
    expect(w.posts()).toHaveLength(1)
    expect(w.draft().sent.at(-1)!.notes[0]).toContain(`Sent by ${CALLER}`)
  })

  test('a body that is not JSON is refused', async () => {
    const w = await ready()
    const { res, out } = response()
    sendHandler(w.deps, vouching(true))(request('POST', { ...PROVED, 'content-type': 'text/plain' }, 'x'), res, () => {})
    await out.done.promise
    expect(out.status).toBe(415)
    expect(w.posts()).toEqual([])
  })
})

describe('the protocol’s vouch, with a registry and a caller that answer here', () => {
  /** A registry naming the caller at an address, and the caller's answer about the pass. */
  function world(minted: boolean) {
    const registry = join(home, `registry${(n += 1)}`)
    mkdirSync(registry, { recursive: true })
    writeFileSync(join(registry, `${CALLER}.json`), JSON.stringify({ url: 'http://127.0.0.1:47999/app', dir: '' }))
    const asked: string[] = []
    const fetch = (async (url: string | URL | Request) => {
      asked.push(String(url))
      return Response.json({ ok: true, minted })
    }) as unknown as typeof globalThis.fetch
    const vouch: Vouch = (headers) => vouchCaller(headers, { registry, fetch })
    return { vouch, asked }
  }

  test('a pass the caller minted sends, asked of the caller at its registered address', async () => {
    const w = await ready()
    const v = world(true)
    const { res, out } = response()
    sendHandler(w.deps, v.vouch)(request('POST', { ...PROVED, 'content-type': 'application/json' }, { project: w.dir, change: GH_URL, run: 'run-1' }), res, () => {})
    await out.done.promise
    expect(out.status).toBe(200)
    expect(v.asked).toHaveLength(1)
    expect(v.asked[0]).toStartWith('http://127.0.0.1:47999/api/kehikot/server-pass?pass=')
    expect(w.posts()).toHaveLength(1)
  })

  test('a pass it did not mint, no pass, or a module not registered: refused, nothing posted', async () => {
    const w = await ready()
    for (const [headers, minted] of [
      [PROVED, false],
      [{ [SERVICE_CALLER_HEADER]: CALLER }, true],
      [{ [SERVICE_CALLER_HEADER]: 'kehikot.stranger', [SERVICE_PASS_HEADER]: PASS }, true],
      [{}, true],
    ] as [Record<string, string>, boolean][]) {
      const { res, out } = response()
      sendHandler(w.deps, world(minted).vouch)(request('POST', { ...headers, 'content-type': 'application/json' }, { project: w.dir, change: GH_URL, run: 'run-1' }), res, () => {})
      await out.done.promise
      expect(out.status).toBe(403)
    }
    expect(w.posts()).toEqual([])
  })
})
