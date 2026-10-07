import type { DiffLine, FileDiff, Hunk } from '../src/diff/parse.ts'

import { MAX_QUOTE, MAX_RANGE, type Side } from './shape.ts'

/**
 * Whether a comment can be put where somebody asked, decided against the diff
 * itself.
 *
 * ## Why the server checks and does not take the caller's word
 *
 * A comment says "this file, this side, this line", and those three are only
 * meaningful inside one particular diff. The page pressed a line it had on
 * screen, so it is usually right; an agent typed three values into a tool call
 * after reading a diff some moments ago, so it is right when it was careful.
 * Neither is checked by the other, and a tracker rejects a whole review over
 * one comment on a line that is not in the diff — after the person has already
 * pressed Send.
 *
 * So the rule runs when a comment is WRITTEN, against the diff of exactly the
 * view the comment names, and a comment that cannot be placed is refused with a
 * sentence saying which part is wrong. What is stored is therefore known to
 * have pointed at real lines of a real diff, and it carries the text of those
 * lines (`quote`) as the evidence.
 *
 * A pure function over parsed files, so every way of being wrong has a test and
 * none of them needs a tracker.
 */

export interface Want {
  path: string
  side: Side
  /** The line, or the last line of a range. */
  line: number
  /** The first line of a range. May equal `line`, which means a single line. */
  startLine?: number
}

export interface Anchored {
  path: string
  oldPath?: string
  /** May differ from what was asked: see the note on all-context ranges below. */
  side: Side
  line: number
  startLine?: number
  otherLine?: number
  quote: string
}

export type Anchoring = { ok: true; anchor: Anchored } | { ok: false; error: string }

const SIDE_WORD: Record<Side, string> = { new: 'new', old: 'old' }

/** A whole number a line could have. `12.5`, `0`, `-3`, `'12'` and `NaN` are not line numbers. */
const lineNumber = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value > 0 && value < 10_000_000

const on = (line: DiffLine, side: Side): number | null => (side === 'new' ? line.new : line.old)

/**
 * The file a path names in this diff.
 *
 * By its drawn path first — the new path, or the old one for a deleted file —
 * and then by its previous path, so a comment on the old side of a renamed
 * file may name it by the name it had on that side.
 */
function fileFor(files: readonly FileDiff[], path: string): FileDiff | null {
  return files.find((f) => f.path === path) ?? files.find((f) => f.from === path) ?? null
}

/** The hunk holding a numbered line on one side, with the line's index in it. */
function locateLine(file: FileDiff, side: Side, n: number): { hunk: Hunk; at: number } | null {
  for (const hunk of file.hunks) {
    const at = hunk.lines.findIndex((line) => line.kind !== 'note' && on(line, side) === n)
    if (at >= 0) return { hunk, at }
  }
  return null
}

export function anchor(files: readonly FileDiff[], want: Want, where = 'this diff'): Anchoring {
  if (typeof want.path !== 'string' || !want.path) return { ok: false, error: 'A comment names a file, and this one did not.' }
  if (want.side !== 'new' && want.side !== 'old') return { ok: false, error: 'side is "new" or "old": which column of line numbers the line is from.' }
  if (!lineNumber(want.line)) return { ok: false, error: 'line is a whole number, counted from 1.' }
  if (want.startLine !== undefined && !lineNumber(want.startLine)) return { ok: false, error: 'start_line is a whole number, counted from 1.' }

  const path = want.path.slice(0, 300)
  const file = fileFor(files, want.path)
  if (!file) {
    return {
      ok: false,
      error: `There is no file "${path}" in ${where}. A comment can only be put on a file that diff touches; the same file may be in another commit’s diff or in the whole change’s.`,
    }
  }
  if (file.binary) return { ok: false, error: `"${path}" is binary in ${where}: git printed no lines for it, so there is no line to comment on.` }

  const side = want.side
  const first = want.startLine ?? want.line
  if (first > want.line) return { ok: false, error: `A range runs downwards: start_line ${first} is after line ${want.line}.` }
  if (want.line - first + 1 > MAX_RANGE) return { ok: false, error: `A comment covers at most ${MAX_RANGE} lines; this range is ${want.line - first + 1}.` }

  const end = locateLine(file, side, want.line)
  if (!end) {
    return {
      ok: false,
      error: `Line ${want.line} on the ${SIDE_WORD[side]} side of "${path}" is not in ${where}. Only lines the diff shows — changed lines and the context around them — can be commented on.${hintOtherSide(file, side, want.line)}`,
    }
  }
  const start = first === want.line ? end : locateLine(file, side, first)
  if (!start) {
    return { ok: false, error: `Line ${first}, where the range starts, is not on the ${SIDE_WORD[side]} side of "${path}" in ${where}.` }
  }
  /* A hunk is one contiguous piece of the file. Between two hunks there are
     lines the diff does not show, so a range across them would claim to be
     about lines nobody was looking at — and both trackers refuse it. */
  if (start.hunk !== end.hunk) {
    return {
      ok: false,
      error: `Lines ${first}–${want.line} of "${path}" cross from one hunk into another, and the lines between hunks are not in ${where}. Comment on each part separately.`,
    }
  }

  /* The lines of the range that exist on this side. Inside one hunk a side's
     numbers are consecutive, so "both ends are here" already means every line
     between them is; the lines of the OTHER side interleaved among them
     (additions inside an old-side range) are not part of it and are not quoted. */
  const covered = end.hunk.lines.slice(start.at, end.at + 1).filter((line) => line.kind !== 'note' && on(line, side) !== null)
  const last = covered[covered.length - 1]
  if (!last) return { ok: false, error: `Nothing on the ${SIDE_WORD[side]} side of "${path}" is in that range.` }

  /*
   * A range that is ALL unchanged context is the same lines on both sides, and
   * it is recorded on the new side whichever gutter was pressed.
   *
   * It is not a matter of taste. The old side of a commit's diff is the file
   * in that commit's PARENT, and a tracker will often not let a review comment
   * be placed there; the new side is the file in the commit itself, which is
   * what the reviewer was reading anyway. Since the lines are identical, moving
   * the anchor loses nothing and makes it placeable. An old-side anchor is thus
   * always a comment about something that was REMOVED, which is the only time
   * the old side says something the new side cannot.
   */
  const allContext = covered.every((line) => line.kind === 'context')
  const anchoredSide: Side = allContext ? 'new' : side
  const other: Side = anchoredSide === 'new' ? 'old' : 'new'
  const firstLine = covered[0]!
  const lineAt = on(last, anchoredSide)!
  const startAt = on(firstLine, anchoredSide)!
  const otherLine = last.kind === 'context' ? on(last, other) : null

  return {
    ok: true,
    anchor: {
      path: file.path,
      ...(file.from && file.from !== file.path ? { oldPath: file.from } : {}),
      side: anchoredSide,
      line: lineAt,
      ...(startAt !== lineAt ? { startLine: startAt } : {}),
      ...(otherLine !== null ? { otherLine } : {}),
      quote: covered.map((line) => line.text).join('\n').slice(0, MAX_QUOTE),
    },
  }
}

/**
 * The commonest mistake, named: the line exists, on the other column.
 *
 * An added line has only a new number and a removed line only an old one, and
 * somebody reading `12 | 14 | + foo` off a rendered diff picks the wrong one
 * about as often as the right one. Saying "it is on the other side" turns a
 * refusal into a correction.
 */
function hintOtherSide(file: FileDiff, side: Side, n: number): string {
  const other: Side = side === 'new' ? 'old' : 'new'
  return locateLine(file, other, n) ? ` There is a line ${n} on the ${SIDE_WORD[other]} side; say side: "${other}" if that is the one.` : ''
}
