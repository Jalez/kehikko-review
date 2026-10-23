import {
  DOOR_PROJECT_SAYS,
  beforeDoors,
  beforeHandler,
  readJsonRequest,
  resolveDoorProject,
  type Before,
  type DoorHandler,
  type Reply,
} from 'kehikot-module-protocol/serve'

import { REAL, bad, changeFor, deliver, underLock, type Deps } from '../doors.ts'
import type { Target } from '../forge/locate.ts'
import { ofRun, proposalBody, runOf, RUN_SAYS } from '../review/draft.ts'
import type { Facts } from '../review/send.ts'
import { short, type Draft } from '../review/shape.ts'
import { readDraftFor } from '../store.ts'

import { KEY_HEADER, ensureKey, keyFile, loadKey, sameKey } from './key.ts'

/**
 * The one send that is not the person's: Factory posting a review run's comments and proposal
 * (contract C4), for a change the person said may be reviewed without them.
 *
 * ## Who can reach it
 *
 * - Only a request carrying `X-Kehikot-Factory-Key`. Without the header this is not a route: the
 *   middleware hands the request on, unread, and the page's doors answer it 404 like any path they
 *   do not have (`answer` in doors.ts refuses every `/api/factory/*`, ticket or not).
 * - Only a program. A browser — another origin, or this app's own page — is refused before the
 *   key is looked at. Factory's server asks with no `Origin` and no `Sec-Fetch-Site`.
 * - Only with the key, compared in constant time (`sameKey`). No key file: 503, nothing read.
 * - Never over MCP. There is no tool for it, and no agent is handed the key.
 *
 * ## What it refuses (409, a sentence, nothing posted)
 *
 * A change that is one-way, one that touches what people see, one whose head moved after the run
 * read it (any of its comments or its proposal), one that is not open; a run that proposed nothing,
 * or whose proposal was already sent; required points under any verdict but a request for changes.
 *
 * ## What it sends
 *
 * Exactly that run's unsent comments and its proposal's summary (with "To get this approved:") and
 * verdict. Never the person's comments, summary or verdict: those stay in the draft as they were.
 */

export const FACTORY_PATH = '/api/factory/send'

/** Whether a run's review may go out without the person, before the forge is asked: a sentence when it may not. */
export function refusalFor(draft: Draft, run: string): string | null {
  const proposal = draft.proposal
  if (!proposal || proposal.run !== run) {
    return proposal
      ? `Run ${run} has no proposal on this change; the proposal there is run ${proposal.run}’s.`
      : `Run ${run} has proposed no review for this change (propose_review first).`
  }
  if (proposal.sent) return `Run ${run}’s review has already been sent, at ${proposal.sent.at}.`
  if (proposal.door === 'one-way') return 'This change is one-way — hard or impossible to undo — so it waits for the person to read and send it.'
  if (proposal.uiux) return 'This change touches what people see, so it waits for the person: before and after pictures are theirs to judge.'
  const points = draft.comments.filter((c) => ofRun(c, run))
  if (points.some((c) => c.meta?.ruling === 'required') && proposal.verdict !== 'request-changes') {
    return `Run ${run} has required points, so its verdict has to be a request for changes; it is “${proposal.verdict}”.`
  }
  return null
}

/** Whether the change is still what the run read, now that the forge has said what it is. */
export function movedFor(draft: Draft, run: string, facts: Facts): string | null {
  if (facts.state && facts.state !== 'open') return `The change is ${facts.state} now, so there is nothing to review.`
  const proposal = draft.proposal!
  const read = [proposal.head, ...draft.comments.filter((c) => ofRun(c, run)).map((c) => c.meta?.head ?? '')]
  const stale = read.find((head) => head !== facts.head)
  if (stale !== undefined) {
    return `The change moved on: its head is ${short(facts.head)} and run ${run} read ${stale ? short(stale) : 'an unknown head'}. Re-run to review the new commits.`
  }
  return null
}

/**
 * Factory's send, given the key it presented. Every refusal is a reply with a sentence and
 * nothing posted. `file` is where the key is read from (the machine's, unless a test says).
 */
export async function factorySend(deps: Deps, carried: string | null, body: Record<string, unknown> | null, file: string = keyFile()): Promise<Reply> {
  const key = loadKey(file)
  if (!key.ok) return bad(`This Review has no Factory key to compare with: ${key.error}`, 503)
  if (!sameKey(carried, key.key)) return bad('That is not this Review’s Factory key.', 403)
  if (!body) return bad('Send { project, change, run } as JSON.')

  const named = typeof body.project === 'string' && body.project.length <= 4096 ? body.project : ''
  if (!named.trim()) return bad('Name the project: its absolute folder.')
  const run = runOf(body.run)
  if (!run) return bad(RUN_SAYS)
  const at = await resolveDoorProject(named)
  if (!at.ok) return bad(at.why)
  let target: Target
  try {
    target = changeFor(at.path, body.change)
  } catch (e) {
    return bad(e instanceof Error ? e.message : String(e))
  }

  const reply = await underLock(at.path, target, async () => {
    const read = readDraftFor(at.path, target)
    if (!read.ok) return bad(read.error)
    const draft = read.value
    const refused = refusalFor(draft, run)
    if (refused) return bad(`Nothing was sent. ${refused}`, 409)
    const proposal = draft.proposal!
    const ids = draft.comments.filter((c) => ofRun(c, run)).map((c) => c.id)
    return deliver(deps, at.path, target, draft, {
      ids,
      verdict: proposal.verdict,
      summary: proposalBody(proposal),
      by: { kind: 'run', run },
      check: (facts) => movedFor(draft, run, facts),
    })
  })
  /* Factory is told what happened, not handed the person's draft. */
  if (reply.status !== 200) return reply
  const said = reply.body as { report: unknown }
  return { status: 200, body: { ok: true, report: said.report, ...(at.movedFrom ? { said: DOOR_PROJECT_SAYS.followed(at.movedFrom, at.path) } : {}) } }
}

/** A reply as the JSON answer it is: never cached, like every door's. */
function json(answer: Reply): Response {
  return new Response(JSON.stringify(answer.body), {
    status: answer.status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

/**
 * Factory's door as ONE function from a request to an answer, asked before the protocol's doors on
 * both servers: on Vite by `factoryDoor()` below, and on the built page by `run({ before })` in
 * serve.ts — so the two cannot disagree about who may send. `undefined` is "not this route": the
 * request goes on to the doors unread, which answer it 404. `file` says where the key is, read per
 * request so a key replaced on disk is the one compared.
 */
export function factoryBefore(deps: Deps = REAL, file: () => string = () => keyFile()): Before {
  return async (request, { asker, url }) => {
    const carried = request.headers.get(KEY_HEADER) || null
    if (url.pathname !== FACTORY_PATH || !carried) return undefined
    if (asker !== 'program') return json(bad('This door answers Factory, a program on this computer, and nothing in a browser.', 403))
    if (request.method.toUpperCase() !== 'POST') return json(bad('This door takes POST.', 405))
    const read = await readJsonRequest(request)
    return json(read.ok ? await factorySend(deps, carried, read.body, file()) : bad(read.error, read.status))
  }
}

/** The same door as node middleware, `(request, response, next)`: what Vite mounts. */
export function factoryHandler(deps: Deps = REAL, file: () => string = () => keyFile()): DoorHandler {
  return beforeHandler(factoryBefore(deps, file))
}

/** Make the key on the first start, on either server; a start without one says so and goes on. */
export function startFactory(): void {
  const made = ensureKey()
  if (!made.ok) console.error(`kehikot.review: Factory cannot send reviews: ${made.error}`)
}

/** The Vite plugin: makes the key on the first start, then answers Factory's send. Before `doors()` in vite.config.ts. */
export function factoryDoor(deps: Deps = REAL) {
  return beforeDoors(factoryBefore(deps), { name: 'kehikot-review-factory-door', setup: startFactory })
}
