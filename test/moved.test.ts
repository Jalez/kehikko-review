import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { KEHIKOT_DIR } from 'kehikot-module-protocol'
import { held } from 'kehikot-module-protocol/client'
import { DOOR_PROJECT_SAYS } from 'kehikot-module-protocol/serve'

import { TICKET, answer, type Deps } from '../doors.ts'
import { forget } from '../forge/read.ts'
import { heldAtProject } from '../src/wire/held-at-project.ts'
import { fake, githubReads, GH_URL } from './fake.ts'
import { host } from './host.ts'

/**
 * A project is its id, not its folder. The door asks the host which folder it means and works on
 * that one: a former path is followed, a stranger's folder at the old path is not written to, and
 * with no host nothing is written.
 */
const ID = 'proj-review-one'
const none = new URLSearchParams()
let dir = ''
let OLD = ''
let NEW = ''

const deps = (): Deps => ({ run: fake((run) => githubReads(run)).run, now: () => '2026-10-07T12:00:00.000Z', id: () => 'c-1' })

beforeEach(() => {
  host.reset()
  forget()
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'review-moved-')))
  OLD = join(dir, 'before')
  NEW = join(dir, 'after')
})
afterEach(() => {
  host.reset()
  rmSync(dir, { recursive: true, force: true })
})

function renamed(): void {
  mkdirSync(OLD)
  renameSync(OLD, NEW)
  host.auto = false
  host.projects.set(NEW, ID)
  host.moved.set(OLD, { to: NEW, id: ID })
}

const verdict = (project: string) => answer('POST', '/api/verdict', none, { projectPath: project, url: GH_URL, verdict: 'approve' }, TICKET, deps())
const tool = async (args: Record<string, unknown>) => {
  const reply = await answer('POST', '/mcp', none, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_reviews', arguments: args } }, null, deps())
  const result = (reply?.body as { result: { content: { text: string }[]; isError?: boolean } }).result
  return { text: result.content[0]?.text ?? '', isError: result.isError === true }
}

describe('a project whose folder moved', () => {
  test('a write from the page with the former path is followed, and lands in the new folder', async () => {
    renamed()
    const reply = await verdict(OLD)
    expect(reply?.status).toBe(200)
    expect((reply?.body as { said?: string }).said).toBe(DOOR_PROJECT_SAYS.followed(OLD, NEW))
    expect(existsSync(join(NEW, KEHIKOT_DIR, 'review'))).toBe(true)
    expect(existsSync(OLD)).toBe(false)
  })

  test('a read from the page, and a tool call, with the former path are followed too', async () => {
    renamed()
    await verdict(NEW)
    const read = await answer('GET', '/api/draft', new URLSearchParams({ projectPath: OLD, url: GH_URL }), null, null, deps())
    expect((read?.body as { said?: string }).said).toBe(DOOR_PROJECT_SAYS.followed(OLD, NEW))
    const listed = await tool({ project: OLD })
    expect(listed.isError).toBe(false)
    expect(listed.text).toContain(DOOR_PROJECT_SAYS.followed(OLD, NEW))
  })

  test('an unrelated folder made at the old path is refused, and nothing is written there', async () => {
    renamed()
    mkdirSync(OLD)
    host.moved.set(OLD, { to: NEW, id: 'proj-someone-else' })
    const reply = await verdict(OLD)
    expect(reply?.status).toBe(400)
    expect((reply?.body as { error: string }).error).toBe(DOOR_PROJECT_SAYS.moved(NEW))
    expect(existsSync(join(OLD, KEHIKOT_DIR))).toBe(false)
    expect(existsSync(join(NEW, KEHIKOT_DIR))).toBe(false)
    expect((await tool({ project: OLD })).text).toBe(DOOR_PROJECT_SAYS.moved(NEW))
  })

  test('a folder the host does not hold is refused, though it exists', async () => {
    mkdirSync(OLD)
    host.auto = false
    const reply = await verdict(OLD)
    expect((reply?.body as { error: string }).error).toBe(DOOR_PROJECT_SAYS.notProject(OLD))
    expect(existsSync(join(OLD, KEHIKOT_DIR))).toBe(false)
  })

  test('with no host running a door refuses, and writes nothing', async () => {
    mkdirSync(OLD)
    host.up = false
    const reply = await verdict(OLD)
    expect(reply?.status).toBe(400)
    expect((reply?.body as { error: string }).error).toBe(DOOR_PROJECT_SAYS.notProject(OLD))
    expect((await tool({ project: OLD })).isError).toBe(true)
    expect(existsSync(join(OLD, KEHIKOT_DIR))).toBe(false)
  })
})

describe('drafts across a rename', () => {
  const drafts = held('test.review.drafts')
  const draft = { base: '', text: 'half a comment', aim: 'a new comment' }
  beforeEach(() => sessionStorage.clear())

  test('a draft kept under the id is still there when the path changes', () => {
    heldAtProject(drafts, { projectId: ID, projectPath: OLD })?.keep('t', draft)
    expect(heldAtProject(drafts, { projectId: ID, projectPath: NEW })?.read('t')).toEqual(draft)
  })

  test('a draft an earlier page kept under the path is moved under the id, once', () => {
    drafts.at(OLD).keep('t', draft)
    expect(heldAtProject(drafts, { projectId: ID, projectPath: OLD })?.read('t')).toEqual(draft)
    expect(drafts.at(OLD).any()).toBe(false)
    expect(heldAtProject(drafts, { projectId: ID, projectPath: NEW })?.read('t')).toEqual(draft)
  })

  test('without an id the path is the key, and with neither nothing is held', () => {
    heldAtProject(drafts, { projectId: null, projectPath: OLD })?.keep('t', draft)
    expect(drafts.at(OLD).read('t')).toEqual(draft)
    expect(heldAtProject(drafts, { projectId: null, projectPath: null })).toBeUndefined()
  })
})
