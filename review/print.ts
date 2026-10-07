import type { FileDiff } from '../src/diff/parse.ts'

import { short, spell, type Comment, type Draft } from './shape.ts'

/**
 * A diff and a draft, as text an agent reads.
 *
 * ## Why the diff is reprinted instead of handed over raw
 *
 * A unified diff does not contain line numbers. It has `@@ -12,7 +12,9 @@` and
 * then lines, and the number of any particular line has to be COUNTED from the
 * header — per side, skipping the other side's lines. A model asked to do that
 * across a two-hundred-line hunk gets it wrong often enough that every comment
 * it writes would be a coin toss against the anchoring rule.
 *
 * So each line is printed with the two numbers it actually has, in two fixed
 * columns: old, then new. A blank column means the line does not exist on that
 * side. What an agent cites is what is printed, and what is printed is what
 * the anchoring rule checks, because both come from the same parse.
 */

export const DEFAULT_DIFF_LINES = 800
export const MAX_DIFF_LINES = 4000
/** How much of one line is printed. A minified bundle is a single line of a megabyte, and nobody reviews that by reading it. */
export const MAX_LINE_CHARS = 500

const clip = (text: string): string => (text.length > MAX_LINE_CHARS ? `${text.slice(0, MAX_LINE_CHARS)}… (${text.length - MAX_LINE_CHARS} more characters on this line)` : text)

const STATUS: Record<FileDiff['status'], string> = { added: 'added', removed: 'deleted', renamed: 'renamed', modified: 'changed' }

/** One line per file: the answer to "what did this touch", which is most of what a first look is for. */
export function printFiles(files: readonly FileDiff[]): string {
  if (!files.length) return '(no files)'
  return files
    .map((f) => `${f.path}${f.from && f.from !== f.path ? ` (was ${f.from})` : ''} — ${STATUS[f.status]}${f.binary ? ', binary' : ''}, +${f.added} −${f.removed}`)
    .join('\n')
}

export function printDiff(files: readonly FileDiff[], options: { path?: string; maxLines?: number } = {}): string {
  const budget = Math.max(1, Math.min(options.maxLines ?? DEFAULT_DIFF_LINES, MAX_DIFF_LINES))
  const chosen = options.path ? files.filter((f) => f.path === options.path || f.from === options.path) : files
  if (options.path && !chosen.length) {
    return `No file "${options.path.slice(0, 300)}" in this diff. The files in it are:\n${printFiles(files)}`
  }

  let widest = 2
  for (const file of chosen) for (const hunk of file.hunks) for (const line of hunk.lines) widest = Math.max(widest, String(Math.max(line.old ?? 0, line.new ?? 0)).length)
  const pad = (n: number | null) => (n === null ? '' : String(n)).padStart(widest)

  const out: string[] = [`Columns: old line, new line, then the line. A blank number means the line is not on that side.`]
  let spent = 0
  let cutLines = 0
  let cutFiles = 0
  for (const file of chosen) {
    if (spent >= budget) {
      cutFiles += 1
      cutLines += file.lines
      continue
    }
    out.push('', `=== ${file.path}${file.from && file.from !== file.path ? ` (was ${file.from})` : ''} — ${STATUS[file.status]}, +${file.added} −${file.removed}`)
    if (file.binary) out.push('(binary: git printed no lines, so there is nothing to comment on)')
    for (const hunk of file.hunks) {
      if (spent >= budget) {
        cutLines += hunk.lines.length
        continue
      }
      out.push(hunk.header)
      for (const line of hunk.lines) {
        if (spent >= budget) {
          cutLines += 1
          continue
        }
        const mark = line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : line.kind === 'note' ? '\\' : ' '
        out.push(`${pad(line.old)} ${pad(line.new)} ${mark}${clip(line.text)}`)
        spent += 1
      }
    }
  }
  if (cutLines) {
    /* Exact, because "truncated" with no number is a thing an agent cannot act
       on and a number is. */
    out.push(
      '',
      `${cutLines} more lines${cutFiles ? ` in ${cutFiles} more file${cutFiles === 1 ? '' : 's'}` : ''} were not printed (the limit was ${budget} lines). Ask again with path set to one file, or a larger max_lines up to ${MAX_DIFF_LINES}.`,
    )
  }
  return out.join('\n')
}

export function printComment(comment: Comment): string {
  const lines = comment.startLine !== undefined ? `${comment.startLine}–${comment.line}` : String(comment.line)
  const frame = comment.view === 'all' ? `whole change at ${short(comment.commit)}` : `commit ${short(comment.commit)}`
  const state = comment.sent ? (comment.sent.folded ? 'SENT (in the summary, not on its line)' : 'SENT') : 'draft'
  return [
    `[${comment.id}] ${comment.path}:${lines} (${comment.side} side, ${frame}) — by ${comment.by === 'agent' ? 'an agent' : 'the person'}, ${state}`,
    ...(comment.quote ? comment.quote.split('\n').slice(0, 6).map((l) => `    | ${l.slice(0, 160)}`) : []),
    ...comment.body.split('\n').map((l) => `  ${l}`),
  ].join('\n')
}

export function printDraft(draft: Draft): string {
  const waiting = draft.comments.filter((c) => !c.sent)
  const gone = draft.comments.filter((c) => c.sent)
  const out = [
    `Review of ${spell(draft.change)} — ${draft.change.url}`,
    `Verdict proposed: ${draft.verdict ?? 'none yet'}`,
    `Summary: ${draft.summary.trim() ? `\n${draft.summary.trim()}` : '(empty)'}`,
    '',
    `${waiting.length} draft comment${waiting.length === 1 ? '' : 's'} not yet sent${waiting.length ? ':' : '.'}`,
    ...waiting.map(printComment),
  ]
  if (gone.length) out.push('', `${gone.length} already sent (on the tracker; not editable from here):`, ...gone.map(printComment))
  if (draft.sent.length) {
    out.push('', 'Sends so far:')
    for (const one of draft.sent) out.push(`- ${one.at}: “${one.verdict}” at ${short(one.head)}, ${one.comments} comment${one.comments === 1 ? '' : 's'}`)
  }
  out.push('', 'Nothing here is posted until the person presses Send on the page.')
  return out.join('\n')
}
