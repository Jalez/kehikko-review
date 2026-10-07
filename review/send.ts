import type { Target } from '../forge/locate.ts'
import { commits as readCommits, describe, ghApi, glabApi, isSha, type Read } from '../forge/read.ts'
import type { Ran, Run, Runner } from '../forge/run.ts'

import { short, type Comment, type Draft, type Sent, type Verdict } from './shape.ts'

/**
 * Sending a draft: a PLAN that is pure, and an EXECUTOR that is the only thing
 * here that talks to a tracker.
 *
 * ## Why two halves
 *
 * What gets posted under somebody's name should be decidable by reading a
 * value. `plan` turns a draft and a few facts about the change into the exact
 * requests — path and JSON body — and does nothing else, so a test can assert
 * on every byte that would leave this machine without anything leaving it.
 * `execute` runs those requests through a `Runner`; the tests give it a fake,
 * and no test and no build step has ever given it the real one.
 *
 * ## The hard part: which commit, which side, which line
 *
 * A comment is anchored in a FRAME (`shape.ts`): the whole change's diff at a
 * head, or one commit's own diff. A tracker accepts a comment only where it
 * can find the line in a diff IT computes. Mapping one to the other is the
 * job, and it differs per tracker.
 *
 * ### GitHub
 *
 * A review carries one `commit_id`, and a comment in it is a `(side, line)`
 * that must lie inside the pull request's diff as of that commit — the diff
 * from the merge base to `commit_id`, NOT that commit's own diff. `RIGHT` is
 * the file at `commit_id`; `LEFT` is the file at the merge base.
 *
 * - all-changes comment at head H: `(H, RIGHT|LEFT, line)`. That is the frame
 *   it was written in, exactly.
 * - commit-view comment on the NEW side of commit C: line L is line L of the
 *   file at C, so `(C, RIGHT, L)`.
 * - commit-view comment on the OLD side of C (something C removed): that line
 *   exists in C's parent P and nowhere at C. `(C, LEFT, L)` would be line L of
 *   the merge base — a different file unless P IS the merge base. So: when P is
 *   itself a commit of the pull request, the line is `(P, RIGHT, L)`, the file
 *   as it stood just before C; when P is not (C is the first commit, so P is
 *   the merge base), it is `(C, LEFT, L)`.
 *
 * And then GitHub only takes lines INSIDE its diff for that commit_id. A line
 * C touched is usually in merge-base..C too, but not always: a commit that
 * restores a line to what the base had leaves it out of the cumulative diff,
 * and a line C removed that the base already had is not in merge-base..P at
 * all. Those comments are correct and cannot be placed. GitHub answers 422 for
 * the whole review, and the comments are not lost: they are FOLDED — written
 * into the final review's body as text, with the path, the line, the commit
 * and the quoted source — and marked `folded` so the page can say that they
 * went out, and where.
 *
 * Reviews for commits other than the head go first, as plain `COMMENT`
 * reviews; the final review is at the head and carries the verdict, the
 * summary, the head's own comments and anything folded. The verdict goes LAST
 * so that an approval is never on the tracker while half the reasons are not.
 *
 * ### GitLab
 *
 * No batch: one discussion per comment, each with a `position` naming three
 * commits and the line. For an all-changes comment the three are the merge
 * request's `diff_refs` (or those of the older diff version it was written
 * against). For a commit-view comment they are `(parent, parent, commit)`
 * with `commit_id` beside them, which is how GitLab's own page files a comment
 * made while looking at one commit. An unchanged line needs both numbers; an
 * added line only the new, a removed line only the old. A multi-line comment
 * is anchored at its LAST line — `line_range` wants a line code per end, a
 * hash this app would have to reimplement — and the quote in the draft still
 * shows the whole range.
 *
 * The summary is a note. `approve` is its own call, pinned to the head sha so
 * GitLab refuses (409) if somebody pushed in the meantime. "Request changes"
 * has no REST call this app can rely on across the GitLab versions in use, so
 * the note is prefixed to say so and the result says plainly that GitLab was
 * not asked to set a reviewer state.
 */

/** What has to be known about the change at the moment of sending. Read fresh; see `gather`. */
export interface Facts {
  head: string
  base: string
  start: string
  /** The change's commits, with parents: what decides how an old-side commit comment maps on GitHub. */
  commits: { sha: string; parents: string[] }[]
  /** GitLab's earlier diff versions, read only when a comment was written against an older head. */
  versions?: { head: string; base: string; start: string }[]
}

/** One comment as a tracker wants it, with the draft id it came from so it can be stamped. */
export interface Inline {
  id: string
  payload: Record<string, unknown>
}

export type GithubEvent = 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT'

export type Step =
  /** A `COMMENT` review at a commit that is not the head. */
  | { kind: 'github-review'; path: string; commitId: string; inline: Inline[] }
  /** The review at the head: verdict, summary, the head's comments, and whatever was folded on the way. */
  | { kind: 'github-final'; path: string; commitId: string; event: GithubEvent; summary: string; inline: Inline[] }
  | { kind: 'gitlab-thread'; path: string; inline: Inline }
  /** The summary as a note, with whatever was folded. `prefix` is how "request changes" is said. */
  | { kind: 'gitlab-note'; path: string; summary: string; prefix: string }
  | { kind: 'gitlab-approve'; path: string; payload: { sha: string } }

export interface Plan {
  forge: Target['forge']
  verdict: Verdict
  head: string
  steps: Step[]
  /** Comments known in advance to have no place on the tracker, with why. They go straight into the summary. */
  fold: { id: string; why: string }[]
  /** The ids this plan sends, in order. Exactly the unsent comments that were asked for. */
  ids: string[]
}

export type Planned = { ok: true; plan: Plan } | { ok: false; error: string }

const GITHUB_EVENT: Record<Verdict, GithubEvent> = { approve: 'APPROVE', 'request-changes': 'REQUEST_CHANGES', comment: 'COMMENT' }

/** How GitLab is told changes are wanted: in words, at the top of the note, since there is no state to set. */
export const CHANGES_REQUESTED = '**Changes requested.**'

/* ------------------------------------------------------------------ *
 * Placing one comment
 * ------------------------------------------------------------------ */

const parentOf = (comment: Comment, facts: Facts): string | null =>
  comment.parent ?? facts.commits.find((c) => c.sha === comment.commit)?.parents[0] ?? null

/** Where GitHub should be told a comment is. See the essay at the top for why each branch is what it is. */
export function githubPlace(comment: Comment, facts: Facts): { commitId: string; side: 'RIGHT' | 'LEFT' } {
  if (comment.view === 'all') return { commitId: comment.commit, side: comment.side === 'new' ? 'RIGHT' : 'LEFT' }
  if (comment.side === 'new') return { commitId: comment.commit, side: 'RIGHT' }
  const parent = parentOf(comment, facts)
  const parentIsInTheChange = parent !== null && facts.commits.some((c) => c.sha === parent)
  return parentIsInTheChange ? { commitId: parent, side: 'RIGHT' } : { commitId: comment.commit, side: 'LEFT' }
}

function githubInline(comment: Comment, side: 'RIGHT' | 'LEFT'): Inline {
  return {
    id: comment.id,
    payload: {
      path: comment.path,
      line: comment.line,
      side,
      /* Both ends of a range are on one side here: the anchoring rule only
         ever makes a range within one column of one hunk. */
      ...(comment.startLine !== undefined ? { start_line: comment.startLine, start_side: side } : {}),
      body: comment.body,
    },
  }
}

function gitlabInline(comment: Comment, facts: Facts): Inline | { fold: string } {
  let refs: { base: string; start: string; head: string }
  let commitId: string | undefined
  if (comment.view === 'all') {
    if (comment.commit === facts.head) refs = { base: facts.base, start: facts.start, head: facts.head }
    else {
      /* Written against a head the merge request has since moved past. Its
         line numbers are from THAT diff, so it must be filed against that
         diff's three commits or not placed at all — never against today's,
         where the same numbers are other lines. */
      const version = facts.versions?.find((v) => v.head === comment.commit)
      if (!version) return { fold: `it was written against ${short(comment.commit)}, a version of the merge request GitLab no longer lists` }
      refs = version
    }
  } else {
    const parent = parentOf(comment, facts)
    if (!parent) return { fold: `the parent of ${short(comment.commit)} is not known, and a position on one commit’s diff needs it` }
    refs = { base: parent, start: parent, head: comment.commit }
    commitId = comment.commit
  }
  /* Which numbers to send is decided by what kind of line it is, as GitLab's
     documentation puts it: added — new only; removed — old only; unchanged —
     both. `otherLine` is present exactly when the line is unchanged. */
  const lines =
    comment.otherLine !== undefined
      ? comment.side === 'new'
        ? { new_line: comment.line, old_line: comment.otherLine }
        : { old_line: comment.line, new_line: comment.otherLine }
      : comment.side === 'new'
        ? { new_line: comment.line }
        : { old_line: comment.line }
  return {
    id: comment.id,
    payload: {
      body: comment.body,
      ...(commitId ? { commit_id: commitId } : {}),
      position: {
        position_type: 'text',
        base_sha: refs.base,
        start_sha: refs.start,
        head_sha: refs.head,
        old_path: comment.oldPath ?? comment.path,
        new_path: comment.path,
        ...lines,
      },
    },
  }
}

/* ------------------------------------------------------------------ *
 * The plan
 * ------------------------------------------------------------------ */

const gitlabProject = (target: Target) => `projects/${encodeURIComponent(target.repo)}/merge_requests/${target.number}`

/**
 * The requests that sending this draft would make. Pure.
 *
 * `ids` is what the person was shown in the confirmation. Only those are sent,
 * and only the ones still unsent: a comment an agent added between the two
 * presses is not swept along, and a comment already on the tracker is never
 * posted a second time however often Send is pressed.
 */
export function plan(target: Target, draft: Draft, facts: Facts, ids?: readonly string[]): Planned {
  const verdict = draft.verdict
  if (!verdict) return { ok: false, error: 'Choose a verdict first: comment, approve or request changes.' }

  const wanted = ids ? new Set(ids) : null
  const sending = draft.comments.filter((c) => !c.sent && (wanted === null || wanted.has(c.id)))
  const summary = draft.summary.trim()

  if (!sending.length && !summary && verdict === 'comment') {
    return { ok: false, error: 'There is nothing to send: no unsent comments, no summary, and no verdict beyond “comment”.' }
  }

  const fold: Plan['fold'] = []
  const steps: Step[] = []

  if (target.forge === 'github') {
    /* GitHub's own rule, said here rather than learned from a 422 after the
       per-commit reviews have already gone out. */
    if (verdict === 'request-changes' && !summary) {
      return { ok: false, error: 'GitHub does not accept a request for changes without a summary saying what should change. Write one first.' }
    }
    const path = `repos/${target.repo}/pulls/${target.number}/reviews`
    const groups = new Map<string, Inline[]>()
    for (const comment of sending) {
      const place = githubPlace(comment, facts)
      const group = groups.get(place.commitId) ?? []
      group.push(githubInline(comment, place.side))
      groups.set(place.commitId, group)
    }
    /* Oldest commit first, the order the change was written in. A commit the
       change no longer lists (a head from before a force-push) goes before
       them all: it is the oldest thing here in every sense that matters. */
    const order = (sha: string) => facts.commits.findIndex((c) => c.sha === sha)
    const others = [...groups.keys()].filter((sha) => sha !== facts.head).sort((a, b) => order(a) - order(b))
    for (const commitId of others) steps.push({ kind: 'github-review', path, commitId, inline: groups.get(commitId)! })
    steps.push({ kind: 'github-final', path, commitId: facts.head, event: GITHUB_EVENT[verdict], summary, inline: groups.get(facts.head) ?? [] })
  } else {
    const base = gitlabProject(target)
    for (const comment of sending) {
      const made = gitlabInline(comment, facts)
      if ('fold' in made) fold.push({ id: comment.id, why: made.fold })
      else steps.push({ kind: 'gitlab-thread', path: `${base}/discussions`, inline: made })
    }
    steps.push({ kind: 'gitlab-note', path: `${base}/notes`, summary, prefix: verdict === 'request-changes' ? CHANGES_REQUESTED : '' })
    /* Last, and pinned to the head that was just read: an approval is of
       particular commits, and GitLab answers 409 rather than approve ones
       pushed since. */
    if (verdict === 'approve') steps.push({ kind: 'gitlab-approve', path: `${base}/approve`, payload: { sha: facts.head } })
  }

  return { ok: true, plan: { forge: target.forge, verdict, head: facts.head, steps, fold, ids: sending.map((c) => c.id) } }
}

/* ------------------------------------------------------------------ *
 * Folding
 * ------------------------------------------------------------------ */

/**
 * A comment the tracker would not put on its line, as text for the summary.
 *
 * Everything a reader needs to find the place by hand: the file, the line (or
 * range) and which column it is from, the commit whose diff it was written
 * against, and the source itself, quoted. Then the comment.
 */
export function foldText(comment: Comment): string {
  const lines = comment.startLine !== undefined ? `lines ${comment.startLine}–${comment.line}` : `line ${comment.line}`
  const where = comment.view === 'all' ? `in the whole change at \`${short(comment.commit)}\`` : `in commit \`${short(comment.commit)}\``
  const quote = comment.quote
    ? `${comment.quote
        .split('\n')
        .slice(0, 12)
        .map((line) => `> \`${line.slice(0, 200).replace(/`/g, 'ˋ')}\``)
        .join('\n')}\n\n`
    : ''
  return `**\`${comment.path}\`, ${lines}** (${comment.side === 'old' ? 'old side, removed' : 'new side'}) ${where}\n\n${quote}${comment.body}`
}

/** The body of the final review or note: the summary, then every folded comment, each under a rule. */
export function composeBody(summary: string, folded: readonly Comment[], prefix = ''): string {
  const parts: string[] = []
  const head = [prefix, summary.trim()].filter(Boolean).join('\n\n')
  if (head) parts.push(head)
  if (folded.length) {
    parts.push(
      `_${folded.length === 1 ? 'One comment' : `${folded.length} comments`} could not be attached to ${folded.length === 1 ? 'its line' : 'their lines'} by the tracker, so ${folded.length === 1 ? 'it is' : 'they are'} written out here._`,
    )
    for (const comment of folded) parts.push(foldText(comment))
  }
  return parts.join('\n\n---\n\n')
}

/* ------------------------------------------------------------------ *
 * The executor
 * ------------------------------------------------------------------ */

/** A POST, with the body on stdin. The only place in this module a request that changes a tracker is built. */
export function post(target: Target, path: string, payload: unknown): Run {
  const body = JSON.stringify(payload)
  if (target.forge === 'github') return { ...ghApi(path, ['--method', 'POST', '--input', '-']), stdin: body }
  /* `glab api --input` sends the bytes as they are and does not say what they
     are; without the header GitLab reads a JSON body as a form and finds no
     parameters in it. */
  return { ...glabApi(target, path, ['--method', 'POST', '--input', '-', '-H', 'Content-Type: application/json']), stdin: body }
}

export interface Report {
  /** Comments now on the tracker on their own lines. */
  posted: string[]
  /** Comments now on the tracker as text in the summary. */
  folded: string[]
  /** Comments that were to be sent and were not. Still unsent in the draft. */
  unsent: string[]
  /** Whether the summary went out, and whether the verdict did. */
  summarySent: boolean
  verdictSent: boolean
  /** True when every step ran to its end. False means it stopped, and `error` says at what. */
  complete: boolean
  /** The tracker's own words for what stopped it. */
  error: string | null
  /** The whole outcome in sentences, for the page and for the draft's history. */
  notes: string[]
}

export interface Hooks {
  /** Record that these comments are on the tracker. Called the moment a request succeeds, not at the end. */
  stamp(ids: readonly string[], sent: Sent): void
  /** Record that the summary has been posted, so a later press does not post it again. */
  summarySent(): void
  now(): string
}

/**
 * Whether a refusal means "that comment cannot go on that line".
 *
 * GitHub says 422 for a line outside its diff. GitLab says 400 for a position
 * it cannot resolve (`line_code` invalid) and 422 on some versions. Anything
 * else — no login, no permission, no network, a server error — is a send that
 * FAILED, and folding then would rewrite somebody's inline comments into a
 * wall of text because their token expired.
 */
const unplaceable = (ran: Extract<Ran, { ok: false }>, forge: Target['forge']): boolean =>
  forge === 'github' ? ran.status === 422 : ran.status === 400 || ran.status === 422

/**
 * A failure with no HTTP status is one where nobody knows what the tracker did.
 *
 * A timeout or a dropped connection after the request left may have posted the
 * comment. This app will not guess, and it will not retry — it stops, leaves
 * the comment unsent in the draft, and says to look before pressing again.
 */
const unknownFate = (ran: Extract<Ran, { ok: false }>) =>
  ran.status === null ? ' Nothing came back, so this may or may not have reached the tracker: look there before sending again.' : ''

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null

function parsed(text: string): Record<string, unknown> | null {
  try {
    return record(JSON.parse(text))
  } catch {
    return null
  }
}

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/**
 * Run a plan.
 *
 * Never throws, and never repeats a request. Each success is stamped into the
 * draft through `hooks` AT ONCE, so if this process dies between two requests
 * the draft on disk already says which comments are on the tracker — which is
 * the difference between "press Send again for the rest" and posting
 * everything twice.
 *
 * On a failure that is not a placement refusal it STOPS. Later steps are not
 * attempted, least of all the verdict: an approval posted after the comments
 * explaining it failed to post is the outcome this ordering exists to prevent.
 */
export async function execute(run: Runner, target: Target, made: Plan, draft: Draft, hooks: Hooks): Promise<Report> {
  const byId = new Map(draft.comments.map((c) => [c.id, c]))
  const tracker = target.forge === 'github' ? 'GitHub' : 'GitLab'
  const posted: string[] = []
  const foldedSent: string[] = []
  const notes: string[] = []
  /* Comments waiting to be written into the final body. Not stamped until that
     body is on the tracker: until then they have not been said anywhere. */
  const toFold: Comment[] = []
  let refusal: string | null = null
  let summarySent = false
  let verdictSent = false
  let error: string | null = null

  for (const one of made.fold) {
    const comment = byId.get(one.id)
    if (comment) toFold.push(comment)
    notes.push(`A comment on ${comment?.path ?? 'a file'} was written into the summary instead of onto its line: ${one.why}.`)
  }

  const comments = (inline: readonly Inline[]) => inline.map((i) => byId.get(i.id)).filter((c): c is Comment => c !== undefined)
  const ids = (inline: readonly Inline[]) => inline.map((i) => i.id)

  const stop = (what: string, ran: Extract<Ran, { ok: false }>) => {
    error = `${what}: ${ran.error}${unknownFate(ran)}`
  }

  const stampFolded = (at: string, url: string | undefined) => {
    if (!toFold.length) return
    const folded = toFold.map((c) => c.id)
    hooks.stamp(folded, { at, ...(url ? { url } : {}), folded: true })
    foldedSent.push(...folded)
    toFold.length = 0
  }

  for (const step of made.steps) {
    if (error) break

    if (step.kind === 'github-review') {
      const ran = await run(post(target, step.path, { commit_id: step.commitId, event: 'COMMENT', comments: step.inline.map((i) => i.payload) }))
      if (ran.ok) {
        const url = parsed(ran.text)?.html_url
        hooks.stamp(ids(step.inline), { at: hooks.now(), ...(typeof url === 'string' ? { url: url.slice(0, 600) } : {}) })
        posted.push(...ids(step.inline))
      } else if (unplaceable(ran, target.forge)) {
        toFold.push(...comments(step.inline))
        refusal = ran.error
      } else stop(`The comments on commit ${short(step.commitId)} were not posted`, ran)
      continue
    }

    if (step.kind === 'github-final') {
      const attempt = async (inline: readonly Inline[], folded: readonly Comment[]) => {
        const body = composeBody(step.summary, folded)
        /* A `COMMENT` review with no body and no comments is nothing, and
           GitHub refuses it. It arises honestly — every comment belonged to an
           earlier commit and there was no summary — and then there is simply
           no final review to post. */
        if (!body && !inline.length && step.event === 'COMMENT') return 'nothing' as const
        return run(
          post(target, step.path, {
            commit_id: step.commitId,
            event: step.event,
            ...(body ? { body } : {}),
            comments: inline.map((i) => i.payload),
          }),
        )
      }
      let inline: readonly Inline[] = step.inline
      let ran = await attempt(inline, toFold)
      if (ran !== 'nothing' && !ran.ok && unplaceable(ran, target.forge) && inline.length) {
        /* GitHub refused the review, and the likeliest reason is a comment it
           cannot place. It does not say which, so the whole group goes into
           the body and the review is tried ONCE more with no inline comments.
           If the refusal was about something else (approving one's own pull
           request is also a 422), the second answer says so in GitHub's words
           and that is what is reported. */
        refusal = ran.error
        toFold.push(...comments(inline))
        inline = []
        ran = await attempt(inline, toFold)
      }
      if (ran === 'nothing') {
        verdictSent = true
        continue
      }
      if (!ran.ok) {
        stop('The review was not posted', ran)
        continue
      }
      const at = hooks.now()
      const html = parsed(ran.text)?.html_url
      const url = typeof html === 'string' ? html.slice(0, 600) : undefined
      if (inline.length) {
        hooks.stamp(ids(inline), { at, ...(url ? { url } : {}) })
        posted.push(...ids(inline))
      }
      stampFolded(at, url)
      if (step.summary) hooks.summarySent()
      summarySent = Boolean(step.summary)
      verdictSent = true
      continue
    }

    if (step.kind === 'gitlab-thread') {
      const ran = await run(post(target, step.path, step.inline.payload))
      if (ran.ok) {
        const first = Array.isArray(parsed(ran.text)?.notes) ? record((parsed(ran.text)!.notes as unknown[])[0]) : null
        const note = typeof first?.id === 'number' ? `${draft.change.url}#note_${first.id}` : undefined
        hooks.stamp([step.inline.id], { at: hooks.now(), ...(note ? { url: note } : {}) })
        posted.push(step.inline.id)
      } else if (unplaceable(ran, target.forge)) {
        toFold.push(...comments([step.inline]))
        refusal = ran.error
      } else stop(`A comment on ${byId.get(step.inline.id)?.path ?? 'a file'} was not posted`, ran)
      continue
    }

    if (step.kind === 'gitlab-note') {
      const body = composeBody(step.summary, toFold, step.prefix)
      if (!body) continue
      const ran = await run(post(target, step.path, { body }))
      if (!ran.ok) {
        stop('The summary was not posted', ran)
        continue
      }
      const id = parsed(ran.text)?.id
      stampFolded(hooks.now(), typeof id === 'number' ? `${draft.change.url}#note_${id}` : undefined)
      hooks.summarySent()
      summarySent = true
      continue
    }

    /* gitlab-approve */
    const ran = await run(post(target, step.path, step.payload))
    if (ran.ok) verdictSent = true
    else stop('The approval was not given', ran)
  }

  /* On GitLab a verdict that is not an approval has no request of its own: it
     is "sent" when everything that says it has gone. */
  if (!error && target.forge === 'gitlab' && made.verdict !== 'approve') verdictSent = true

  const done = new Set([...posted, ...foldedSent])
  const unsent = made.ids.filter((id) => !done.has(id))

  if (posted.length) notes.push(`${count(posted.length, 'comment')} ${posted.length === 1 ? 'was' : 'were'} posted to ${tracker} on ${posted.length === 1 ? 'its line' : 'their lines'}.`)
  if (foldedSent.length) {
    notes.push(
      `${count(foldedSent.length, 'comment')} could not be placed on ${foldedSent.length === 1 ? 'its line' : 'their lines'} and ${foldedSent.length === 1 ? 'was' : 'were'} written into the summary instead, with the file, line, commit and quoted source.${refusal ? ` ${tracker} said: ${refusal}` : ''}`,
    )
  }
  if (verdictSent && !error) {
    if (target.forge === 'github') notes.push(`The review was submitted as “${made.verdict}”.`)
    else if (made.verdict === 'approve') notes.push('The merge request was approved.')
    else if (made.verdict === 'request-changes') {
      notes.push(
        'GitLab was not asked to set a reviewer state: “request changes” is said in words at the top of the summary note, because GitLab has no call for it that works across the versions in use.',
      )
    }
  }
  if (error) {
    notes.push(error)
    notes.push(
      unsent.length
        ? `Sending stopped there. ${count(unsent.length, 'comment')} ${unsent.length === 1 ? 'was' : 'were'} not sent and ${unsent.length === 1 ? 'is' : 'are'} still in the draft${verdictSent ? '' : ', and the verdict was not submitted'}. Pressing Send again sends only what is left.`
        : `Sending stopped there${verdictSent ? '' : ', and the verdict was not submitted'}. Pressing Send again sends only what is left.`,
    )
  }

  return { posted, folded: foldedSent, unsent, summarySent, verdictSent, complete: error === null, error, notes }
}

/* ------------------------------------------------------------------ *
 * The facts, read fresh
 * ------------------------------------------------------------------ */

/** GitLab's list of a merge request's diff versions, each with the three commits its diff was made from. */
export function readVersions(answer: string): NonNullable<Facts['versions']> {
  let body: unknown
  try {
    body = JSON.parse(answer)
  } catch {
    return []
  }
  if (!Array.isArray(body)) return []
  const out: NonNullable<Facts['versions']> = []
  for (const raw of body.slice(0, 200)) {
    const one = record(raw)
    if (one && isSha(one.head_commit_sha) && isSha(one.base_commit_sha) && isSha(one.start_commit_sha)) {
      out.push({ head: one.head_commit_sha, base: one.base_commit_sha, start: one.start_commit_sha })
    }
  }
  return out
}

/**
 * What the change is RIGHT NOW, asked of the tracker just before sending.
 *
 * Not taken from the page and not taken from a cache: the head decides which
 * review carries the verdict and what an approval approves, and the only
 * honest source for it at the moment of sending is the forge.
 *
 * The versions are read only when some comment needs them, and a failure to
 * read them is not a failure to send — the comments that needed one are folded
 * with the reason, which is the same outcome as GitLab not having the version.
 */
export async function gather(run: Runner, target: Target, draft: Draft): Promise<Read<Facts>> {
  const described = await describe(run, target)
  if (!described.ok) return described
  const listed = await readCommits(run, target)
  if (!listed.ok) return listed
  const facts: Facts = {
    head: described.value.head,
    base: described.value.base,
    start: described.value.start,
    commits: listed.value.commits.map((c) => ({ sha: c.sha, parents: c.parents })),
  }
  const needsVersions = target.forge === 'gitlab' && draft.comments.some((c) => !c.sent && c.view === 'all' && c.commit !== facts.head)
  if (needsVersions) {
    const ran = await run(glabApi(target, `${gitlabProject(target)}/versions`))
    facts.versions = ran.ok ? readVersions(ran.text) : []
  }
  return { ok: true, value: facts }
}
