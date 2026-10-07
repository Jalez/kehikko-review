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
const TICKET_HEADER = 'x-module-ticket'

function ticket(): string {
  const text = document.getElementById('ticket')?.textContent ?? '""'
  try {
    return String(JSON.parse(text))
  } catch {
    return ''
  }
}

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

async function json(response: Response): Promise<Body> {
  const body = (await response.json().catch(() => ({}))) as Body
  /* The server's sentence, verbatim: it is the tracker's own words where the
     tracker said any, and that is what the page is for. */
  if (!response.ok || body.ok === false) throw new Error(body.error ?? `this app’s server answered ${response.status}`)
  return body
}

const get = async (path: string, query: Record<string, string>): Promise<Body> => json(await fetch(`./api/${path}?${new URLSearchParams(query)}`))

const post = async (path: string, body: Record<string, unknown>): Promise<Body> =>
  json(
    await fetch(`./api/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [TICKET_HEADER]: ticket() },
      body: JSON.stringify(body),
    }),
  )

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
