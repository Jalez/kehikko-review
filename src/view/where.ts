import type { CodeLocation, SharedLocation } from 'kehikot-module-protocol'

import { short, type Comment, type Side } from '../../review/shape.ts'

/**
 * Between a point and a place in the code (protocol 2.13.0, `location.set` / `context.location`).
 * Pure, so what a press says and what a "comment here" opens are tested without a host.
 */

/** A place a new point is written at: a file, a side, and its first and last line. */
export interface Place {
  path: string
  side: Side
  start: number
  line: number
  /** The commit the place was counted at, when the pointer said; only a new-side one is the head. */
  commit?: string
}

/**
 * Where a point is, as a code location: the change as the selection spells it, the file, the lines,
 * the side and the commit they are counted at. A whole-change point counts its new side at the head
 * it was written on; its old side is the base, which the point does not record, so it says no commit.
 * A commit's point counts at that commit, or at its parent for a removed line.
 */
export function locationOf(comment: Comment, change: string): CodeLocation {
  const commit = comment.view === 'all' ? (comment.side === 'new' ? comment.commit : undefined) : comment.side === 'new' ? comment.commit : comment.parent
  return {
    change,
    path: comment.path,
    line: comment.startLine ?? comment.line,
    ...(comment.startLine !== undefined ? { endLine: comment.line } : {}),
    side: comment.side,
    ...(commit ? { commit } : {}),
  }
}

/** A point's code reference as it is read: `src/app.ts:40-42@f982d895`. */
export function codeLabel(comment: Pick<Comment, 'path' | 'line' | 'startLine' | 'commit' | 'side'>): string {
  const lines = comment.startLine !== undefined ? `${comment.startLine}-${comment.line}` : String(comment.line)
  return `${comment.path}:${lines}@${short(comment.commit)}${comment.side === 'old' ? ' (removed)' : ''}`
}

/**
 * Whether a "comment here" is one this page should open a new point for: asked for a comment, in the
 * change on the page, not by this page itself, and not one it already opened (`at` is new on every
 * `location.set`, so the same place asked twice is two asks).
 */
export function commentAsked(location: SharedLocation | null | undefined, change: string, handled: ReadonlySet<string>, self: string): boolean {
  if (!location || location.intent !== 'comment' || location.change !== change) return false
  if (location.by === self) return false
  return !handled.has(askOf(location))
}

/** What identifies one ask: its time when the host stamped one, else the place itself. */
export const askOf = (location: SharedLocation): string =>
  location.at ?? `${location.path}:${location.side}:${location.line}:${location.endLine ?? location.line}:${location.commit ?? ''}`

export function placeOf(location: CodeLocation): Place {
  return {
    path: location.path,
    side: location.side,
    start: location.line,
    line: location.endLine ?? location.line,
    ...(location.commit ? { commit: location.commit } : {}),
  }
}

export const placeLabel = (place: Place): string => `${place.path}:${place.start === place.line ? place.line : `${place.start}-${place.line}`}${place.side === 'old' ? ' (removed)' : ''}`
