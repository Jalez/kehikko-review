import { KEHIKOT_DIR } from 'kehikot-module-protocol'

import { locate, type Target } from './forge/locate.ts'
import { commits as readCommits, describe, diff, held, isSha, login, type Commit, type Described, type Range } from './forge/read.ts'
import { run as realRun, type Runner } from './forge/run.ts'
import { ID, MANIFEST, VERSION } from './manifest.ts'
import { anchor } from './review/anchor.ts'
import { addComment, bodyOf, dropComment, logSend, rewordComment, setVerdict, stamp } from './review/draft.ts'
import { keyOf } from './review/key.ts'
import { DEFAULT_DIFF_LINES, MAX_DIFF_LINES, printComment, printDiff, printDraft, printFiles } from './review/print.ts'
import { execute, gather, plan, type Report } from './review/send.ts'
import { MAX_BODY, MAX_PATH, MAX_SUMMARY, short, spell, targetOf, type By, type Draft, type Side, type View } from './review/shape.ts'
import { parseDiff, totals } from './src/diff/parse.ts'
import { changeDraft, listDrafts, readDraftFor } from './store.ts'

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
 * Minted per process and printed into `/app` (see `page/document.ts`), so only
 * this app's own page holds it. Loopback is a fence around the machine, not
 * around the programs on it: without this, any page in the browser that found
 * the port could post a review in the person's name. Reads are ungated, and
 * `/mcp` is ungated because an agent has no page to have been handed a ticket
 * by — which is exactly why `/mcp` cannot send.
 */
export const TICKET = crypto.randomUUID()

/** The header the page sends the ticket in. */
export const TICKET_HEADER = 'x-module-ticket'

export interface Reply {
  status: number
  /** `null` means "answer with no body", which is what a notification gets. */
  body: unknown
}

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

const REAL: Deps = {
  run: realRun,
  now: () => new Date().toISOString(),
  /* Short enough to read aloud to an agent and unique enough for one draft:
     48 bits against a ceiling of a few hundred comments. */
  id: () => `c-${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`,
}

const ok = (body: Record<string, unknown>): Reply => ({ status: 200, body: { ok: true, ...body } })
const bad = (why: string, status = 400): Reply => ({ status, body: { ok: false, error: why } })

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
async function writeComment(deps: Deps, projectPath: string | null, target: Target, input: CommentInput, by: By): Promise<Got<Draft>> {
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

  const written = changeDraft(projectPath, target, (draft) =>
    addComment(draft, { view: input.view, commit: range.sha, ...(parent ? { parent } : {}), anchor: placed.anchor }, body.body, by, deps.now(), deps.id()),
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

async function send(deps: Deps, projectPath: string | null, target: Target, body: Record<string, unknown>): Promise<Reply> {
  const lock = `${projectPath ?? ''}|${keyOf(target)}`
  if (sending.has(lock)) return bad('A send for this change is already under way. Wait for it to finish.', 409)
  sending.add(lock)
  try {
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
    const unsentIds = new Set(draft.comments.filter((c) => !c.sent).map((c) => c.id))
    const strangers = ids.filter((id) => !unsentIds.has(id))
    const CHANGED = 'The draft changed after you looked at it, so nothing was sent. Read what it says now and confirm again.'
    if (strangers.length || body.verdict !== draft.verdict || body.summary !== draft.summary) return bad(CHANGED, 409)

    const facts = await gather(deps.run, target, draft)
    if (!facts.ok) return bad(`Nothing was sent. The change could not be read just before sending: ${facts.error}`, 502)
    const made = plan(target, draft, facts.value, ids)
    if (!made.ok) return bad(made.error)

    const save = (change: (was: Draft) => Draft) => changeDraft(projectPath, target, (was) => ({ ok: true, draft: change(was) }))
    const report: Report = await execute(deps.run, target, made.plan, draft, {
      stamp: (which, sent) => void save((was) => stamp(was, which, sent)),
      summarySent: () => {
        /* Cleared the moment it is posted, not at the end: if the approval
           after it fails, pressing Send again must not post the summary twice. */
        void save((was) => ({ ...was, summary: '' }))
      },
      now: deps.now,
    })

    /* The history is written whenever anything reached the tracker, including
       a send that stopped half way: that is when a record matters most. */
    const reached = report.posted.length + report.folded.length > 0 || report.summarySent || report.verdictSent
    const after = save((was) => {
      const settled = report.complete ? { ...was, verdict: null } : was
      return reached
        ? logSend(
            settled,
            { at: deps.now(), verdict: made.plan.verdict, head: made.plan.head, comments: report.posted.length + report.folded.length, summary: draft.summary.slice(0, MAX_SUMMARY), notes: report.notes },
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
  } finally {
    sending.delete(lock)
  }
}

/* ------------------------------------------------------------------ *
 * The MCP door, for agents
 * ------------------------------------------------------------------ */

const PROJECT = {
  projectPath: {
    type: 'string',
    description:
      `The absolute directory of the project. Required: drafts are kept inside the project, at <projectPath>/${KEHIKOT_DIR}/review/, so this is the address of the file and not a filter.`,
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

function tools() {
  return [
    {
      name: 'list_reviews',
      description: 'The draft reviews kept in a project: one line per pull or merge request, with how many comments are waiting and the verdict proposed.' + NOT_SENT,
      inputSchema: { type: 'object', properties: { ...PROJECT }, required: ['projectPath'] },
    },
    {
      name: 'read_review',
      description:
        'The draft review of one change: every comment with its id, file, line, side, the commit whose diff it was written against, who wrote it and whether it has been sent; the summary; the proposed verdict.'
        + NOT_SENT,
      inputSchema: { type: 'object', properties: { ...PROJECT, ...CHANGE }, required: ['projectPath', 'change'] },
    },
    {
      name: 'read_change',
      description:
        'What a pull or merge request is, read from the tracker now: title, state, author, head commit, its commits oldest first (id, title, author), and the files the whole change touches with added and removed counts. '
        + 'Start here; the commit ids it prints are what read_diff and add_comment take.',
      inputSchema: { type: 'object', properties: { ...PROJECT, ...CHANGE }, required: ['projectPath', 'change'] },
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
        required: ['projectPath', 'change'],
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
        },
        required: ['projectPath', 'change', 'path', 'line', 'body'],
      },
    },
    {
      name: 'reword_comment',
      description: 'Replace the words of a draft comment, by its id from read_review. Its anchor does not move. A comment that has been sent cannot be reworded.' + NOT_SENT,
      inputSchema: {
        type: 'object',
        properties: { ...PROJECT, ...CHANGE, id: { type: 'string', description: 'The comment’s id.' }, body: { type: 'string', description: 'The new words.' } },
        required: ['projectPath', 'change', 'id', 'body'],
      },
    },
    {
      name: 'drop_comment',
      description: 'Remove a draft comment, by its id from read_review. A comment that has been sent cannot be dropped from here.' + NOT_SENT,
      inputSchema: { type: 'object', properties: { ...PROJECT, ...CHANGE, id: { type: 'string', description: 'The comment’s id.' } }, required: ['projectPath', 'change', 'id'] },
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
        required: ['projectPath', 'change'],
      },
    },
  ]
}

/** The change an agent means: a tracker URL, or the short spelling of one that already has a draft here. */
function changeFor(projectPath: string | null, given: unknown): Target {
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
  const projectPath = typeof args.projectPath === 'string' ? args.projectPath : null

  if (name === 'list_reviews') {
    const drafts = need(listDrafts(projectPath))
    if (!drafts.length) return 'No draft reviews are kept in that project yet. add_comment or set_verdict on a change starts one.'
    return drafts
      .map((d) => {
        const waiting = d.comments.filter((c) => !c.sent).length
        return `${spell(d.change)} — ${d.change.url} — ${waiting} draft comment${waiting === 1 ? '' : 's'}, ${d.comments.length - waiting} sent, verdict proposed: ${d.verdict ?? 'none'}`
      })
      .join('\n')
  }

  const target = changeFor(projectPath, args.change)

  if (name === 'read_review') return printDraft(need(readDraftFor(projectPath, target)))

  if (name === 'read_change') {
    const { described, commits, more } = need(await readChange(deps, target))
    const patch = await diff(deps.run, target, { view: 'all', sha: described.head })
    const files = patch.ok ? parseDiff(patch.value.text) : null
    const sum = files ? totals(files) : null
    return [
      `${spell(target)} — ${described.title}`,
      `${described.state}${described.draft ? ' (draft)' : ''}, by ${described.author || 'unknown'} — ${described.url}`,
      `Head commit: ${described.head}`,
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
      ),
    )
    const added = draft.comments[draft.comments.length - 1]
    return `Drafted. It is not posted: the person will see it on the page and decide.\n${added ? printComment(added) : ''}`
  }

  if (name === 'reword_comment') {
    const body = bodyOf(args.body)
    if (!body.ok) throw new Error(body.error)
    need(changeDraft(projectPath, target, (draft) => rewordComment(draft, args.id, body.body, deps.now())))
    return 'Reworded. Still a draft; nothing was posted.'
  }

  if (name === 'drop_comment') {
    need(changeDraft(projectPath, target, (draft) => dropComment(draft, args.id)))
    return 'Dropped from the draft. Nothing was posted or deleted on the tracker.'
  }

  if (name === 'set_verdict') {
    if (args.verdict === undefined && args.summary === undefined) throw new Error('Give a verdict, a summary, or both.')
    /* An agent may propose a verdict and may not clear one: `null` is the
       person's "I have not decided", and it is theirs to say. */
    if (args.verdict === null) throw new Error('A verdict is one of comment, approve, request-changes.')
    const draft = need(changeDraft(projectPath, target, (was) => setVerdict(was, args.verdict, args.summary)))
    return `Proposed: verdict “${draft.verdict ?? 'none yet'}”${draft.summary.trim() ? `, with a summary of ${draft.summary.trim().length} characters` : ', no summary'}. The person can change either, and nothing is sent until they press Send.`
  }

  throw new Error(`no tool "${name.slice(0, 60)}" here`)
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
    return ok({ id: ID, version: VERSION, where: `<project>/${KEHIKOT_DIR}/review/<change>.json`, patchesHeld: held() })
  }

  if (path === '/mcp') {
    if (method !== 'POST') return bad('the MCP door takes POST', 405)
    if (!body || typeof body.method !== 'string') {
      return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'not a request' } } }
    }
    return mcp(deps, body as Rpc)
  }

  if (!path.startsWith('/api/')) return null

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

    if (path === '/api/diff') {
      const sha = query.get('sha') ?? ''
      const view = query.get('view')
      if (view !== 'all' && view !== 'commit') return bad('view is "all" or "commit".')
      if (!isSha(sha)) return bad('sha is the commit the diff is read at: the head for the whole change, or the commit itself.')
      const patch = await diff(deps.run, target, { view, sha })
      return patch.ok ? ok({ ...patch.value }) : bad(patch.error, 502)
    }

    if (path === '/api/draft') {
      const draft = readDraftFor(query.get('projectPath'), target)
      return draft.ok ? ok({ draft: draft.value }) : bad(draft.error)
    }

    if (path === '/api/login') return ok({ login: await login(deps.run, target) })

    return bad('not here', 404)
  }

  /* ---- writes: every one of them wants this page's ticket, checked before
     anything about the request is even read. ---- */

  if (method !== 'POST') return bad('not here', 404)
  if (ticket !== TICKET) return bad('that press did not come from this app’s own page', 403)
  if (!body) return bad('that was not a request')

  const target = locate(str(body.url, 600))
  if (!target) return bad(NOT_A_CHANGE)
  const projectPath = str(body.projectPath, 4096)
  const wrote = (got: Got<Draft>): Reply => (got.ok ? ok({ draft: got.value }) : bad(got.error))

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

  if (path === '/api/verdict') return wrote(changeDraft(projectPath, target, (draft) => setVerdict(draft, body.verdict, body.summary)))

  if (path === '/api/send') return send(deps, projectPath, target, body)

  /* An unknown path under /api/ is ours to refuse, not Vite's to serve as a file. */
  return bad('not here', 404)
}

export { MANIFEST }
