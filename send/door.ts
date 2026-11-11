import {
  DOOR_PROJECT_SAYS,
  beforeDoors,
  beforeHandler,
  readJsonRequest,
  resolveDoorProject,
  vouchCaller,
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

import { SEND_PATH } from './path.ts'

export { SEND_PATH }

/**
 * The one send that is not the person's: another module posting a review run's comments and
 * proposal, for a change the person said may be reviewed without them. It is the `send` route of
 * the `review.drafts` service this module provides (manifest.ts); whoever consumes the service
 * finds it there, and Review never knows which module that is.
 *
 * ## Who can reach it
 *
 * - Only a module's SERVER that proves who it is: the request names the module and carries a pass
 *   it minted, and `vouchCaller` asks that module, at the address it registered on this computer,
 *   whether it did. No secret is kept on disk; an agent, a page or any other program cannot pass.
 * - Only a program. A browser — another origin, or this app's own page — is refused before the
 *   caller is asked about. A module's server asks with no `Origin` and no `Sec-Fetch-Site`.
 * - Never through the page's doors: `answer` in doors.ts answers this path 404, ticket or not.
 * - Never over MCP. There is no tool for it.
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
 * A run's send, from `caller`: the module whose server was proved to have asked (`vouchCaller`).
 * Every refusal is a reply with a sentence and nothing posted.
 */
export async function sendRun(deps: Deps, caller: string, body: Record<string, unknown> | null): Promise<Reply> {
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
      by: { kind: 'run', run, caller },
      check: (facts) => movedFor(draft, run, facts),
    })
  })
  /* The caller is told what happened, not handed the person's draft. */
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

/** Proves which module's server sent a request; `vouchCaller` unless a test says. */
export type Vouch = (headers: Headers) => Promise<{ ok: true; module: string } | { ok: false; why: string }>

const VOUCH: Vouch = (headers) => vouchCaller(headers)

/**
 * The send as ONE function from a request to an answer, asked before the protocol's doors on both
 * servers: on Vite by `sendDoor()` below, and on the built page by `run({ before })` in serve.ts —
 * so the two cannot disagree about who may send. `undefined` is "not this route": the request goes
 * on to the doors unread.
 */
export function sendBefore(deps: Deps = REAL, vouch: Vouch = VOUCH): Before {
  return async (request, { asker, url }) => {
    if (url.pathname !== SEND_PATH) return undefined
    if (asker !== 'program') return json(bad('This route answers another module’s server on this computer, and nothing in a browser.', 403))
    if (request.method.toUpperCase() !== 'POST') return json(bad('This route takes POST.', 405))
    const vouched = await vouch(request.headers)
    if (!vouched.ok) return json(bad(`Nothing was sent: the sender did not prove which module it is. ${vouched.why}`, 403))
    const read = await readJsonRequest(request)
    return json(read.ok ? await sendRun(deps, vouched.module, read.body) : bad(read.error, read.status))
  }
}

/** The same route as node middleware, `(request, response, next)`: what Vite mounts. */
export function sendHandler(deps: Deps = REAL, vouch: Vouch = VOUCH): DoorHandler {
  return beforeHandler(sendBefore(deps, vouch))
}

/** The Vite plugin: answers the send. Before `doors()` in vite.config.ts. */
export function sendDoor(deps: Deps = REAL) {
  return beforeDoors(sendBefore(deps), { name: 'kehikot-review-send-door' })
}
