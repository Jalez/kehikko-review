import { MAX_BODY, MAX_SAID, THREAD } from '../review/shape.ts'
import { post } from '../review/send.ts'

import type { Target } from './locate.ts'
import { ghApi, glabApi, notesCommand, reviewsCommand, type Read } from './read.ts'
import type { Ran, Run, Runner } from './run.ts'

/**
 * The review comments a change has RECEIVED, as threads, and the one way to answer one.
 *
 * For `/review-reply`: the person authored the change, people reviewed it, and an agent drafts a
 * reply per thread for the person to read, edit and post. Reading is ungated like every other read
 * here; posting a reply is the page's alone (`/api/reply/send`, with its ticket), one reply at a
 * time, after the person was shown it.
 *
 * - GitHub: each review comment's thread (`pulls/{n}/comments`, grouped under the comment that
 *   started it) is answered under it (`…/comments/{id}/replies`); the review summaries and the
 *   conversation are one thread, `gh-conversation`, answered with a comment there.
 * - GitLab: each discussion (`merge_requests/{n}/discussions`) is a thread, answered in it.
 */

export interface ThreadNote {
  author: string
  body: string
  at: string
}

export interface Thread {
  /** What `draft_reply` and the send name it by (`THREAD`). */
  id: string
  /** `path:line`, or `the conversation`. */
  where: string
  notes: ThreadNote[]
  /** GitLab says whether a discussion is resolved; GitHub's REST answer does not. */
  resolved?: boolean
}

export const MAX_THREADS = 100
const PAGE = 100
const JSON_BYTES = 4_000_000
const MAX_PERSON = 100

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
const text = (value: unknown, max: number): string => (typeof value === 'string' ? value.slice(0, max) : '')
const parse = (answer: string): unknown => {
  try {
    return JSON.parse(answer)
  } catch {
    return null
  }
}
const failed = (ran: Extract<Ran, { ok: false }>): { ok: false; error: string } => ({ ok: false, error: ran.error })
const NOT_JSON = 'The tracker’s command line answered with something that is not JSON.'
const project = (target: Target): string => `projects/${encodeURIComponent(target.repo)}`

export function inlineThreadsCommand(target: Target): Run {
  return target.forge === 'github'
    ? ghApi(`repos/${target.repo}/pulls/${target.number}/comments?per_page=${PAGE}`)
    : glabApi(target, `${project(target)}/merge_requests/${target.number}/discussions?per_page=${PAGE}`)
}

/** GitHub's review comments, grouped into threads under the comment that started each. */
export function readGithubInline(answer: string): Read<Thread[]> {
  const body = parse(answer)
  if (!Array.isArray(body)) return { ok: false, error: NOT_JSON }
  const threads = new Map<string, Thread>()
  for (const raw of body.slice(0, PAGE)) {
    const one = record(raw)
    if (!one || typeof one.id !== 'number' || typeof one.body !== 'string') continue
    const root = typeof one.in_reply_to_id === 'number' ? one.in_reply_to_id : one.id
    const id = `gh-comment:${root}`
    if (!THREAD.test(id)) continue
    const line = typeof one.line === 'number' ? one.line : typeof one.original_line === 'number' ? one.original_line : null
    const thread = threads.get(id) ?? { id, where: `${text(one.path, 1000)}${line ? `:${line}` : ''}`, notes: [] }
    thread.notes.push({ author: text(record(one.user)?.login, MAX_PERSON), body: text(one.body, MAX_SAID), at: text(one.created_at, 40) })
    threads.set(id, thread)
  }
  return { ok: true, value: [...threads.values()].slice(0, MAX_THREADS) }
}

/** GitHub's review summaries and conversation comments, as one thread, oldest first. */
export function readGithubConversation(reviews: string, comments: string): Read<Thread | null> {
  const a = parse(reviews)
  const b = parse(comments)
  if (!Array.isArray(a) || !Array.isArray(b)) return { ok: false, error: NOT_JSON }
  const notes: ThreadNote[] = []
  for (const raw of [...a, ...b].slice(0, PAGE * 2)) {
    const one = record(raw)
    if (!one || typeof one.body !== 'string' || !one.body.trim()) continue
    notes.push({ author: text(record(one.user)?.login, MAX_PERSON), body: text(one.body, MAX_SAID), at: text(one.submitted_at ?? one.created_at, 40) })
  }
  notes.sort((x, y) => (x.at < y.at ? -1 : x.at > y.at ? 1 : 0))
  return { ok: true, value: notes.length ? { id: 'gh-conversation', where: 'the conversation', notes } : null }
}

/** GitLab's discussions, without the system notes ("added 1 commit"). */
export function readGitlabDiscussions(answer: string): Read<Thread[]> {
  const body = parse(answer)
  if (!Array.isArray(body)) return { ok: false, error: NOT_JSON }
  const threads: Thread[] = []
  for (const raw of body.slice(0, PAGE)) {
    const one = record(raw)
    const id = `gl-discussion:${text(one?.id, 64)}`
    if (!one || !THREAD.test(id) || !Array.isArray(one.notes)) continue
    const notes = one.notes.map(record).filter((n): n is Record<string, unknown> => n !== null && n.system !== true && typeof n.body === 'string')
    if (!notes.length) continue
    const position = record(notes[0]!.position)
    const path = text(position?.new_path ?? position?.old_path, 1000)
    const line = typeof position?.new_line === 'number' ? position.new_line : typeof position?.old_line === 'number' ? position.old_line : null
    const resolvable = notes.some((n) => n.resolvable === true)
    threads.push({
      id,
      where: path ? `${path}${line ? `:${line}` : ''}` : 'the conversation',
      notes: notes.map((n) => ({ author: text(record(n.author)?.username, MAX_PERSON), body: text(n.body, MAX_SAID), at: text(n.created_at, 40) })),
      ...(resolvable ? { resolved: notes.every((n) => n.resolvable !== true || n.resolved === true) } : {}),
    })
  }
  return { ok: true, value: threads.slice(0, MAX_THREADS) }
}

/** Every thread on the change, as the forge has them now. */
export async function threads(run: Runner, target: Target): Promise<Read<Thread[]>> {
  if (target.forge === 'gitlab') {
    const ran = await run({ ...inlineThreadsCommand(target), maxBytes: JSON_BYTES })
    return ran.ok ? readGitlabDiscussions(ran.text) : failed(ran)
  }
  const [inline, reviews, comments] = await Promise.all([
    run({ ...inlineThreadsCommand(target), maxBytes: JSON_BYTES }),
    run({ ...reviewsCommand(target), maxBytes: JSON_BYTES }),
    run({ ...notesCommand(target), maxBytes: JSON_BYTES }),
  ])
  if (!inline.ok) return failed(inline)
  if (!reviews.ok) return failed(reviews)
  if (!comments.ok) return failed(comments)
  const found = readGithubInline(inline.text)
  if (!found.ok) return found
  const conversation = readGithubConversation(reviews.text, comments.text)
  if (!conversation.ok) return conversation
  return { ok: true, value: [...(conversation.value ? [conversation.value] : []), ...found.value] }
}

/** The request that posts a reply to one thread, or `null` for a thread this module cannot answer. */
export function replyCommand(target: Target, thread: string, body: string): Run | null {
  if (!THREAD.test(thread) || !body.trim() || body.length > MAX_BODY) return null
  const [kind, id] = thread.split(':') as [string, string | undefined]
  if (target.forge === 'github') {
    if (kind === 'gh-comment') return post(target, `repos/${target.repo}/pulls/${target.number}/comments/${id}/replies`, { body })
    if (kind === 'gh-conversation') return post(target, `repos/${target.repo}/issues/${target.number}/comments`, { body })
    return null
  }
  if (kind === 'gl-discussion') return post(target, `${project(target)}/merge_requests/${target.number}/discussions/${id}/notes`, { body })
  return null
}

/** Post one reply. Where the forge put it, when it said. */
export async function postReply(run: Runner, target: Target, changeUrl: string, thread: string, body: string): Promise<Read<{ url?: string }>> {
  const command = replyCommand(target, thread, body)
  if (!command) return { ok: false, error: 'That thread is not one this app can answer on this tracker.' }
  const ran = await run({ ...command, maxBytes: 1_000_000 })
  if (!ran.ok) return failed(ran)
  const said = record(parse(ran.text))
  const url = typeof said?.html_url === 'string' ? said.html_url : typeof said?.id === 'number' ? `${changeUrl}#note_${said.id}` : undefined
  return { ok: true, value: url && /^https:\/\//.test(url) ? { url: url.slice(0, 600) } : {} }
}
