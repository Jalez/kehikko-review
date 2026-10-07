import type { Forge, Target } from '../forge/locate.ts'

/**
 * What a draft review IS, as it sits on disk: one JSON file per change.
 *
 * Types and bounds only — no I/O and no node import, because the page reads
 * this file too — so the page, the doors, the anchoring
 * rule and the send plan all mean the same thing by "a comment".
 */

export const DRAFT_VERSION = 1

/**
 * The bounds. Every one is a ceiling on something a stranger writes — a
 * person's keyboard, an agent's tool call, or a file somebody edited by hand.
 */
export const MAX_BODY = 10_000
export const MAX_SUMMARY = 20_000
/** A review of more than this many comments is a rewrite request, and a tracker would throttle it anyway. */
export const MAX_COMMENTS = 200
export const MAX_PATH = 1000
/** How much of the commented-on source is kept as the quote. Enough to recognise the place; not a copy of the file. */
export const MAX_QUOTE = 4000
/** The most lines one comment may span. GitHub's own limit on a multi-line comment is far above what reads as one remark. */
export const MAX_RANGE = 200
export const MAX_SENT_LOG = 50

export type View = 'all' | 'commit'
export type Side = 'new' | 'old'
export type By = 'person' | 'agent'
export type Verdict = 'comment' | 'approve' | 'request-changes'

export const VERDICTS: readonly Verdict[] = ['comment', 'approve', 'request-changes']

export interface Sent {
  at: string
  /** Where the tracker put it, when it said. */
  url?: string
  /**
   * True when the tracker would not place the comment on its line and it went
   * into the review's summary as text instead. It was still posted; it is just
   * not where it was aimed, and the page says so.
   */
  folded?: boolean
}

export interface Comment {
  id: string
  /**
   * The frame the line numbers are counted in — the heart of this module.
   *
   * `all`: the lines of the whole change's diff (base..head), and `commit` is
   * the HEAD the change had when the comment was written. `commit`: the lines
   * of one commit's own diff (parent..commit), and `commit` is that commit.
   *
   * The same file has different line numbers in every one of those diffs, so a
   * comment that did not record which diff it was looking at would be a number
   * with no unit.
   */
  view: View
  commit: string
  /**
   * The first parent of `commit`, for a commit-view comment: what its `old`
   * side is a line OF. Recorded when the comment is written, so sending does
   * not depend on the commit still being on the tracker's list.
   */
  parent?: string
  /** The file's path on the new side, or its only path when it was deleted. */
  path: string
  /** Its path before, when the change renamed it. GitLab's position names both. */
  oldPath?: string
  /** Which column of line numbers `line` is from. */
  side: Side
  /** The line the comment is on, and the LAST line when it covers a range. */
  line: number
  /** The first line of a range, on the same side. Absent for a single line. */
  startLine?: number
  /**
   * The number the last line has on the OTHER side, present only when that
   * line is unchanged context. GitLab wants both numbers for such a line.
   */
  otherLine?: number
  /** The text of the lines, as the diff had them when the comment was anchored. */
  quote: string
  body: string
  by: By
  at: string
  editedAt?: string
  sent?: Sent
}

export interface SentRecord {
  at: string
  verdict: Verdict
  /** The head of the change when the review went out: what an approval was an approval of. */
  head: string
  /** How many comments were posted in this send, inline or folded. */
  comments: number
  /** The summary as it was posted. The draft's own is cleared afterwards. */
  summary: string
  /** Anything a reader should know about how it went, in sentences. */
  notes: string[]
}

export interface ChangeRef {
  url: string
  forge: Forge
  repo: string
  number: number
  host?: string
}

export interface Draft {
  version: typeof DRAFT_VERSION
  change: ChangeRef
  comments: Comment[]
  summary: string
  verdict: Verdict | null
  sent: SentRecord[]
}

/** The address of a change as a tracker's own URL, rebuilt from the parts so it never carries a query or a fragment. */
export function urlOf(target: Target): string {
  return target.forge === 'github'
    ? `https://github.com/${target.repo}/pull/${target.number}`
    : `https://${target.host ?? 'gitlab.com'}/${target.repo}/-/merge_requests/${target.number}`
}

export const changeOf = (target: Target): ChangeRef => ({
  url: urlOf(target),
  forge: target.forge,
  repo: target.repo,
  number: target.number,
  ...(target.host ? { host: target.host } : {}),
})

export const targetOf = (change: ChangeRef): Target => ({
  forge: change.forge,
  repo: change.repo,
  number: change.number,
  ...(change.host ? { host: change.host } : {}),
})

/** How a person writes this change: `owner/repo#46`, `group/project!12`. */
export const spell = (change: Pick<ChangeRef, 'forge' | 'repo' | 'number'>): string =>
  `${change.repo}${change.forge === 'github' ? '#' : '!'}${change.number}`

export const short = (sha: string): string => sha.slice(0, 8)
