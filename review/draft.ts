import { locate } from '../forge/locate.ts'
import { isSha } from '../forge/read.ts'

import type { Anchored } from './anchor.ts'
import {
  DOORS,
  DRAFT_VERSION,
  EVIDENCE_KINDS,
  MAX_BODY,
  MAX_CHALLENGE,
  MAX_CHECKLIST,
  MAX_CHECKLIST_ITEM,
  MAX_EVIDENCE,
  MAX_EVIDENCE_QUOTE,
  MAX_PATH_STEP,
  MAX_PATH_STEPS,
  MAX_REASON,
  MAX_REF,
  RULINGS,
  RUN,
  SEVERITIES,
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
  type Evidence,
  type Meta,
  type Proposal,
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
    ...readMeta(one.meta),
  }
}

/** A meta from disk: the same rules as one from a tool call, plus the server's own `head`. Broken, it is dropped and the comment kept. */
function readMeta(value: unknown): { meta?: Meta } {
  const got = metaOf(value)
  if (!got.ok) return {}
  const head = record(value)?.head
  return { meta: { ...got.meta, ...(isSha(head) ? { head } : {}) } }
}

function readProposal(value: unknown): { proposal?: Proposal } {
  const got = proposalOf(value)
  const one = record(value)
  if (!got.ok || !one || !isSha(one.head) || typeof one.at !== 'string') return {}
  const taken = record(one.taken)
  const sent = record(one.sent)
  return {
    proposal: {
      ...got.proposal,
      head: one.head,
      at: str(one.at, 40),
      ...(taken
        ? { taken: { ...(typeof taken.summary === 'string' ? { summary: str(taken.summary, 40) } : {}), ...(typeof taken.verdict === 'string' ? { verdict: str(taken.verdict, 40) } : {}) } }
        : {}),
      ...(sent && typeof sent.at === 'string' && isSha(sent.head) ? { sent: { at: str(sent.at, 40), head: sent.head } } : {}),
    },
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
    ...(one.summaryBy === 'person' || one.summaryBy === 'agent' ? { summaryBy: one.summaryBy } : {}),
    ...(one.verdictBy === 'person' || one.verdictBy === 'agent' ? { verdictBy: one.verdictBy } : {}),
    ...readProposal(one.proposal),
  }
}

/* ------------------------------------------------------------------ *
 * What a review run says, checked
 * ------------------------------------------------------------------ */

type Checked<K extends string, T> = ({ ok: true } & Record<K, T>) | { ok: false; error: string }

const text = (value: unknown, max: number, name: string, required: boolean): { ok: true; value: string | undefined } | { ok: false; error: string } => {
  if (value === undefined || value === null) return required ? { ok: false, error: `${name} is required.` } : { ok: true, value: undefined }
  if (typeof value !== 'string') return { ok: false, error: `${name} is text.` }
  const trimmed = value.trim()
  if (required && !trimmed) return { ok: false, error: `${name} is empty.` }
  if (trimmed.length > max) return { ok: false, error: `${name} is at most ${max} characters; that one is ${trimmed.length}.` }
  return { ok: true, value: trimmed || undefined }
}

const RUN_SAYS = 'A run is named by an id of letters, digits and . _ : - (at most 80), the one Factory gave it.'

export const runOf = (value: unknown): string | null => (typeof value === 'string' && RUN.test(value) ? value : null)

/**
 * A point's meta as a tool call gave it, checked field by field against the contract. Strict: a
 * refusal says which part is wrong, because the caller is a program that can fix it.
 */
export function metaOf(value: unknown): Checked<'meta', Meta> {
  const one = record(value)
  if (!one) return { ok: false, error: 'meta is an object: { run, severity, evidence, challenge?, ruling, reason, checklist? }.' }
  const run = runOf(one.run)
  if (!run) return { ok: false, error: `meta.run: ${RUN_SAYS}` }
  const severity = SEVERITIES.find((s) => s === one.severity)
  if (!severity) return { ok: false, error: `meta.severity is one of ${SEVERITIES.join(', ')}.` }
  const ruling = RULINGS.find((r) => r === one.ruling)
  if (!ruling) return { ok: false, error: `meta.ruling is one of ${RULINGS.join(', ')}.` }
  if (!Array.isArray(one.evidence) || !one.evidence.length || one.evidence.length > MAX_EVIDENCE) {
    return { ok: false, error: `meta.evidence is a list of 1 to ${MAX_EVIDENCE} sources: a point with no source is not kept.` }
  }
  const evidence: Evidence[] = []
  for (const raw of one.evidence) {
    const e = record(raw)
    const kind = EVIDENCE_KINDS.find((k) => k === e?.kind)
    const ref = text(e?.ref, MAX_REF, 'meta.evidence[].ref', true)
    const quote = text(e?.quote, MAX_EVIDENCE_QUOTE, 'meta.evidence[].quote', false)
    if (!kind) return { ok: false, error: `meta.evidence[].kind is one of ${EVIDENCE_KINDS.join(', ')}.` }
    if (!ref.ok) return ref
    if (!quote.ok) return quote
    evidence.push({ kind, ref: ref.value!, ...(quote.value ? { quote: quote.value } : {}) })
  }
  const reason = text(one.reason, MAX_REASON, 'meta.reason', true)
  if (!reason.ok) return reason
  const challenge = text(one.challenge, MAX_CHALLENGE, 'meta.challenge', false)
  if (!challenge.ok) return challenge
  let checklist: string[] | undefined
  if (one.checklist !== undefined && one.checklist !== null) {
    if (!Array.isArray(one.checklist) || one.checklist.length > MAX_CHECKLIST || !one.checklist.every((c) => typeof c === 'string' && c.trim() && c.length <= MAX_CHECKLIST_ITEM)) {
      return { ok: false, error: `meta.checklist is a list of at most ${MAX_CHECKLIST} checklist item ids or texts, each at most ${MAX_CHECKLIST_ITEM} characters.` }
    }
    checklist = (one.checklist as string[]).map((c) => c.trim())
  }
  return {
    ok: true,
    meta: { run, severity, evidence, ...(challenge.value ? { challenge: challenge.value } : {}), ruling, reason: reason.value!, ...(checklist?.length ? { checklist } : {}) },
  }
}

/** What `propose_review` is given, before the server adds the head and the time. */
export type ProposalInput = Omit<Proposal, 'head' | 'at' | 'taken' | 'sent'>

/** A proposal as a tool call gave it, checked against the contract. */
export function proposalOf(value: unknown): Checked<'proposal', ProposalInput> {
  const one = record(value)
  if (!one) return { ok: false, error: 'A proposal is { run, summary, verdict, door, uiux, pathToSuccess }.' }
  const run = runOf(one.run)
  if (!run) return { ok: false, error: `run: ${RUN_SAYS}` }
  const summary = text(one.summary, MAX_SUMMARY, 'summary', true)
  if (!summary.ok) return summary
  const verdict = VERDICTS.find((v) => v === one.verdict)
  if (!verdict) return { ok: false, error: `verdict is one of ${VERDICTS.join(', ')}.` }
  const door = DOORS.find((d) => d === one.door)
  if (!door) return { ok: false, error: `door is one of ${DOORS.join(', ')}: whether the change is hard to undo (one-way) or cheap to undo (two-way).` }
  if (typeof one.uiux !== 'boolean') return { ok: false, error: 'uiux is true or false: whether the change touches what people see.' }
  if (!Array.isArray(one.pathToSuccess) || one.pathToSuccess.length > MAX_PATH_STEPS) {
    return { ok: false, error: `pathToSuccess is a list of at most ${MAX_PATH_STEPS} steps: exactly the required points.` }
  }
  const steps: string[] = []
  for (const step of one.pathToSuccess) {
    const got = text(step, MAX_PATH_STEP, 'pathToSuccess[]', true)
    if (!got.ok) return got
    steps.push(got.value!)
  }
  if (verdict === 'request-changes' && !steps.length) {
    return { ok: false, error: 'A request for changes ends with “To get this approved:” — pathToSuccess needs at least one step.' }
  }
  return { ok: true, proposal: { run, summary: summary.value!, verdict, door, uiux: one.uiux, pathToSuccess: steps } }
}

/** The text a proposal would be posted as: its summary, then "To get this approved:" and the steps, numbered. */
export function proposalBody(proposal: Pick<Proposal, 'summary' | 'pathToSuccess'>): string {
  const summary = proposal.summary.trim()
  if (!proposal.pathToSuccess.length) return summary
  return `${summary}\n\n**To get this approved:**\n\n${proposal.pathToSuccess.map((step, at) => `${at + 1}. ${step}`).join('\n')}`
}

/**
 * Keep a run's proposal beside the person's summary and verdict. The person's are not read or
 * written here, whatever they hold. A newer run's proposal replaces an older one; a proposal that
 * has been sent is not replaced by its own run, because the record of what was sent must stay true.
 */
export function proposeReview(draft: Draft, input: ProposalInput, head: string, now: string): Changed {
  if (draft.proposal?.sent && draft.proposal.run === input.run) {
    return { ok: false, error: `Run ${input.run}’s review has already been sent. Start a new run to propose another.` }
  }
  return { ok: true, draft: { ...draft, proposal: { ...input, head, at: now } } }
}

/**
 * The person takes the proposal's summary or verdict into their own. Their press, so it replaces
 * what was there (the page asks first when there were words). Named by run, so a page drawn before
 * a newer run cannot take that run's words without having shown them.
 */
export function takeProposal(draft: Draft, which: 'summary' | 'verdict', run: unknown, now: string): Changed {
  const proposal = draft.proposal
  if (!proposal) return { ok: false, error: 'There is no proposed review to take.' }
  if (proposal.run !== run) return { ok: false, error: 'The proposal changed after you looked at it (a newer run proposed another). Read it again.' }
  if (which === 'summary') {
    const summary = proposalBody(proposal).slice(0, MAX_SUMMARY)
    return { ok: true, draft: { ...draft, summary, summaryBy: 'person', proposal: { ...proposal, taken: { ...proposal.taken, summary: now } } } }
  }
  if (which === 'verdict') {
    return { ok: true, draft: { ...draft, verdict: proposal.verdict, verdictBy: 'person', proposal: { ...proposal, taken: { ...proposal.taken, verdict: now } } } }
  }
  return { ok: false, error: 'Take the summary or the verdict.' }
}

/** Whether a comment is one a run wrote and may replace: an agent's, unsent, with that run's meta. */
export const ofRun = (comment: Comment, run: string): boolean => comment.by === 'agent' && !comment.sent && comment.meta?.run === run

/**
 * A re-run's clean slate: that run's unsent agent comments go, and nothing else — not the person's
 * comments (whatever a file says about them), not a sent one, not another run's, not the summary.
 */
export function dropRunComments(draft: Draft, run: unknown): Changed {
  const id = runOf(run)
  if (!id) return { ok: false, error: RUN_SAYS }
  return { ok: true, draft: { ...draft, comments: draft.comments.filter((c) => !ofRun(c, id)) } }
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
  meta?: Meta,
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
    /* Only an agent's comment is a run's point: the person's words are never filed under a run. */
    ...(meta && by === 'agent' ? { meta } : {}),
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

/**
 * What an agent is told about a comment the person wrote. Their words go out under their name, and
 * an agent rewording or removing them is the one change a person would not see coming.
 */
export const PERSONS_OWN =
  'That comment is the person’s own, so an agent may not reword or remove it. Say what you would change in a comment of your own.'

export function rewordComment(draft: Draft, id: unknown, body: string, now: string, who: By = 'person'): Changed {
  const was = find(draft, id)
  if (!was) return { ok: false, error: NO_SUCH(id) }
  if (was.sent) return { ok: false, error: ALREADY_SENT }
  if (who === 'agent' && was.by === 'person') return { ok: false, error: PERSONS_OWN }
  return { ok: true, draft: { ...draft, comments: draft.comments.map((c) => (c === was ? { ...c, body, editedAt: now } : c)) } }
}

export function dropComment(draft: Draft, id: unknown, who: By = 'person'): Changed {
  const was = find(draft, id)
  if (!was) return { ok: false, error: NO_SUCH(id) }
  if (was.sent) return { ok: false, error: ALREADY_SENT }
  if (who === 'agent' && was.by === 'person') return { ok: false, error: PERSONS_OWN }
  return { ok: true, draft: { ...draft, comments: draft.comments.filter((c) => c !== was) } }
}

/**
 * Set the verdict, the summary, or both.
 *
 * `undefined` leaves a field alone and `null` clears the verdict, so the page
 * can save the summary on its own as it is typed without re-asserting a
 * verdict the person has not chosen.
 */
export function setVerdict(draft: Draft, verdict: unknown, summary: unknown, who: By = 'person'): Changed {
  let next = draft
  if (verdict !== undefined) {
    const known = verdict === null ? null : VERDICTS.find((v) => v === verdict)
    if (known === undefined) return { ok: false, error: `A verdict is one of ${VERDICTS.join(', ')} — or null for none yet.` }
    if (known !== draft.verdict) {
      if (who === 'agent' && draft.verdict !== null && (draft.verdictBy ?? 'person') === 'person') return { ok: false, error: THEIRS('verdict') }
      next = { ...next, verdict: known, verdictBy: who }
    }
  }
  if (summary !== undefined) {
    if (typeof summary !== 'string') return { ok: false, error: 'A summary is text.' }
    if (summary.length > MAX_SUMMARY) return { ok: false, error: `A summary is at most ${MAX_SUMMARY} characters; that one is ${summary.length}.` }
    if (summary !== draft.summary) {
      if (who === 'agent' && draft.summary.trim() && (draft.summaryBy ?? 'person') === 'person') return { ok: false, error: THEIRS('summary') }
      next = { ...next, summary, summaryBy: who }
    } else if (who === 'person') next = { ...next, summaryBy: 'person' }
  }
  return { ok: true, draft: next }
}

const THEIRS = (what: 'summary' | 'verdict') =>
  `The ${what} is the person’s own, so an agent may not replace it. A review run proposes its summary and verdict with propose_review, beside the person’s.`

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
