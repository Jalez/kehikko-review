import { locate } from '../forge/locate.ts'
import { isSha } from '../forge/read.ts'

import type { Anchored } from './anchor.ts'
import {
  DRAFT_VERSION,
  MAX_BODY,
  MAX_COMMENTS,
  MAX_PATH,
  MAX_QUOTE,
  MAX_SENT_LOG,
  MAX_SUMMARY,
  VERDICTS,
  changeOf,
  type By,
  type ChangeRef,
  type Comment,
  type Draft,
  type Sent,
  type SentRecord,
  type View,
} from './shape.ts'

/**
 * Everything that may happen to a draft, as functions from a draft to a draft.
 *
 * No file, no clock and no randomness of their own: the store reads and
 * writes, and `now` and `id` are handed in. So the rules — a sent comment is
 * never edited, a body has a length, a draft has a size — are in one place,
 * and the page's press and an agent's tool call cannot be told two different
 * things about the same act.
 */

export type Changed = { ok: true; draft: Draft } | { ok: false; error: string }

export const emptyDraft = (change: ChangeRef): Draft => ({
  version: DRAFT_VERSION,
  change,
  comments: [],
  summary: '',
  verdict: null,
  sent: [],
})

/* ------------------------------------------------------------------ *
 * Reading what is on disk
 * ------------------------------------------------------------------ */

const str = (value: unknown, max: number): string => (typeof value === 'string' ? value.slice(0, max) : '')
const int = (value: unknown): number | null => (typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null)
const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null

function readSent(value: unknown): Sent | undefined {
  const one = record(value)
  if (!one || typeof one.at !== 'string') return undefined
  return { at: str(one.at, 40), ...(typeof one.url === 'string' ? { url: str(one.url, 600) } : {}), ...(one.folded === true ? { folded: true } : {}) }
}

function readComment(value: unknown): Comment | null {
  const one = record(value)
  if (!one) return null
  const line = int(one.line)
  if (!line || typeof one.id !== 'string' || !isSha(one.commit) || typeof one.path !== 'string' || !one.path) return null
  const view: View = one.view === 'commit' ? 'commit' : 'all'
  const startLine = int(one.startLine)
  const otherLine = int(one.otherLine)
  const sent = readSent(one.sent)
  return {
    id: str(one.id, 40),
    view,
    commit: one.commit,
    ...(isSha(one.parent) ? { parent: one.parent } : {}),
    path: str(one.path, MAX_PATH),
    ...(typeof one.oldPath === 'string' && one.oldPath ? { oldPath: str(one.oldPath, MAX_PATH) } : {}),
    side: one.side === 'old' ? 'old' : 'new',
    line,
    ...(startLine && startLine < line ? { startLine } : {}),
    ...(otherLine ? { otherLine } : {}),
    quote: str(one.quote, MAX_QUOTE),
    body: str(one.body, MAX_BODY),
    by: one.by === 'agent' ? 'agent' : 'person',
    at: str(one.at, 40),
    ...(typeof one.editedAt === 'string' ? { editedAt: str(one.editedAt, 40) } : {}),
    ...(sent ? { sent } : {}),
  }
}

function readRecord(value: unknown): SentRecord | null {
  const one = record(value)
  if (!one || typeof one.at !== 'string') return null
  const verdict = VERDICTS.find((v) => v === one.verdict)
  if (!verdict) return null
  return {
    at: str(one.at, 40),
    verdict,
    head: str(one.head, 64),
    comments: typeof one.comments === 'number' && one.comments >= 0 ? Math.floor(one.comments) : 0,
    summary: str(one.summary, MAX_SUMMARY),
    notes: Array.isArray(one.notes) ? one.notes.filter((n): n is string => typeof n === 'string').slice(0, 40).map((n) => n.slice(0, 1000)) : [],
  }
}

/**
 * A draft out of whatever JSON was in the file, or `null`.
 *
 * The file is in somebody's project, where a person, a merge or another
 * program can have been at it, so it is read as a stranger's and not as this
 * program's own output. Field by field, bounded, with anything that is not
 * what it should be dropped.
 *
 * The one thing it will NOT do is trust the file about which change it is. The
 * `change.url` is put back through `locate`, and the address the draft is used
 * for is the one `locate` returns: a hand-edited `repo` field must never be
 * able to send somebody's comments to a different repository than the URL
 * beside it says.
 */
export function readDraft(value: unknown): Draft | null {
  const one = record(value)
  if (!one || one.version !== DRAFT_VERSION) return null
  const target = locate(record(one.change)?.url)
  if (!target) return null
  return {
    version: DRAFT_VERSION,
    change: changeOf(target),
    comments: (Array.isArray(one.comments) ? one.comments : [])
      .slice(0, MAX_COMMENTS * 2)
      .map(readComment)
      .filter((c): c is Comment => c !== null),
    summary: str(one.summary, MAX_SUMMARY),
    verdict: VERDICTS.find((v) => v === one.verdict) ?? null,
    sent: (Array.isArray(one.sent) ? one.sent : []).map(readRecord).filter((r): r is SentRecord => r !== null).slice(-MAX_SENT_LOG),
  }
}

/* ------------------------------------------------------------------ *
 * Changing it
 * ------------------------------------------------------------------ */

/** A body, trimmed, or the sentence saying why it is not one. */
export function bodyOf(value: unknown): { ok: true; body: string } | { ok: false; error: string } {
  if (typeof value !== 'string') return { ok: false, error: 'A comment needs a body: the words to post.' }
  const body = value.trim()
  if (!body) return { ok: false, error: 'An empty comment says nothing, so it was not kept.' }
  if (body.length > MAX_BODY) return { ok: false, error: `A comment is at most ${MAX_BODY} characters; that one is ${body.length}.` }
  return { ok: true, body }
}

export const unsent = (draft: Draft): Comment[] => draft.comments.filter((c) => !c.sent)

export function addComment(
  draft: Draft,
  place: { view: View; commit: string; parent?: string; anchor: Anchored },
  body: string,
  by: By,
  now: string,
  id: string,
): Changed {
  /* Counted over what is still to be sent. Sent comments are history, and a
     long-running review should not be refused its fifth round because the
     first four were thorough. */
  if (unsent(draft).length >= MAX_COMMENTS) {
    return { ok: false, error: `This draft already holds ${MAX_COMMENTS} unsent comments. Send or drop some before adding more.` }
  }
  const { anchor } = place
  const comment: Comment = {
    id,
    view: place.view,
    commit: place.commit,
    ...(place.parent ? { parent: place.parent } : {}),
    path: anchor.path.slice(0, MAX_PATH),
    ...(anchor.oldPath ? { oldPath: anchor.oldPath.slice(0, MAX_PATH) } : {}),
    side: anchor.side,
    line: anchor.line,
    ...(anchor.startLine !== undefined ? { startLine: anchor.startLine } : {}),
    ...(anchor.otherLine !== undefined ? { otherLine: anchor.otherLine } : {}),
    quote: anchor.quote,
    body,
    by,
    at: now,
  }
  return { ok: true, draft: { ...draft, comments: [...draft.comments, comment] } }
}

/**
 * What both "reword" and "drop" say about a comment that has gone out.
 *
 * It is on the tracker now, under somebody's name, where people may already
 * have read and answered it. Changing the copy here would make this file
 * disagree with what was actually said, and the record of what was sent is the
 * one thing in a draft that must stay true.
 */
const ALREADY_SENT = 'That comment has already been sent, so it is on the tracker now and is not changed from here. Edit or delete it there.'

const find = (draft: Draft, id: unknown): Comment | null =>
  typeof id === 'string' ? (draft.comments.find((c) => c.id === id) ?? null) : null

const NO_SUCH = (id: unknown) => `There is no comment "${String(id).slice(0, 40)}" in this draft.`

export function rewordComment(draft: Draft, id: unknown, body: string, now: string): Changed {
  const was = find(draft, id)
  if (!was) return { ok: false, error: NO_SUCH(id) }
  if (was.sent) return { ok: false, error: ALREADY_SENT }
  return { ok: true, draft: { ...draft, comments: draft.comments.map((c) => (c === was ? { ...c, body, editedAt: now } : c)) } }
}

export function dropComment(draft: Draft, id: unknown): Changed {
  const was = find(draft, id)
  if (!was) return { ok: false, error: NO_SUCH(id) }
  if (was.sent) return { ok: false, error: ALREADY_SENT }
  return { ok: true, draft: { ...draft, comments: draft.comments.filter((c) => c !== was) } }
}

/**
 * Set the verdict, the summary, or both.
 *
 * `undefined` leaves a field alone and `null` clears the verdict, so the page
 * can save the summary on its own as it is typed without re-asserting a
 * verdict the person has not chosen.
 */
export function setVerdict(draft: Draft, verdict: unknown, summary: unknown): Changed {
  let next = draft
  if (verdict !== undefined) {
    const known = verdict === null ? null : VERDICTS.find((v) => v === verdict)
    if (known === undefined) return { ok: false, error: `A verdict is one of ${VERDICTS.join(', ')} — or null for none yet.` }
    next = { ...next, verdict: known }
  }
  if (summary !== undefined) {
    if (typeof summary !== 'string') return { ok: false, error: 'A summary is text.' }
    if (summary.length > MAX_SUMMARY) return { ok: false, error: `A summary is at most ${MAX_SUMMARY} characters; that one is ${summary.length}.` }
    next = { ...next, summary }
  }
  return { ok: true, draft: next }
}

/** Mark comments as posted. Only ever sets `sent` on a comment that has none: a stamp is not rewritten. */
export function stamp(draft: Draft, ids: readonly string[], sent: Sent): Draft {
  const which = new Set(ids)
  return { ...draft, comments: draft.comments.map((c) => (which.has(c.id) && !c.sent ? { ...c, sent } : c)) }
}

/** File one send in the draft's own history. `settled` also clears the summary and verdict that went out with it. */
export function logSend(draft: Draft, entry: SentRecord, settled: boolean): Draft {
  return {
    ...draft,
    ...(settled ? { summary: '', verdict: null } : {}),
    sent: [...draft.sent, entry].slice(-MAX_SENT_LOG),
  }
}
