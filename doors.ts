import { KEHIKOT_DIR } from 'kehikot-module-protocol'
import { DOOR_PROJECT_SAYS, establishBuild, mintTicket, refuseTicket, resolveDoorProject, type Reply } from 'kehikot-module-protocol/serve'

import { locate, type Target } from './forge/locate.ts'
import { commits as readCommits, describe, diff, held, isSha, login, notes, people, type Commit, type Described, type People, type Range } from './forge/read.ts'
import { run as realRun, type Runner } from './forge/run.ts'
import { ID, MANIFEST, VERSION } from './manifest.ts'
import { anchor } from './review/anchor.ts'
import {
  addComment,
  addProof,
  addReply,
  atHead,
  bodyOf,
  dropComment,
  dropProof,
  dropReply,
  dropRunComments,
  keepComment,
  logSend,
  metaOf,
  personMaySend,
  proposalOf,
  proposeReview,
  replaceable,
  resolveComment,
  rewordComment,
  rewordReply,
  RUN_SAYS,
  runOf,
  setVerdict,
  stamp,
  stampReply,
  takeProposal,
} from './review/draft.ts'
import { mimeOf, takeEvidence } from './evidence.ts'
import { postReply, threads as readThreads, type Thread } from './forge/threads.ts'
import { skillAt } from './skills.ts'
import { keyOf } from './review/key.ts'
import { shotsOf } from './review/shots.ts'
import { DEFAULT_DIFF_LINES, MAX_DIFF_LINES, printComment, printDiff, printDraft, printFiles, printThreads } from './review/print.ts'
import { execute, gather, plan, type Facts, type Report } from './review/send.ts'
import {
  DOORS,
  EVIDENCE_KINDS,
  MAX_BODY,
  MAX_CAPTION,
  MAX_SAID,
  PROOF_KINDS,
  THREAD,
  MAX_PATH,
  MAX_PATH_STEPS,
  MAX_SUMMARY,
  RULINGS,
  SEVERITIES,
  VERDICTS,
  short,
  spell,
  targetOf,
  type By,
  type Draft,
  type Meta,
  type Side,
  type Verdict,
  type View,
} from './review/shape.ts'
import { parseDiff, totals } from './src/diff/parse.ts'
import { changeDraft, forgetProof, keepProofFile, listDrafts, readDraftFor, readProofFile, reviewText } from './store.ts'
import { focusOf, keepFocus, printFocus } from './focus.ts'

/**
 * Every door but the page, as one function: `answer` takes a request and
 * returns a status and a body, or `null` for "not ours, let Vite have it".
 * `vite.config.ts` is the only thing that touches a socket, which is what lets
 * the tests call this directly.
 *
 * ## Two callers, and one thing only one of them may do
 *
 * The page calls `/api/…`; an agent calls `/mcp`. Both can read a change and
 * both can write a DRAFT, through the same functions, so the rules about what
 * a comment may be are said once. Only the page can SEND, and that is not a
 * convention: there is no MCP tool for it (`test/doors.test.ts` asserts the
 * list), and `/api/send` wants the ticket only the page was handed.
 *
 * ## Nothing here trusts its caller
 *
 * A third caller is whatever else on this machine found the port. Every string
 * is bounded before it is used, a change is only ever addressed through
 * `locate`'s whitelist, and a commit id is matched against `SHA` before it
 * goes near a command line.
 */

/**
 * The ticket a page write has to carry.
 *
 * Minted per process and printed into `/app` (by the protocol's `doors()`), so only
 * this app's own page holds it. Loopback is a fence around the machine, not
 * around the programs on it: without this, any page in the browser that found
 * the port could post a review in the person's name. Reads are ungated, and
 * `/mcp` is ungated because an agent has no page to have been handed a ticket
 * by — which is exactly why `/mcp` cannot send.
 */
export const TICKET = mintTicket()

/**
 * What a write without the ticket is told. Said through the protocol's `refuseTicket`, whose mark
 * (`refused: 'ticket'`) is how this app's page tells "I am older than my server" — and reloads
 * itself — from every other refusal.
 */
const NO_TICKET =
  'that press did not come from this app’s own page — or the page is from a previous run of this server, in which '
  + 'case reloading the pane gives it the ticket this run minted.'

/** What this process is built from and when it started; `doors()` says it wherever a build is said. */
export const BUILD = establishBuild({ version: VERSION, dir: import.meta.dirname })

export type { Reply }

/**
 * What the doors reach the world through, as a value.
 *
 * The real one spawns `gh` and `glab`. Every test hands in its own, so no test
 * starts a process — and so the send path in particular has only ever been
 * exercised against a function that records what it WOULD have posted.
 */
export interface Deps {
  run: Runner
  now(): string
  id(): string
}

export const REAL: Deps = {
  run: realRun,
  now: () => new Date().toISOString(),
  /* Short enough to read aloud to an agent and unique enough for one draft:
     48 bits against a ceiling of a few hundred comments. */
  id: () => `c-${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`,
}

/** A fresh id with this prefix: `e-` evidence, `r-` a reply. Twelve hex digits, as a point's. */
const idWith = (deps: Deps, prefix: 'e' | 'r'): string => `${prefix}-${deps.id().replace(/^c-/, '').replace(/[^0-9a-f]/g, '').padEnd(12, '0').slice(0, 12)}`

export const ok = (body: Record<string, unknown>): Reply => ({ status: 200, body: { ok: true, ...body } })
export const bad = (why: string, status = 400): Reply => ({ status, body: { ok: false, error: why } })

const str = (value: unknown, max: number): string | null => (typeof value === 'string' && value.length <= max ? value : null)

const NOT_A_CHANGE =
  'That is not the address of a pull request or merge request this app can read. It takes the tracker’s own URL: '
  + 'https://github.com/owner/repo/pull/12 or https://gitlab.example/group/project/-/merge_requests/12.'

/* ------------------------------------------------------------------ *
 * Reading a change
 * ------------------------------------------------------------------ */

interface ChangeRead {
  described: Described
  commits: Commit[]
  more: boolean
}

type Got<T> = { ok: true; value: T } | { ok: false; error: string }

async function readChange(deps: Deps, target: Target): Promise<Got<ChangeRead>> {
  /* Two calls, at once: they do not depend on each other and each is a
     subprocess and a network round trip. */
  const [described, listed] = await Promise.all([describe(deps.run, target), readCommits(deps.run, target)])
  if (!described.ok) return described
  if (!listed.ok) return listed
  return { ok: true, value: { described: described.value, commits: listed.value.commits, more: listed.value.more } }
}

/**
 * The commit a caller means, among the commits the change actually has.
 *
 * A full sha or any unambiguous prefix of one, because an agent that read
 * `3b299de3` off a listing should be able to say `3b299de3`. Resolved against
 * the change's OWN list and nothing else: a comment "on commit X" of a change X
 * is not part of would be a comment on somebody else's work, and no tracker
 * would have anywhere to put it.
 */
function resolveCommit(commits: readonly Commit[], given: string, more: boolean): Got<Commit> {
  if (!isSha(given)) return { ok: false, error: 'A commit is named by its id: 7 to 64 lowercase hex characters.' }
  const matches = commits.filter((c) => c.sha.startsWith(given))
  if (matches.length === 1) return { ok: true, value: matches[0]! }
  if (matches.length > 1) return { ok: false, error: `"${given}" matches ${matches.length} commits of this change. Give more of the id.` }
  return {
    ok: false,
    error: `${short(given)} is not one of this change’s commits${more ? ' that this app lists (it reads the first 100)' : ''}. Its commits are: ${commits.map((c) => short(c.sha)).join(', ') || 'none'}.`,
  }
}

/* ------------------------------------------------------------------ *
 * Writing a comment: the one place an anchor is checked
 * ------------------------------------------------------------------ */

interface CommentInput {
  view: View
  /** For `all`: the head the caller was looking at, when it says. For `commit`: the commit. */
  commit: string | null
  path: unknown
  side: unknown
  line: unknown
  startLine: unknown
  body: unknown
}

/**
 * Add a draft comment, having checked that it points at real lines.
 *
 * The same function for the page and for an agent, with `by` the only
 * difference, so the two cannot be held to different standards.
 *
 * Everything slow happens first — the tracker is asked what the head is, and
 * the diff of the named view is fetched (or found in the cache) — and only
 * then is the draft touched, in one synchronous step (see `changeDraft`).
 */
async function writeComment(deps: Deps, projectPath: string | null, target: Target, input: CommentInput, by: By, meta?: Meta): Promise<Got<Draft>> {
  const body = bodyOf(input.body)
  if (!body.ok) return body
  const path = str(input.path, MAX_PATH)
  if (!path) return { ok: false, error: 'A comment names a file by its path in the diff.' }
  const side: Side | null = input.side === undefined || input.side === null ? 'new' : input.side === 'new' || input.side === 'old' ? input.side : null
  if (!side) return { ok: false, error: 'side is "new" or "old": which column of line numbers the line is from. Left out, it is "new".' }
  if (typeof input.line !== 'number') return { ok: false, error: 'line is a whole number, counted from 1.' }
  if (input.startLine !== undefined && input.startLine !== null && typeof input.startLine !== 'number') {
    return { ok: false, error: 'start_line is a whole number, counted from 1.' }
  }
  /* Fail before spending a subprocess on a draft there is nowhere to keep. */
  const before = readDraftFor(projectPath, target)
  if (!before.ok) return before

  const change = await readChange(deps, target)
  if (!change.ok) return change
  const { described, commits, more } = change.value

  let range: Range
  let parent: string | undefined
  let where: string
  if (input.view === 'all') {
    /*
     * The frame of an all-changes comment is the head it was written against.
     * A caller that says which head it was looking at is held to it: if the
     * change has moved since, the line numbers it is quoting are from a diff
     * that no longer exists, and checking them against the NEW diff would
     * either refuse a comment that was right or — worse — accept it on
     * different lines that happen to have the same numbers.
     */
    if (input.commit && input.commit !== described.head) {
      return {
        ok: false,
        error: `This change’s head is now ${short(described.head)}; that comment was aimed at ${short(input.commit)}. Read the diff again and place it against what is there now.`,
      }
    }
    range = { view: 'all', sha: described.head }
    where = `the diff of the whole change at ${short(described.head)}`
  } else {
    const found = resolveCommit(commits, input.commit ?? '', more)
    if (!found.ok) return found
    range = { view: 'commit', sha: found.value.sha }
    parent = found.value.parents[0]
    where = `the diff of commit ${short(found.value.sha)}`
  }

  const patch = await diff(deps.run, target, range)
  if (!patch.ok) return patch
  const placed = anchor(parseDiff(patch.value.text), { path, side, line: input.line, ...(typeof input.startLine === 'number' ? { startLine: input.startLine } : {}) }, where)
  if (!placed.ok) {
    return {
      ok: false,
      error: placed.error + (patch.value.truncated ? ' (That diff was too large to read whole, so a file near its end may be missing here.)' : ''),
    }
  }

  /* A run's point is stamped with the head the forge named just now: the Factory send compares it
     with the head at the moment of sending, and a point read at another head is not sent. */
  const stamped = meta ? { ...meta, head: described.head } : undefined
  const written = changeDraft(projectPath, target, (draft) =>
    addComment(atHead(draft, described.head), { view: input.view, commit: range.sha, ...(parent ? { parent } : {}), anchor: placed.anchor }, body.body, by, deps.now(), deps.id(), stamped),
  )
  return written
}

/* ------------------------------------------------------------------ *
 * Sending
 * ------------------------------------------------------------------ */

/**
 * The changes with a send in flight.
 *
 * Sending is several requests with awaits between them, and two presses — a
 * double click, two panes showing the same change — would each plan from a
 * draft in which nothing is stamped yet and post everything twice. So a second
 * send for the same change in the same project is refused while the first is
 * running. In memory, because the thing it guards against is two requests to
 * THIS process.
 */
const sending = new Set<string>()

/**
 * Run `work` holding the change's send lock, or answer 409 when a send of the same change in the
 * same project is already under way — whichever door it came through, the page's or Factory's.
 */
export async function underLock(projectPath: string | null, target: Target, work: () => Promise<Reply>): Promise<Reply> {
  const lock = `${projectPath ?? ''}|${keyOf(target)}`
  if (sending.has(lock)) return bad('A send for this change is already under way. Wait for it to finish.', 409)
  sending.add(lock)
  try {
    return await work()
  } finally {
    sending.delete(lock)
  }
}

/** What one send posts: these comments, this verdict, this body — and whose send it is. */
export interface Delivery {
  ids: string[]
  verdict: Verdict
  summary: string
  /**
   * `person`: the page's send. The person's summary is cleared the moment it is posted and the
   * verdict once everything went. `run`: Factory's send of a review run. The person's summary and
   * verdict are never read or written; the run's proposal is marked sent when everything went.
   */
  by: { kind: 'person' } | { kind: 'run'; run: string }
  /** A last look at the change as the forge says it is now, before anything is posted. A sentence refuses (409). */
  check?(facts: Facts): string | null
}

/**
 * Post one review and keep the draft true about it. The forge is read fresh first; nothing is
 * posted when it cannot be read or `check` refuses. Called inside `underLock`.
 */
export async function deliver(deps: Deps, projectPath: string | null, target: Target, draft: Draft, delivery: Delivery): Promise<Reply> {
  const facts = await gather(deps.run, target, draft)
  if (!facts.ok) return bad(`Nothing was sent. The change could not be read just before sending: ${facts.error}`, 502)
  const refused = delivery.check?.(facts.value)
  if (refused) return bad(`Nothing was sent. ${refused}`, 409)
  const sendable: Draft = { ...draft, summary: delivery.summary, verdict: delivery.verdict }
  const made = plan(target, sendable, facts.value, delivery.ids)
  if (!made.ok) return bad(made.error)

  const byPerson = delivery.by.kind === 'person'
  const save = (change: (was: Draft) => Draft) => changeDraft(projectPath, target, (was) => ({ ok: true, draft: change(was) }))
  const report: Report = await execute(deps.run, target, made.plan, sendable, {
    stamp: (which, sent) => void save((was) => stamp(was, which, sent)),
    summarySent: () => {
      /* Cleared the moment it is posted, not at the end: if the approval
         after it fails, pressing Send again must not post the summary twice.
         A run's summary is its proposal's, and the person's is not touched. */
      if (byPerson) void save((was) => ({ ...was, summary: '' }))
    },
    now: deps.now,
  })

  /* The history is written whenever anything reached the tracker, including
     a send that stopped half way: that is when a record matters most. */
  const reached = report.posted.length + report.folded.length > 0 || report.summarySent || report.verdictSent
  const by = delivery.by
  const after = save((was) => {
    let settled = was
    if (report.complete) {
      settled = by.kind === 'person'
        ? { ...was, verdict: null }
        : was.proposal && was.proposal.run === by.run
          ? { ...was, proposal: { ...was.proposal, sent: { at: deps.now(), head: made.plan.head } } }
          : was
    }
    const notes = by.kind === 'run' ? [`Sent by Factory for review run ${by.run}, without the person.`, ...report.notes] : report.notes
    return reached
      ? logSend(
          settled,
          { at: deps.now(), verdict: made.plan.verdict, head: made.plan.head, comments: report.posted.length + report.folded.length, summary: delivery.summary.slice(0, MAX_SUMMARY), notes },
          false,
        )
      : settled
  })
  if (!after.ok) {
    /* The requests were made; only the bookkeeping failed. Say exactly that,
       because the dangerous reading of an error here is "it did not send". */
    return bad(`The review was sent, but the draft could not be updated afterwards: ${after.error} ${report.notes.join(' ')}`, 500)
  }
  return ok({ draft: after.value, report })
}

async function send(deps: Deps, projectPath: string | null, target: Target, body: Record<string, unknown>): Promise<Reply> {
  return underLock(projectPath, target, async () => {
    const read = readDraftFor(projectPath, target)
    if (!read.ok) return bad(read.error)
    const draft = read.value

    /*
     * The person confirmed a particular review: these comments, this verdict,
     * this summary. The request carries all three back, and if the draft no
     * longer matches — an agent added a comment or changed the verdict between
     * the two presses — nothing is sent. What goes out under somebody's name
     * is what they were shown, or nothing.
     */
    const ids = Array.isArray(body.ids) && body.ids.length <= 1000 ? body.ids.filter((id): id is string => typeof id === 'string') : null
    if (!ids) return bad('A send names the comments that were confirmed, as ids.')
    /* Only what the person may send: their own points, and an agent's they kept. An agent's point
       nobody kept is still a draft, whatever a request says. */
    const sendable = new Set(draft.comments.filter(personMaySend).map((c) => c.id))
    const strangers = ids.filter((id) => !sendable.has(id))
    const CHANGED = 'The review changed after you looked at it, so nothing was sent. Read what it says now and confirm again.'
    if (strangers.length || body.verdict !== draft.verdict || body.summary !== draft.summary) return bad(CHANGED, 409)
    if (!draft.verdict) return bad('Choose a verdict first: comment, approve or request changes.')

    return deliver(deps, projectPath, target, draft, { ids, verdict: draft.verdict, summary: draft.summary, by: { kind: 'person' } })
  })
}

/**
 * Post one reply the person confirmed, to its thread. The request carries the words they were
 * shown; if the reply on disk says anything else now, nothing is posted. Stamped `sent` the moment
 * the forge took it.
 */
async function sendReply(deps: Deps, projectPath: string | null, target: Target, body: Record<string, unknown>): Promise<Reply> {
  return underLock(projectPath, target, async () => {
    const read = readDraftFor(projectPath, target)
    if (!read.ok) return bad(read.error)
    const reply = read.value.replies.find((r) => r.id === body.id)
    if (!reply) return bad('There is no such reply in this review.')
    if (reply.sent) return bad('That reply has already been posted.', 409)
    if (body.body !== reply.body) return bad('The reply changed after you looked at it, so nothing was posted. Read it again and confirm.', 409)
    const posted = await postReply(deps.run, target, read.value.change.url, reply.thread, reply.body)
    if (!posted.ok) return bad(`Nothing was posted: ${posted.error}`, 502)
    const after = changeDraft(projectPath, target, (was) => ({ ok: true, draft: stampReply(was, reply.id, { at: deps.now(), ...posted.value }) }))
    if (!after.ok) return bad(`The reply was posted, but the review could not be updated afterwards: ${after.error}`, 500)
    return ok({ draft: after.value })
  })
}

/* ------------------------------------------------------------------ *
 * The MCP door, for agents
 * ------------------------------------------------------------------ */

const PROJECT = {
  project: {
    type: 'string',
    description:
      `The absolute directory of the project. Required: drafts are kept inside the project, at <project>/${KEHIKOT_DIR}/review/, so this is the address of the file and not a filter.`,
  },
} as const

const CHANGE = {
  change: {
    type: 'string',
    description:
      'Which pull or merge request: its URL on the tracker (https://github.com/owner/repo/pull/12, https://gitlab.example/group/project/-/merge_requests/12). '
      + 'For a change that already has a draft in this project, the short form list_reviews prints (owner/repo#12, group/project!12) also works.',
  },
} as const

const NOT_SENT =
  ' Nothing is posted to the tracker by this tool: it writes a draft in the project, and only the person sends a review, from the page.'

const ANCHORING =
  'HOW A COMMENT IS ANCHORED. A line number only means something inside one particular diff, so a comment names the diff it was read in. '
  + 'Leave `commit` out and the line is a line of the WHOLE change’s diff (base to head), as read_diff prints it with no commit. '
  + 'Give `commit` (an id from read_change) and the line is a line of THAT commit’s own diff (its parent to it), as read_diff prints it with that commit. '
  + 'The same file has different line numbers in each, so read the diff you mean with read_diff and cite the numbers it prints: '
  + 'the first column is the OLD line number, the second the NEW. `side: "new"` (the default) reads the second column and is right for added and unchanged lines; '
  + '`side: "old"` reads the first and is for a line that was REMOVED. Only lines the diff shows can be commented on, and a range (start_line to line) must stay inside one hunk. '
  + 'The comment is checked against the diff when you add it, and refused with the reason if it does not point at real lines.'

/** What a tool says it does (MCP's own hints): a reader, a write that deletes nothing, or one that replaces what was there. */
const READS = { readOnlyHint: true, destructiveHint: false, idempotentHint: true } as const
const WRITES = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const
const REPLACES = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false } as const
/** The tool, with the state of the `annotations` it states. `openWorldHint`: it asks the tracker. */
const ANNOTATIONS: Record<string, Record<string, boolean>> = {
  list_reviews: { ...READS, openWorldHint: false },
  read_review: { ...READS, openWorldHint: false },
  read_change: { ...READS, openWorldHint: true },
  read_diff: { ...READS, openWorldHint: true },
  add_comment: { ...WRITES, openWorldHint: true },
  reword_comment: REPLACES,
  drop_comment: { ...REPLACES, idempotentHint: false },
  set_verdict: REPLACES,
  propose_review: { ...REPLACES, openWorldHint: true },
  drop_run_comments: REPLACES,
  add_evidence: { ...WRITES, openWorldHint: false },
  read_review_md: { ...READS, openWorldHint: false },
  read_focus: { ...READS, openWorldHint: false },
  read_threads: { ...READS, openWorldHint: true },
  draft_reply: { ...REPLACES, openWorldHint: false },
}

function tools() {
  return listed().map((tool) => ({ ...tool, annotations: ANNOTATIONS[tool.name] }))
}

function listed() {
  return [
    {
      name: 'list_reviews',
      description: 'The draft reviews kept in a project: one line per pull or merge request, with how many comments are waiting and the verdict proposed.' + NOT_SENT,
      inputSchema: { type: 'object', properties: { ...PROJECT }, required: ['project'] },
    },
    {
      name: 'read_review',
      description:
        'The draft review of one change: every comment with its id, file, line, side, the commit whose diff it was written against, who wrote it and whether it has been sent; the summary; the proposed verdict.'
        + NOT_SENT,
      inputSchema: { type: 'object', properties: { ...PROJECT, ...CHANGE }, required: ['project', 'change'] },
    },
    {
      name: 'read_change',
      description:
        'What a pull or merge request is, read from the tracker now: title, state, author, head commit, its commits oldest first (id, title, author), and the files the whole change touches with added and removed counts. '
        + 'Start here; the commit ids it prints are what read_diff and add_comment take.',
      inputSchema: { type: 'object', properties: { ...PROJECT, ...CHANGE }, required: ['project', 'change'] },
    },
    {
      name: 'read_diff',
      description:
        'A diff of the change with a line number beside every line: the whole change (no commit) or one commit’s own diff (commit set). '
        + 'Each line is printed as: old line number, new line number, then the line with its +/- mark. Those numbers are what add_comment takes. '
        + `Bounded: ${DEFAULT_DIFF_LINES} lines unless max_lines says otherwise (up to ${MAX_DIFF_LINES}), and it says how many were left out. Use path to read one file.`,
      inputSchema: {
        type: 'object',
        properties: {
          ...PROJECT,
          ...CHANGE,
          commit: { type: 'string', description: 'A commit id from read_change, or a unique prefix of at least 7 characters, for that commit’s own diff. Leave out for the whole change.' },
          path: { type: 'string', description: 'Print only this file.' },
          max_lines: { type: 'integer', description: `How many diff lines to print, at most ${MAX_DIFF_LINES}.` },
        },
        required: ['project', 'change'],
      },
    },
    {
      name: 'add_comment',
      description: `Draft a comment on a line, or a range of lines, of a change. It is marked as written by an agent, and the person sees it on the page.${NOT_SENT}\n\n${ANCHORING}`,
      inputSchema: {
        type: 'object',
        properties: {
          ...PROJECT,
          ...CHANGE,
          commit: { type: 'string', description: 'The commit whose own diff the line is from. Leave out when the line is from the whole change’s diff.' },
          path: { type: 'string', description: 'The file, by the path the diff prints for it.' },
          line: { type: 'integer', description: 'The line number, from the column `side` names. The last line when commenting on a range.' },
          start_line: { type: 'integer', description: 'The first line of a range, on the same side. Leave out for a single line.' },
          side: { type: 'string', enum: ['new', 'old'], description: '"new" (default): the second number column, for added and unchanged lines. "old": the first, for removed lines.' },
          body: { type: 'string', description: `The comment, as it would be posted. Markdown. At most ${MAX_BODY} characters.` },
          meta: META_SCHEMA,
        },
        required: ['project', 'change', 'path', 'line', 'body'],
      },
    },
    {
      name: 'reword_comment',
      description: 'Replace the words of a draft comment, by its id from read_review. Its anchor does not move. A comment that has been sent cannot be reworded.' + NOT_SENT,
      inputSchema: {
        type: 'object',
        properties: { ...PROJECT, ...CHANGE, id: { type: 'string', description: 'The comment’s id.' }, body: { type: 'string', description: 'The new words.' } },
        required: ['project', 'change', 'id', 'body'],
      },
    },
    {
      name: 'drop_comment',
      description: 'Remove a draft comment, by its id from read_review. A comment that has been sent cannot be dropped from here.' + NOT_SENT,
      inputSchema: { type: 'object', properties: { ...PROJECT, ...CHANGE, id: { type: 'string', description: 'The comment’s id.' } }, required: ['project', 'change', 'id'] },
    },
    {
      name: 'set_verdict',
      description:
        'Propose the review’s verdict and its summary. A PROPOSAL: the person sees both on the page, can change either, and is the one who sends. Give verdict, summary or both; what is left out is not changed.'
        + NOT_SENT,
      inputSchema: {
        type: 'object',
        properties: {
          ...PROJECT,
          ...CHANGE,
          verdict: { type: 'string', enum: ['comment', 'approve', 'request-changes'], description: 'What the review concludes.' },
          summary: { type: 'string', description: `The review’s overall comment, as it would be posted. Markdown. At most ${MAX_SUMMARY} characters.` },
        },
        required: ['project', 'change'],
      },
    },
    {
      name: 'propose_review',
      description:
        'A review run’s summary and verdict, kept BESIDE the person’s and never over them: the page shows it, and the person can take the summary, the verdict, or neither. '
        + 'A newer run’s proposal replaces an older one. door and uiux say whether the change is hard to undo and whether it touches what people see; pathToSuccess is exactly the required points, '
        + 'shown as “To get this approved:”.'
        + NOT_SENT,
      inputSchema: {
        type: 'object',
        properties: {
          ...PROJECT,
          ...CHANGE,
          run: RUN_SCHEMA,
          summary: { type: 'string', description: `The proposed summary, as it would be posted. Markdown. At most ${MAX_SUMMARY} characters.` },
          verdict: { type: 'string', enum: [...VERDICTS], description: 'The proposed verdict.' },
          door: { type: 'string', enum: [...DOORS], description: 'one-way: hard or impossible to undo. two-way: cheap to undo. When in doubt, one-way.' },
          uiux: { type: 'boolean', description: 'True when the change touches what people see.' },
          pathToSuccess: {
            type: 'array',
            items: { type: 'string' },
            maxItems: MAX_PATH_STEPS,
            description: 'Exactly the required points, each a step a person can do. At least one when the verdict is request-changes; empty when nothing is required.',
          },
        },
        required: ['project', 'change', 'run', 'summary', 'verdict', 'door', 'uiux', 'pathToSuccess'],
      },
    },
    {
      name: 'drop_run_comments',
      description:
        'Before a re-run: drop the unsent comments a run wrote (those added with that meta.run), and the evidence an agent collected for that run or attached to them. Only those — never the person’s comments, never a point the person kept, never a sent one, never another run’s, never the person’s evidence, and never the summary or verdict.'
        + NOT_SENT,
      inputSchema: { type: 'object', properties: { ...PROJECT, ...CHANGE, run: RUN_SCHEMA }, required: ['project', 'change', 'run'] },
    },
    {
      name: 'add_evidence',
      description:
        'Keep a piece of evidence beside the review: a screenshot, a run log, or test output. It is copied into the review’s own folder (<project>/'
        + `${KEHIKOT_DIR}/review/<change>/) and listed in its Evidence section; with point, it is shown on that point. `
        + 'A screenshot is a PNG, JPEG, GIF or WebP file (at most 10 MB), given as path. A log or test output is UTF-8 text (at most 1 MB), given as path or as text. '
        + 'A path is read only from inside the project or the system’s temporary folder.'
        + NOT_SENT,
      inputSchema: {
        type: 'object',
        properties: {
          ...PROJECT,
          ...CHANGE,
          kind: { type: 'string', enum: [...PROOF_KINDS], description: 'screenshot, log (a run’s output) or test (test output).' },
          path: { type: 'string', description: 'The absolute path of the file, inside the project or the system’s temporary folder.' },
          text: { type: 'string', description: 'For a log or test output: the text itself, instead of path.' },
          caption: { type: 'string', description: `What it shows, in one line a person reads first. At most ${MAX_CAPTION} characters.` },
          point: { type: 'string', description: 'The id of the point it supports (from read_review). Leave out for evidence about the change as a whole.' },
          run: RUN_SCHEMA,
        },
        required: ['project', 'change', 'kind', 'caption'],
      },
    },
    {
      name: 'read_review_md',
      description:
        'The review as the Markdown file it is kept in: front matter (change, head, verdict, door, uiux, status), the summary and any proposal with “To get this approved:”, every point with its code reference (path:line@commit), severity, evidence, challenge, ruling and state, the evidence files, the replies and the sends. '
        + 'Read-only: change it through the other tools, never by editing the file.',
      inputSchema: { type: 'object', properties: { ...PROJECT, ...CHANGE }, required: ['project', 'change'] },
    },
    {
      name: 'read_focus',
      description:
        'What the person is looking at in Review, in this project: the change its page has open, and the place in that change’s code somebody last pointed at (a file and line, from Source, Diff or a point’s code reference), with why — to look there, or to start a point there. '
        + 'Use it when you were asked to review “the picked change” or to write a point “here”.',
      inputSchema: { type: 'object', properties: { ...PROJECT }, required: ['project'] },
    },
    {
      name: 'read_threads',
      description:
        'The review comments a change has received, as threads, read from the tracker now: each thread’s id, where it is (path:line, or the conversation), who said what, and on GitLab whether it is resolved. '
        + 'For the author of a change, before draft_reply. The ids it prints are what draft_reply takes.',
      inputSchema: { type: 'object', properties: { ...PROJECT, ...CHANGE }, required: ['project', 'change'] },
    },
    {
      name: 'draft_reply',
      description:
        'Draft a reply to one thread of review comments on a change the person authored, and what to change in the code for it. One reply per thread: a second draft for a thread replaces your own unsent one, never the person’s. '
        + 'The reply is posted only if the person posts it from the page; what to change is for them and is never posted.'
        + NOT_SENT,
      inputSchema: {
        type: 'object',
        properties: {
          ...PROJECT,
          ...CHANGE,
          thread: { type: 'string', description: 'The thread’s id, from read_threads.' },
          body: { type: 'string', description: `The reply, as it would be posted. Markdown. At most ${MAX_BODY} characters.` },
          todo: { type: 'string', description: 'What to change in the code for this thread, in a few plain lines; empty when nothing needs to change.' },
        },
        required: ['project', 'change', 'thread', 'body'],
      },
    },
  ]
}

const RUN_SCHEMA = { type: 'string', description: 'The review run’s id, as Factory named it: letters, digits and . _ : -, at most 80.' } as const

/** The contract's point metadata (C4), as an MCP schema. */
const META_SCHEMA = {
  type: 'object',
  description:
    'For a point a review run writes: who ruled what, and on which evidence. Shown to the person beside the comment; never posted. Leave out for an ordinary comment.',
  properties: {
    run: RUN_SCHEMA,
    severity: { type: 'string', enum: [...SEVERITIES] },
    evidence: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        properties: { kind: { type: 'string', enum: [...EVIDENCE_KINDS] }, ref: { type: 'string' }, quote: { type: 'string' } },
        required: ['kind', 'ref'],
      },
    },
    challenge: { type: 'string', description: 'The strongest honest case made against the point, if any.' },
    ruling: { type: 'string', enum: [...RULINGS] },
    reason: { type: 'string', description: 'The judge’s one-line reason.' },
    checklist: { type: 'array', items: { type: 'string' }, description: 'Checklist items the point bears on.' },
  },
  required: ['run', 'severity', 'evidence', 'ruling', 'reason'],
} as const

/** The change an agent means: a tracker URL, or the short spelling of one that already has a draft here. */
export function changeFor(projectPath: string | null, given: unknown): Target {
  if (typeof given !== 'string' || !given || given.length > 600) throw new Error(`Say which change, as its URL on the tracker. ${NOT_A_CHANGE}`)
  const direct = locate(given)
  if (direct) return direct
  const drafts = listDrafts(projectPath)
  if (!drafts.ok) throw new Error(drafts.error)
  const wanted = given.trim()
  const matches = drafts.value.filter((d) => spell(d.change) === wanted || keyOf(targetOf(d.change)) === wanted)
  if (matches.length === 1) return targetOf(matches[0]!.change)
  throw new Error(
    matches.length > 1
      ? `"${wanted.slice(0, 100)}" matches more than one draft here (${matches.map((d) => d.change.url).join(', ')}). Give the URL.`
      : `"${wanted.slice(0, 100)}" is not a tracker URL, and no draft in this project is filed under it. ${NOT_A_CHANGE}`,
  )
}

const need = <T,>(got: Got<T>): T => {
  if (!got.ok) throw new Error(got.error)
  return got.value
}

async function call(deps: Deps, name: string, args: Record<string, unknown>): Promise<string> {
  /* `project`, or `projectPath` as this door spelled it before the protocol agreed one name. */
  /* Whether this is a tool at all is settled before the project is. */
  if (!tools().some((tool) => tool.name === name)) throw new Error(`no tool "${name.slice(0, 60)}" here`)
  const at = await resolveDoorProject(args)
  if (!at.ok) throw new Error(at.why)
  const projectPath = at.path
  const followed = at.movedFrom ? `\n\n${DOOR_PROJECT_SAYS.followed(at.movedFrom, at.path)}` : ''
  return (await callAt(deps, name, args, projectPath)) + followed
}

async function callAt(deps: Deps, name: string, args: Record<string, unknown>, projectPath: string): Promise<string> {
  if (name === 'read_focus') return printFocus(focusOf(projectPath))

  if (name === 'list_reviews') {
    const drafts = need(listDrafts(projectPath))
    if (!drafts.length) return 'No draft reviews are kept in that project yet. add_comment or set_verdict on a change starts one.'
    return drafts
      .map((d) => {
        const waiting = d.comments.filter((c) => !c.sent).length
        return `${spell(d.change)} — ${d.change.url} — ${waiting} draft comment${waiting === 1 ? '' : 's'}, ${d.comments.length - waiting} sent, ${d.evidence.length} piece${d.evidence.length === 1 ? '' : 's'} of evidence, verdict proposed: ${d.verdict ?? 'none'}`
      })
      .join('\n')
  }

  const target = changeFor(projectPath, args.change)

  if (name === 'read_review') return printDraft(need(readDraftFor(projectPath, target)))

  if (name === 'read_change') {
    const { described, commits, more } = need(await readChange(deps, target))
    const [patch, who] = await Promise.all([diff(deps.run, target, { view: 'all', sha: described.head }), people(deps.run, target, described)])
    const files = patch.ok ? parseDiff(patch.value.text) : null
    const sum = files ? totals(files) : null
    return [
      `${spell(target)} — ${described.title}`,
      `${described.state}${described.draft ? ' (draft)' : ''}, by ${described.author || 'unknown'} — ${described.url}`,
      `Head commit: ${described.head}`,
      ...(described.description.trim()
        ? ['', 'Description:', ...described.description.trim().slice(0, 6000).split('\n').map((l) => `  ${l}`), ...(described.description.length > 6000 ? ['  (the rest of the description is not printed)'] : [])]
        : ['Description: (none)']),
      ...(who.ok ? printPeople(who.value) : [`Reviewers and approvals could not be read: ${who.error}`]),
      '',
      `Commits, oldest first (${commits.length}${more ? ', and there may be more than this app lists' : ''}):`,
      ...commits.map((c) => `${short(c.sha)}  ${c.title}  — ${c.author || 'unknown'}`),
      '',
      files && sum
        ? `Files in the whole change (${sum.files}, +${sum.added} −${sum.removed})${patch.ok && patch.value.truncated ? ' — the diff was too large to read whole, so this list may stop early' : ''}:\n${printFiles(files)}`
        : `The diff of the whole change could not be read: ${patch.ok ? '' : patch.error}`,
    ].join('\n')
  }

  if (name === 'read_diff') {
    const { described, commits, more } = need(await readChange(deps, target))
    const given = typeof args.commit === 'string' && args.commit ? args.commit : null
    const range: Range = given ? { view: 'commit', sha: need(resolveCommit(commits, given, more)).sha } : { view: 'all', sha: described.head }
    const patch = need(await diff(deps.run, target, range))
    const maxLines = typeof args.max_lines === 'number' && Number.isInteger(args.max_lines) && args.max_lines > 0 ? args.max_lines : undefined
    const path = str(args.path, MAX_PATH) ?? undefined
    return [
      range.view === 'all'
        ? `The whole change at head ${short(range.sha)}. To comment on a line here, call add_comment WITHOUT commit.`
        : `Commit ${short(range.sha)} alone (its parent to it). To comment on a line here, call add_comment with commit: "${short(range.sha)}".`,
      ...(patch.truncated ? ['This diff was too large to read whole and stops early.'] : []),
      printDiff(parseDiff(patch.text), { ...(path ? { path } : {}), ...(maxLines ? { maxLines } : {}) }),
    ].join('\n')
  }

  if (name === 'add_comment') {
    /* Checked first: a point with no evidence is refused before a subprocess is spent on it. */
    const meta = args.meta === undefined || args.meta === null ? undefined : check(metaOf(args.meta)).meta
    const commit = typeof args.commit === 'string' && args.commit ? args.commit : null
    const draft = need(
      await writeComment(
        deps,
        projectPath,
        target,
        /* An agent names no head for an all-changes comment: it means "the
           change as it is", and that is what it is checked against. */
        { view: commit ? 'commit' : 'all', commit, path: args.path, side: args.side, line: args.line, startLine: args.start_line, body: args.body },
        'agent',
        meta,
      ),
    )
    const added = draft.comments[draft.comments.length - 1]
    return `Drafted. It is not posted: the person will see it on the page and decide.\n${added ? printComment(added) : ''}`
  }

  if (name === 'reword_comment') {
    const body = bodyOf(args.body)
    if (!body.ok) throw new Error(body.error)
    need(changeDraft(projectPath, target, (draft) => rewordComment(draft, args.id, body.body, deps.now(), 'agent')))
    return 'Reworded. Still a draft; nothing was posted.'
  }

  if (name === 'drop_comment') {
    need(changeDraft(projectPath, target, (draft) => dropComment(draft, args.id, 'agent')))
    return 'Dropped from the draft. Nothing was posted or deleted on the tracker.'
  }

  if (name === 'set_verdict') {
    if (args.verdict === undefined && args.summary === undefined) throw new Error('Give a verdict, a summary, or both.')
    /* An agent may propose a verdict and may not clear one: `null` is the
       person's "I have not decided", and it is theirs to say. */
    if (args.verdict === null) throw new Error('A verdict is one of comment, approve, request-changes.')
    const draft = need(changeDraft(projectPath, target, (was) => setVerdict(was, args.verdict, args.summary, 'agent')))
    return `Proposed: verdict “${draft.verdict ?? 'none yet'}”${draft.summary.trim() ? `, with a summary of ${draft.summary.trim().length} characters` : ', no summary'}. The person can change either, and nothing is sent until they press Send.`
  }

  if (name === 'propose_review') {
    const input = check(proposalOf(args)).proposal
    /* Fail before spending a subprocess on a draft there is nowhere to keep. */
    need(readDraftFor(projectPath, target))
    const described = need(await describe(deps.run, target))
    const draft = need(changeDraft(projectPath, target, (was) => proposeReview(atHead(was, described.head), input, described.head, deps.now())))
    return [
      `Proposed by run ${input.run}, at head ${short(described.head)}: verdict “${input.verdict}”, ${input.door}${input.uiux ? ', touches what people see' : ''}, `
        + `${input.pathToSuccess.length} step${input.pathToSuccess.length === 1 ? '' : 's'} to approval.`,
      `It is kept beside the person’s summary and verdict, which are unchanged (verdict: ${draft.verdict ?? 'none yet'}). The person can take it, or not.`,
      'Nothing was posted.',
    ].join('\n')
  }

  if (name === 'drop_run_comments') {
    const run = runOf(args.run)
    if (!run) throw new Error(RUN_SAYS)
    let dropped = 0
    need(
      changeDraft(projectPath, target, (was) => {
        dropped = was.comments.filter((c) => replaceable(c, run!)).length
        return dropRunComments(was, run)
      }),
    )
    return `Dropped ${dropped} of run ${run}’s unsent comment${dropped === 1 ? '' : 's'}, with the evidence collected for them. The person’s comments, points the person kept, sent comments, other runs’ comments, the person’s evidence, the summary and the verdict were left as they were. Nothing was posted or deleted on the tracker.`
  }

  if (name === 'add_evidence') {
    const kind = PROOF_KINDS.find((k) => k === args.kind)
    if (!kind) throw new Error(`kind is one of ${PROOF_KINDS.join(', ')}.`)
    const caption = typeof args.caption === 'string' ? args.caption.trim() : ''
    if (!caption || caption.length > MAX_CAPTION || /[\n\r]/.test(caption)) throw new Error(`caption is one line of at most ${MAX_CAPTION} characters: what the evidence shows.`)
    const point = args.point === undefined || args.point === null || args.point === '' ? undefined : str(args.point, 40)
    if (point === null) throw new Error('point is the id of a point, from read_review.')
    const run = args.run === undefined || args.run === null || args.run === '' ? undefined : runOf(args.run)
    if (run === null) throw new Error(`run: ${RUN_SAYS}`)
    /* Fail before reading anything when there is nowhere to keep it. */
    need(readDraftFor(projectPath, target))
    const taken = takeEvidence(projectPath, kind, { path: args.path, text: args.text })
    if (!taken.ok) throw new Error(taken.error)
    const id = idWith(deps, 'e')
    const file = need(keepProofFile(projectPath, target, `${id}.${taken.extension}`, taken.bytes))
    const proof = { id, kind, caption, file, bytes: taken.bytes.length, ...(point ? { point } : {}), ...(run ? { run } : {}), by: 'agent' as const, at: deps.now() }
    const kept = changeDraft(projectPath, target, (was) => addProof(was, proof))
    if (!kept.ok) {
      forgetProof(projectPath, target, file)
      throw new Error(kept.error)
    }
    return `Kept as ${id} (${kind}, ${proof.bytes} bytes)${point ? ` on point ${point}` : ''}, in the review’s Evidence section. The person sees it on the page. Nothing was posted.`
  }

  if (name === 'read_review_md') {
    const got = need(reviewText(projectPath, target))
    return got.text === null ? `There is no review of ${spell(target)} in this project yet (${got.file} has not been written). add_comment, set_verdict or propose_review starts one.` : `${got.file}\n\n${got.text}`
  }

  if (name === 'read_threads') {
    const [found, described, me] = await Promise.all([readThreads(deps.run, target), describe(deps.run, target), login(deps.run, target)])
    const by = described.ok ? described.value.author : ''
    return [
      `The tracker is signed in as ${me ?? '(it would not say)'}; ${spell(target)} is by ${by || 'somebody it did not name'}.`,
      printThreads(spell(target), need(found)),
    ].join('\n')
  }

  if (name === 'draft_reply') {
    const thread = typeof args.thread === 'string' && THREAD.test(args.thread) ? args.thread : null
    if (!thread) throw new Error('thread is a thread’s id, as read_threads prints it.')
    const body = bodyOf(args.body)
    if (!body.ok) throw new Error(body.error)
    const todo = args.todo === undefined || args.todo === null ? '' : typeof args.todo === 'string' && args.todo.length <= MAX_BODY ? args.todo.trim() : null
    if (todo === null) throw new Error(`todo is text, at most ${MAX_BODY} characters.`)
    need(readDraftFor(projectPath, target))
    const found: Thread | undefined = need(await readThreads(deps.run, target)).find((one) => one.id === thread)
    if (!found) throw new Error(`There is no thread ${thread} on ${spell(target)} now. read_threads lists them.`)
    const first = found.notes[0]
    const last = found.notes[found.notes.length - 1]
    const reply = {
      id: idWith(deps, 'r'),
      thread,
      where: found.where.slice(0, 1020),
      from: (last?.author || first?.author || 'somebody').slice(0, 100),
      said: (last?.body ?? '').slice(0, MAX_SAID),
      body: body.body,
      todo,
      by: 'agent' as const,
      at: deps.now(),
    }
    need(changeDraft(projectPath, target, (was) => addReply(was, reply)))
    return `Drafted reply ${reply.id} to ${found.where} (${thread}). It is not posted: the person reads it on the page, edits it if they like, and posts it themselves.`
  }

  throw new Error(`no tool "${name.slice(0, 60)}" here`)
}

/** A refusal from a pure check, thrown as the sentence the agent reads. */
function check<T extends { ok: boolean }>(got: T): Extract<T, { ok: true }> {
  if (!got.ok) throw new Error((got as unknown as { error: string }).error)
  return got as Extract<T, { ok: true }>
}

const STATE_WORD: Record<People['reviewers'][number]['state'], string> = { requested: 'asked', approved: 'approved', changes: 'changes requested', commented: 'commented' }

/** Who reviews a change and who approved it, as two lines for an agent. */
export function printPeople(who: People): string[] {
  const { by, required, left } = who.approvals
  const needed = [required !== undefined ? `${required} required` : '', left !== undefined ? `${left} still needed` : ''].filter(Boolean).join(', ')
  return [
    `Reviewers: ${who.reviewers.length ? who.reviewers.map((r) => `${r.login} (${STATE_WORD[r.state]})`).join(', ') : 'none asked'}`,
    `Approvals: ${by.length ? `${by.length} — ${by.join(', ')}` : 'none'}${needed ? ` — ${needed}` : ''}`,
  ]
}

interface Rpc {
  id?: number | string
  method?: string
  params?: { name?: string; arguments?: Record<string, unknown> }
}

async function mcp(deps: Deps, rpc: Rpc): Promise<Reply> {
  const reply = (result: unknown): Reply => ({ status: 200, body: { jsonrpc: '2.0', id: rpc.id ?? null, result } })
  const text = (s: string, isError = false) => reply({ content: [{ type: 'text', text: s }], ...(isError ? { isError } : {}) })

  if (rpc.method === 'initialize') {
    return reply({
      protocolVersion: '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: ID, version: VERSION },
      instructions: MANIFEST.mcp?.about ?? '',
    })
  }
  /* A notification carries no id and is answered with nothing. */
  if (typeof rpc.method === 'string' && rpc.method.startsWith('notifications/')) return { status: 202, body: null }
  if (rpc.method === 'tools/list') return reply({ tools: tools() })
  if (rpc.method === 'tools/call') {
    try {
      const args = rpc.params?.arguments
      return text(await call(deps, String(rpc.params?.name ?? ''), args && typeof args === 'object' ? args : {}))
    } catch (e) {
      /* A refusal is an answer the agent reads, not a transport failure it retries. */
      return text(e instanceof Error ? e.message : String(e), true)
    }
  }
  return { status: 404, body: { jsonrpc: '2.0', id: rpc.id ?? null, error: { code: -32601, message: String(rpc.method).slice(0, 100) } } }
}

/* ------------------------------------------------------------------ *
 * The doors
 * ------------------------------------------------------------------ */

export async function answer(
  method: string,
  path: string,
  query: URLSearchParams,
  body: Record<string, unknown> | null,
  ticket: string | null,
  deps: Deps = REAL,
): Promise<Reply | null> {
  if (path === '/healthz') {
    return ok({ id: ID, version: VERSION, where: `<project>/${KEHIKOT_DIR}/review/<change>.md`, patchesHeld: held() })
  }

  if (path === '/mcp') {
    if (method !== 'POST') return bad('the MCP door takes POST', 405)
    if (!body || typeof body.method !== 'string') {
      return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'not a request' } } }
    }
    return mcp(deps, body as Rpc)
  }

  /* The Claude Code skills this module offers (`declares.skills`), with this origin filled in. */
  if (method === 'GET') {
    const skill = skillAt(path)
    if (skill) return { status: 200, body: null, raw: { bytes: skill.text, type: 'text/markdown; charset=utf-8' } }
  }

  if (!path.startsWith('/api/')) return null

  /* Factory's send is answered by its own middleware (factory/door.ts), which reads the key from a
     header this function is never given. Here it is not a route at all: not for the page's ticket,
     not for anything else. */
  if (path === '/api/factory' || path.startsWith('/api/factory/')) return bad('not here', 404)

  /* ---- reads: ungated. They show nothing the person's own `gh` would not. ---- */

  if (method === 'GET') {
    const url = query.get('url')
    const target = locate(url && url.length <= 600 ? url : null)
    if (!target) return bad(NOT_A_CHANGE)

    if (path === '/api/change') {
      const change = await readChange(deps, target)
      if (!change.ok) return bad(change.error, 502)
      return ok({ target, ref: spell(target), ...change.value.described, commits: change.value.commits, more: change.value.more })
    }

    if (path === '/api/draft') {
      const asked = query.get('projectPath')
      const at = asked?.trim() ? await resolveDoorProject(asked) : null
      if (at && !at.ok) return bad(at.why)
      const draft = readDraftFor(at ? at.path : asked, target)
      return draft.ok ? ok({ draft: draft.value, ...(at?.movedFrom ? { said: DOOR_PROJECT_SAYS.followed(at.movedFrom, at.path) } : {}) }) : bad(draft.error)
    }

    if (path === '/api/login') return ok({ login: await login(deps.run, target) })

    /* One piece of evidence's file, for the page to show: read from the review's own folder, by the
       name the review gives it, and sent as what it is — a picture or plain text, never a page. */
    if (path === '/api/evidence') {
      const asked = query.get('projectPath')
      const at = asked?.trim() ? await resolveDoorProject(asked) : null
      if (at && !at.ok) return bad(at.why)
      const projectPath = at ? at.path : asked
      const draft = readDraftFor(projectPath, target)
      if (!draft.ok) return bad(draft.error)
      const proof = draft.value.evidence.find((p) => p.id === query.get('id'))
      if (!proof) return bad('There is no such evidence in this review.', 404)
      const bytes = readProofFile(projectPath, target, proof.file)
      if (!bytes.ok) return bad(bytes.error, 404)
      return {
        status: 200,
        body: null,
        raw: { bytes: bytes.value, type: mimeOf(proof.file) },
        headers: { 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; sandbox" },
      }
    }

    /* The Before / after view: images from the description and the conversation, judged by
       `shotsOf` (https on the forge's own hosts only). Nothing is fetched but the text. */
    if (path === '/api/shots') {
      const [described, said] = await Promise.all([describe(deps.run, target), notes(deps.run, target)])
      if (!described.ok) return bad(described.error, 502)
      const sources = [
        { where: 'the description', text: described.value.description },
        ...(said.ok ? said.value.map((note) => ({ where: `a comment by ${note.author || 'somebody'}`, text: note.body })) : []),
      ]
      return ok({ shots: shotsOf(target, sources), ...(said.ok ? {} : { unread: `The comments could not be read, so only the description was looked in: ${said.error}` }) })
    }

    return bad('not here', 404)
  }

  /* ---- writes: every one of them wants this page's ticket, checked before
     anything about the request is even read. ---- */

  if (method !== 'POST') return bad('not here', 404)
  const refused = refuseTicket(ticket, TICKET, NO_TICKET)
  if (refused) return refused
  if (!body) return bad('that was not a request')

  const target = locate(str(body.url, 600))
  if (!target) return bad(NOT_A_CHANGE)
  /* The folder the page names is put to the host; only the path it vouches for is written under. */
  const named = str(body.projectPath, 4096)
  const at = named?.trim() ? await resolveDoorProject(named) : null
  if (at && !at.ok) return bad(at.why)
  const projectPath = at ? at.path : named
  const said = at?.movedFrom ? { said: DOOR_PROJECT_SAYS.followed(at.movedFrom, at.path) } : {}
  const wrote = (got: Got<Draft>): Reply => (got.ok ? ok({ draft: got.value, ...said }) : bad(got.error))

  if (path === '/api/comment') {
    const view = body.view === 'commit' ? 'commit' : body.view === 'all' ? 'all' : null
    if (!view) return bad('view is "all" or "commit".')
    return wrote(
      await writeComment(
        deps,
        projectPath,
        target,
        { view, commit: str(body.commit, 64), path: body.path, side: body.side, line: body.line, startLine: body.startLine, body: body.body },
        'person',
      ),
    )
  }

  if (path === '/api/comment/reword') {
    const words = bodyOf(body.body)
    if (!words.ok) return bad(words.error)
    return wrote(changeDraft(projectPath, target, (draft) => rewordComment(draft, body.id, words.body, deps.now())))
  }

  if (path === '/api/comment/drop') return wrote(changeDraft(projectPath, target, (draft) => dropComment(draft, body.id)))

  /* The person keeps an agent's point: from now on it is theirs, and their send may post it. */
  if (path === '/api/comment/keep') return wrote(changeDraft(projectPath, target, (draft) => keepComment(draft, body.id, deps.now())))

  if (path === '/api/comment/resolve') {
    if (typeof body.resolved !== 'boolean') return bad('resolved is true or false.')
    return wrote(changeDraft(projectPath, target, (draft) => resolveComment(draft, body.id, body.resolved as boolean, deps.now())))
  }

  if (path === '/api/evidence/drop') return wrote(changeDraft(projectPath, target, (draft) => dropProof(draft, body.id)))

  /* What the page has open and where somebody last pointed, for `read_focus`. In memory: it is now, not a record. */
  if (path === '/api/focus') {
    if (!projectPath) return bad('A focus belongs to a project.')
    const kept = keepFocus(projectPath, target, body, deps.now())
    return kept ? bad(kept) : ok({})
  }

  if (path === '/api/reply/reword') {
    const words = bodyOf(body.body)
    if (!words.ok) return bad(words.error)
    const todo = body.todo === undefined ? undefined : typeof body.todo === 'string' && body.todo.length <= MAX_BODY ? body.todo : null
    if (todo === null) return bad('What to change is text.')
    return wrote(changeDraft(projectPath, target, (draft) => rewordReply(draft, body.id, words.body, todo, deps.now())))
  }

  if (path === '/api/reply/drop') return wrote(changeDraft(projectPath, target, (draft) => dropReply(draft, body.id)))

  if (path === '/api/reply/send') return sendReply(deps, projectPath, target, body)

  if (path === '/api/verdict') return wrote(changeDraft(projectPath, target, (draft) => setVerdict(draft, body.verdict, body.summary)))

  /* The person takes a run's proposed summary or verdict into their own: their press, their words. */
  if (path === '/api/proposal/take') {
    const which = body.which === 'summary' || body.which === 'verdict' ? body.which : null
    if (!which) return bad('Take the summary or the verdict.')
    return wrote(changeDraft(projectPath, target, (draft) => takeProposal(draft, which, body.run, deps.now())))
  }

  if (path === '/api/send') return send(deps, projectPath, target, body)

  /* An unknown path under /api/ is ours to refuse, not Vite's to serve as a file. */
  return bad('not here', 404)
}

export { MANIFEST }
