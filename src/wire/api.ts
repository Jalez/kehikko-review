import type { SharedLocation } from 'kehikot-module-protocol'
import { answered, ask } from 'kehikot-module-protocol/client'

import type { Target } from '../../forge/locate.ts'
import type { Commit, Described } from '../../forge/read.ts'
import type { Report } from '../../review/send.ts'
import type { Shots } from '../../review/shots.ts'
import type { Draft, Side, Verdict, View } from '../../review/shape.ts'

/**
 * This module's own `/api`, as the page calls it. Relative paths, because the
 * page and the server are one origin. A write carries the ticket printed into
 * the page; see `TICKET` in doors.ts.
 *
 * An interface with one real implementation, so the screen can be rendered in a
 * test against a plain object: no server, no tracker, and above all no way for
 * a test of the Send button to reach anything that sends.
 *
 * The types are imported from the server's own files (`import type`, so none of
 * its code comes along). What the door answers and what the page expects are
 * then one declaration, and cannot drift into two.
 */

/** What `/api/change` answers: what the change is right now, and its commits oldest first. */
export interface ChangeRead extends Described {
  target: Target
  /** How a person writes it: `owner/repo#46`. */
  ref: string
  commits: Commit[]
  /** True when the tracker's page of commits was full, so there may be more than are listed. */
  more: boolean
}

export interface CommentInput {
  view: View
  commit: string
  path: string
  side: Side
  line: number
  startLine?: number
  body: string
}

/** Exactly what the person was shown in the confirmation. The server sends this or nothing. */
export interface Confirmed {
  ids: string[]
  verdict: Verdict
  summary: string
}

export interface Api {
  change(url: string): Promise<ChangeRead>
  draft(projectPath: string, url: string): Promise<Draft>
  /** Whose login a send would go out under, or null when the CLI would not say. */
  login(url: string): Promise<string | null>
  addComment(projectPath: string, url: string, input: CommentInput): Promise<Draft>
  reword(projectPath: string, url: string, id: string, body: string): Promise<Draft>
  drop(projectPath: string, url: string, id: string): Promise<Draft>
  /** `undefined` leaves a field as it is; `null` clears the verdict. */
  setVerdict(projectPath: string, url: string, verdict: Verdict | null | undefined, summary: string | undefined): Promise<Draft>
  send(projectPath: string, url: string, confirmed: Confirmed): Promise<{ draft: Draft; report: Report }>
  /** The person takes a review run's proposed summary or verdict into their own. `run` is the proposal they were shown. */
  takeProposal(projectPath: string, url: string, which: 'summary' | 'verdict', run: string): Promise<Draft>
  /** The change's before/after pictures, already judged safe to show by the server (`review/shots.ts`). */
  shots(url: string): Promise<{ shots: Shots; unread?: string }>
  /** The person keeps an agent's point: it is theirs from now on, and their send may post it. */
  keep(projectPath: string, url: string, id: string): Promise<Draft>
  /** The person marks a sent point resolved, or opens it again. */
  resolve(projectPath: string, url: string, id: string, resolved: boolean): Promise<Draft>
  dropEvidence(projectPath: string, url: string, id: string): Promise<Draft>
  /** Where a piece of evidence's file is served: a picture's `src`, or the text to fetch. */
  evidenceUrl(projectPath: string, url: string, id: string): string
  /** A log's or test output's text. */
  evidenceText(projectPath: string, url: string, id: string): Promise<string>
  /** Tell this app's server what the page has open and where somebody points, for an agent's `read_focus`. */
  focus(projectPath: string, url: string, ref: string, title: string, location: SharedLocation | null): Promise<void>
  rewordReply(projectPath: string, url: string, id: string, body: string, todo: string): Promise<Draft>
  dropReply(projectPath: string, url: string, id: string): Promise<Draft>
  /** Post one reply, with the words the person was shown. */
  sendReply(projectPath: string, url: string, id: string, body: string): Promise<Draft>
}

type Body = { ok?: boolean; error?: string } & Record<string, unknown>

/*
 * Both through the protocol's `ask`: it carries the page's ticket on a write (`x-module-ticket`),
 * and turns every failure into a sentence — the server's own `error` when it said no (a 2xx whose
 * body says `ok: false` included), "not answering" when nothing did, "older than its server" when
 * the ticket was refused. `answered` throws that sentence, which is what every caller here shows.
 * It also records how the server is standing, which the cover in `app.tsx` is drawn from.
 */
const get = async (path: string, query: Record<string, string>): Promise<Body> => answered(await ask<Body>(`./api/${path}`, { query })) ?? {}

const post = async (path: string, body: Record<string, unknown>): Promise<Body> => answered(await ask<Body>(`./api/${path}`, { body })) ?? {}

export const api: Api = {
  change: async (url) => (await get('change', { url })) as unknown as ChangeRead,
  draft: async (projectPath, url) => (await get('draft', { projectPath, url })).draft as Draft,
  login: async (url) => ((await get('login', { url })).login as string | null) ?? null,
  addComment: async (projectPath, url, input) => (await post('comment', { projectPath, url, ...input })).draft as Draft,
  reword: async (projectPath, url, id, body) => (await post('comment/reword', { projectPath, url, id, body })).draft as Draft,
  drop: async (projectPath, url, id) => (await post('comment/drop', { projectPath, url, id })).draft as Draft,
  setVerdict: async (projectPath, url, verdict, summary) => (await post('verdict', { projectPath, url, verdict, summary })).draft as Draft,
  takeProposal: async (projectPath, url, which, run) => (await post('proposal/take', { projectPath, url, which, run })).draft as Draft,
  shots: async (url) => {
    const body = await get('shots', { url })
    return { shots: body.shots as Shots, ...(typeof body.unread === 'string' ? { unread: body.unread } : {}) }
  },
  keep: async (projectPath, url, id) => (await post('comment/keep', { projectPath, url, id })).draft as Draft,
  resolve: async (projectPath, url, id, resolved) => (await post('comment/resolve', { projectPath, url, id, resolved })).draft as Draft,
  dropEvidence: async (projectPath, url, id) => (await post('evidence/drop', { projectPath, url, id })).draft as Draft,
  evidenceUrl: (projectPath, url, id) => `./api/evidence?${new URLSearchParams({ projectPath, url, id }).toString()}`,
  evidenceText: async (projectPath, url, id) => {
    const response = await fetch(api.evidenceUrl(projectPath, url, id))
    if (!response.ok) throw new Error(`The file could not be read (${response.status}).`)
    return response.text()
  },
  focus: async (projectPath, url, ref, title, location) => {
    await post('focus', { projectPath, url, ref, title, location })
  },
  rewordReply: async (projectPath, url, id, body, todo) => (await post('reply/reword', { projectPath, url, id, body, todo })).draft as Draft,
  dropReply: async (projectPath, url, id) => (await post('reply/drop', { projectPath, url, id })).draft as Draft,
  sendReply: async (projectPath, url, id, body) => (await post('reply/send', { projectPath, url, id, body })).draft as Draft,
  send: async (projectPath, url, confirmed) => {
    const body = await post('send', { projectPath, url, ...confirmed })
    return { draft: body.draft as Draft, report: body.report as Report }
  },
}
