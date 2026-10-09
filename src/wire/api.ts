import { answered, ask } from 'kehikot-module-protocol/client'

import type { Target } from '../../forge/locate.ts'
import type { Commit, Described, Patch } from '../../forge/read.ts'
import type { Report } from '../../review/send.ts'
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
  diff(url: string, view: View, sha: string): Promise<Patch>
  draft(projectPath: string, url: string): Promise<Draft>
  /** Whose login a send would go out under, or null when the CLI would not say. */
  login(url: string): Promise<string | null>
  addComment(projectPath: string, url: string, input: CommentInput): Promise<Draft>
  reword(projectPath: string, url: string, id: string, body: string): Promise<Draft>
  drop(projectPath: string, url: string, id: string): Promise<Draft>
  /** `undefined` leaves a field as it is; `null` clears the verdict. */
  setVerdict(projectPath: string, url: string, verdict: Verdict | null | undefined, summary: string | undefined): Promise<Draft>
  send(projectPath: string, url: string, confirmed: Confirmed): Promise<{ draft: Draft; report: Report }>
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

/** Ask this app's own server whether it is there, for the cover's Try again. The answer is the standing `ask` records. */
export const knock = async (): Promise<void> => void (await ask('./healthz'))

export const api: Api = {
  change: async (url) => (await get('change', { url })) as unknown as ChangeRead,
  diff: async (url, view, sha) => (await get('diff', { url, view, sha })) as unknown as Patch,
  draft: async (projectPath, url) => (await get('draft', { projectPath, url })).draft as Draft,
  login: async (url) => ((await get('login', { url })).login as string | null) ?? null,
  addComment: async (projectPath, url, input) => (await post('comment', { projectPath, url, ...input })).draft as Draft,
  reword: async (projectPath, url, id, body) => (await post('comment/reword', { projectPath, url, id, body })).draft as Draft,
  drop: async (projectPath, url, id) => (await post('comment/drop', { projectPath, url, id })).draft as Draft,
  setVerdict: async (projectPath, url, verdict, summary) => (await post('verdict', { projectPath, url, verdict, summary })).draft as Draft,
  send: async (projectPath, url, confirmed) => {
    const body = await post('send', { projectPath, url, ...confirmed })
    return { draft: body.draft as Draft, report: body.report as Report }
  },
}
