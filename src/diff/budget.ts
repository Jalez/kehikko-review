import type { FileDiff } from './parse.ts'

/**
 * How much of a patch is drawn before anybody asks for more.
 *
 * A frame on a canvas is a few hundred pixels wide and one of several, and a
 * change that regenerates a lockfile is forty thousand rows of DOM nobody will
 * read. So files are OPENED up to a budget and the rest start closed — closed,
 * not absent: every file keeps its header, because a file that is not on the
 * list looks exactly like a file that was not changed.
 *
 * The same two numbers and the same rule as Diff's `budget.ts`.
 */
export const OPEN_LINES = 1200

/** How many lines of one open file are drawn at a time. The rest are a press away, with an exact count. */
export const FILE_LINES = 800

export interface Opening {
  /** Indexes of the files that start open. By index: a malformed patch can name one path twice. */
  open: Set<number>
  closed: number
  heldBack: number
}

export function opening(files: readonly FileDiff[]): Opening {
  const open = new Set<number>()
  let spent = 0
  let closed = 0
  let heldBack = 0
  for (const [at, file] of files.entries()) {
    /* The first file is always open, however large: a page of closed headers
       reads as a page that failed to load, and `FILE_LINES` already bounds it. */
    if (at === 0 || spent + file.lines <= OPEN_LINES) {
      open.add(at)
      spent += file.lines
    } else {
      closed += 1
      heldBack += file.lines
    }
  }
  return { open, closed, heldBack }
}
