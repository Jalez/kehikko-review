import { ChevronRight } from 'lucide-react'
import { Fragment, useState, type CSSProperties, type ReactNode } from 'react'

import { Button } from '@/components/ui/button'
import { FILE_LINES } from '@/diff/budget'
import type { DiffLine, FileDiff } from '@/diff/parse'
import { cn } from '@/lib/utils'

import type { Comment, Side } from '../../review/shape.ts'

/**
 * One file of a diff, with every line a place a comment can go.
 *
 * ## What is Diff's and what is new
 *
 * The drawing is Diff's `file-diff.tsx`: a header that is never conditional
 * (path, status, both counts, for every file, open or closed — a file that is
 * absent looks exactly like a file that was not changed), a body that is its
 * own horizontal scroller, two gutters sized per file from its widest number,
 * and a `+`/`-` character in the text so colour is never the only channel.
 *
 * What is new is that the gutters are BUTTONS. A comment is anchored to a
 * side and a line number, and the two gutters are exactly those two things
 * drawn on screen — so the target for "comment on old line 14" is the 14 in
 * the old column. Nothing has to be explained: what is pressed is what is
 * cited, and it is the same number the server checks the anchor against.
 *
 * ## A range is a second press with shift
 *
 * Press a number, then shift-press another in the same column of the same
 * file. Dragging would be the obvious gesture and is the wrong one here: these
 * rows are inside a horizontal scroller in a frame that is itself dragged
 * around a canvas, and a drag that sometimes selects, sometimes scrolls and
 * sometimes moves the pane is worse than a press that always does one thing.
 */

/** What a status reads as on screen. Words, because a coloured dot is not a sentence. */
const STATUS: Record<FileDiff['status'], string> = {
  added: 'added',
  removed: 'deleted',
  renamed: 'renamed',
  modified: 'changed',
}

/** The lines being picked out for a comment, in one column of one file. */
export interface Pick {
  /** Which file, by its index in the patch: a malformed patch can name one path twice. */
  file: number
  side: Side
  start: number
  line: number
}

const on = (line: DiffLine, side: Side): number | null => (side === 'new' ? line.new : line.old)

function Gutter({
  n,
  side,
  path,
  onPick,
}: {
  n: number | null
  side: Side
  path: string
  onPick: ((side: Side, line: number, extend: boolean) => void) | null
}) {
  const shape = 'w-[var(--gutter-ch)] shrink-0 select-none pr-1 text-right text-gutter'
  /* Both gutters are always present, even when one is empty: a number that
     moves column depending on the kind of line is a number nobody can scan
     down. An empty one is not a button — there is no line there to point at. */
  if (n === null || !onPick) return <span className={shape}>{n ?? ''}</span>
  return (
    <button
      type="button"
      className={cn(shape, 'cursor-pointer hover:bg-pick hover:text-foreground focus-visible:bg-pick focus-visible:outline-none')}
      aria-label={`Comment on ${side} line ${n} of ${path}`}
      title="Comment on this line. Shift-press another line to cover a range."
      onClick={(event) => onPick(side, n, event.shiftKey)}
    >
      {n}
    </button>
  )
}

function Line({
  line,
  path,
  picked,
  onPick,
}: {
  line: DiffLine
  path: string
  picked: boolean
  onPick: ((side: Side, line: number, extend: boolean) => void) | null
}) {
  /* A note — git's `\ No newline at end of file` — is neither side of the diff:
     no number, no wash, and nothing to comment on. */
  const wash = picked ? 'bg-pick' : line.kind === 'add' ? 'bg-add' : line.kind === 'del' ? 'bg-del' : ''
  const mark = line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : line.kind === 'note' ? '\\' : ' '
  const markTone = line.kind === 'add' ? 'text-add-mark' : line.kind === 'del' ? 'text-del-mark' : 'text-gutter'
  const pick = line.kind === 'note' ? null : onPick
  return (
    <div className={cn('diff-row', wash)} data-picked={picked ? 'yes' : undefined}>
      <Gutter n={line.old} side="old" path={path} onPick={pick} />
      <Gutter n={line.new} side="new" path={path} onPick={pick} />
      <span className={cn('w-[1.5ch] shrink-0 select-none', markTone)}>{mark}</span>
      <span className="pr-2">{line.text}</span>
    </div>
  )
}

export function FileSection({
  file,
  open,
  onToggle,
  comments,
  pick,
  onPick,
  composer,
  renderComment,
}: {
  file: FileDiff
  open: boolean
  onToggle: () => void
  /** The draft comments on this file IN THE VIEW BEING SHOWN. Another view's comments have other line numbers. */
  comments: readonly Comment[]
  /** The lines being picked in this file, or null. */
  pick: Pick | null
  /** Null when comments cannot be written at all (no project to keep them in). */
  onPick: ((side: Side, line: number, extend: boolean) => void) | null
  /** The box for the comment being written, drawn under the last picked line. */
  composer: ReactNode
  renderComment(comment: Comment): ReactNode
}) {
  /* How much of this file is drawn; grows by `FILE_LINES` a press. A file that
     already has comments is drawn whole from the start: a comment that exists
     and is not on screen because of a paging limit is a comment that looks
     lost. */
  const [shown, setShown] = useState(() => (comments.length ? Number.MAX_SAFE_INTEGER : FILE_LINES))

  /* How many digits the widest line number in this file needs. Two is the
     floor so a one-line file still has a gutter that looks like one. */
  let widest = 2
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      const most = Math.max(line.old ?? 0, line.new ?? 0)
      if (most > 0) widest = Math.max(widest, String(most).length)
    }
  }

  /* The hunks flattened into one list with the `@@` headers kept in place: the
     cap is counted in LINES, and a hunk header is the only thing that says the
     file jumped. */
  const rows: ({ at: 'hunk'; header: string } | { at: 'line'; line: DiffLine })[] = []
  let counted = 0
  let cut = 0
  for (const hunk of file.hunks) {
    if (counted >= shown) {
      cut += hunk.lines.length
      continue
    }
    rows.push({ at: 'hunk', header: hunk.header })
    for (const line of hunk.lines) {
      if (counted >= shown) {
        cut += 1
        continue
      }
      rows.push({ at: 'line', line })
      counted += 1
    }
  }

  const unsent = comments.filter((c) => !c.sent).length

  return (
    <details
      open={open}
      onToggle={(e) => {
        /* Guarded: `<details>` fires `toggle` on the first render when `open` is
           set, and an unguarded handler would close every file the plan opened. */
        if ((e.currentTarget as HTMLDetailsElement).open !== open) onToggle()
      }}
      className="min-w-0 rounded-md border bg-card"
      data-file={file.path}
      data-open={open ? 'yes' : 'no'}
    >
      {/* A flex row, and the middle part carries `min-w-0`. Without it the path —
          one unbroken string — sizes this item to its own length, the
          `<details>` grows past the frame, and the whole page scrolls sideways.
          That failure is produced here, in the HEADER, not in the diff body
          everybody watches. */}
      <summary className="flex cursor-pointer list-none items-start gap-1 px-2 py-1 text-[0.7rem] leading-4 hover:bg-accent marker:content-['']">
        <ChevronRight aria-hidden="true" className={cn('mt-0.5 size-3 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')} />
        <span className="min-w-0 flex-1">
          <span className="font-mono">{file.path}</span>
          {file.from && file.from !== file.path ? <span className="text-muted-foreground"> ← {file.from}</span> : null}
          <span className="ml-1 whitespace-nowrap text-muted-foreground">
            {STATUS[file.status]}
            {file.binary ? ', binary' : ''}
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-1 whitespace-nowrap">
          {/* Where the comments sit is visible on a CLOSED file too: a count in
              the header, in words, so nobody has to open twelve files to find
              the one an agent wrote on. */}
          {comments.length ? (
            <span className="rounded-sm bg-pick px-1" data-testid="file-comments">
              {unsent ? `${unsent} draft` : `${comments.length} sent`}
            </span>
          ) : null}
          {file.added || file.removed ? (
            /* The sign is inside each count rather than implied by its colour:
               red and green are the pair the commonest colour blindness merges. */
            <>
              <span className="rounded-sm bg-add px-1 text-add-mark">+{file.added}</span>
              <span className="rounded-sm bg-del px-1 text-del-mark">−{file.removed}</span>
            </>
          ) : null}
        </span>
      </summary>

      {file.binary ? (
        <p className="border-t px-2 py-1 text-[0.7rem] leading-4 text-muted-foreground">
          Git says this file is binary and printed no lines for it, so there is no line to comment on. It was {STATUS[file.status]}; say what you
          think of it in the summary.
        </p>
      ) : file.hunks.length === 0 ? (
        <p className="border-t px-2 py-1 text-[0.7rem] leading-4 text-muted-foreground">
          {file.status === 'renamed'
            ? 'Renamed, with no change to its contents — so there is no line here to comment on.'
            : 'The diff names this file and prints no lines for it. That is usually a mode change, an empty file, or one the tracker found too large to print.'}
        </p>
      ) : (
        <div
          className="diff-scroll border-t font-mono text-[0.65rem] leading-[1.35]"
          /* One width for every gutter in this file, from its own largest line
             number plus a character of space. */
          style={{ '--gutter-ch': `${widest + 1}ch` } as CSSProperties}
        >
          {rows.map((row, at) => {
            if (row.at === 'hunk') {
              return (
                <div key={at} className="diff-row bg-muted px-1 text-muted-foreground">
                  {row.header}
                </div>
              )
            }
            const { line } = row
            const n = pick ? on(line, pick.side) : null
            const picked = pick !== null && n !== null && n >= pick.start && n <= pick.line
            /* A comment is drawn under the line it is on: the row whose number
               in the comment's own column is the comment's line. */
            const here = line.kind === 'note' ? [] : comments.filter((c) => on(line, c.side) === c.line)
            const composing = pick !== null && n === pick.line
            return (
              <Fragment key={at}>
                <Line line={line} path={file.path} picked={picked} onPick={onPick} />
                {here.length || composing ? (
                  <div className="diff-inset">
                    {here.map((comment) => (
                      <Fragment key={comment.id}>{renderComment(comment)}</Fragment>
                    ))}
                    {composing ? composer : null}
                  </div>
                ) : null}
              </Fragment>
            )
          })}
        </div>
      )}

      {cut > 0 ? (
        /* The count is exact and it is the point: a truncation a reader can
           undo, rather than one to take on trust. */
        <div className="border-t px-2 py-1 text-[0.7rem] leading-4">
          <span className="text-muted-foreground">
            {cut} more {cut === 1 ? 'line' : 'lines'} in this file are not drawn yet.{' '}
          </span>
          <Button type="button" variant="link" size="sm" className="h-auto p-0 text-[0.7rem]" onClick={() => setShown((was) => was + FILE_LINES)}>
            Draw {Math.min(cut, FILE_LINES)} more
          </Button>
        </div>
      ) : null}
    </details>
  )
}
