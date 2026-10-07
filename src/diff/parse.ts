/**
 * A unified diff, read into something a page can draw.
 *
 * ## The one promise this file keeps
 *
 * **Every `diff --git` in the input becomes exactly one file in the output.**
 * Not "every file we could parse hunks for", not "every file with a readable
 * path". Somebody is reading this to find out what a change touched, and the
 * failure they cannot detect is the one where a file was never drawn: a file
 * with no hunks is visibly odd, a file with a strange path is visibly strange,
 * and a file that is simply absent looks exactly like a file that was never
 * changed. That is the same rule `collect.ts` keeps in References, for the same
 * reason, and it is why there is no `filter` in this file and no `continue` over
 * a header that disappointed us.
 *
 * A binary file has no lines and still has an entry. A file whose `---`/`+++`
 * lines are missing keeps whatever path the git header gave. A hunk header that
 * does not parse still gets its lines, numbered from zero and marked as such by
 * having no numbers at all rather than by having wrong ones.
 *
 * ## Why parse at all, rather than colour the text
 *
 * Because line numbers are the thing a reader actually needs and they are not in
 * the text. `@@ -2646,6 +2646,63 @@` says where the hunk starts and the numbers
 * for every line after it have to be counted. A page that colours `+` green and
 * stops is a page where "which line is that" is unanswerable, and answering it
 * is most of why anybody opens a diff at all.
 *
 * ## What it does not do
 *
 * No intraline highlighting, no word diff, no rename detection beyond what git
 * already wrote down. Each of those is a guess dressed as information, and this
 * container's entire claim is that it shows what the tracker said, byte for byte.
 */

export type LineKind = 'context' | 'add' | 'del' | 'note'

export interface DiffLine {
  kind: LineKind
  /** The line's content, with the leading marker removed. */
  text: string
  /** Its number in the old file, or null — an added line has none. */
  old: number | null
  /** Its number in the new file, or null — a removed line has none. */
  new: number | null
}

export interface Hunk {
  /** The `@@ … @@` line exactly as git wrote it, including the trailing context git puts after it. */
  header: string
  lines: DiffLine[]
}

export type FileStatus = 'added' | 'removed' | 'renamed' | 'modified'

export interface FileDiff {
  /**
   * What to call this file on screen: the new path, or the old one when the file
   * was deleted. A rename shows both, which is what `from` is for.
   */
  path: string
  /** The old path, present only when it differs from `path`. */
  from: string | null
  status: FileStatus
  /** True when git said it would not print the content. There is nothing to render, and saying so is the point. */
  binary: boolean
  hunks: Hunk[]
  added: number
  removed: number
  /** Every line in every hunk, counted once, so a budget can be spent without walking the hunks twice. */
  lines: number
}

/**
 * `/dev/null` is git's way of saying the file did not exist on that side.
 *
 * Read rather than inferred from `new file mode`, because the mode lines are
 * optional in some producers and the null path is not.
 */
const NOWHERE = '/dev/null'

/**
 * Strip git's `a/` and `b/` prefixes, and leave anything else alone.
 *
 * Git writes them by default and `--no-prefix` omits them; a path that genuinely
 * begins `a/` is indistinguishable from a prefixed one, which is a real
 * ambiguity in the format rather than something this can solve. The common case
 * is chosen and the uncommon one is a slightly wrong label on a file that is
 * still there — never a missing file.
 */
const unprefix = (path: string): string =>
  path.startsWith('a/') || path.startsWith('b/') ? path.slice(2) : path

/**
 * The two numbers out of `@@ -12,7 +12,9 @@`.
 *
 * The counts are optional in the format — `@@ -1 +1 @@` is legal and means one
 * line — and are not needed here anyway: the lines themselves say how many there
 * are. Only the two starting numbers are read. `null` when the header is not one
 * this understands, and the caller then numbers nothing rather than numbering
 * wrongly.
 */
function starts(header: string): { old: number; new: number } | null {
  const m = /^@@+ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(header)
  if (!m) return null
  return { old: Number(m[1]), new: Number(m[2]) }
}

/**
 * One patch, as a list of files.
 *
 * Never throws, whatever it is handed. Input that is not a diff at all comes
 * back as an empty list, and the page draws that as "the tracker printed nothing
 * that looks like a diff" — which is a real thing that happens when a pull
 * request has no commits, and is not an error.
 */
export function parseDiff(text: string): FileDiff[] {
  const files: FileDiff[] = []
  /* Split on \n and tolerate \r\n by trimming the carriage return off each line.
     Not `split(/\r?\n/)`, because a lone \r inside a line is content and should
     not become a line break — that would silently change what the diff says.

     The last element is dropped when it is empty, and that is not cosmetic. Every
     patch ends with a newline, so `split` always leaves a final '' — and '' is a
     legal empty CONTEXT line inside a hunk, which is the one thing this parser
     must not misread. Left in, every diff gained a phantom last line: the counts
     were one too high and the line numbering ran one past the end of the file. */
  const lines = text.split('\n')
  if (lines.length && lines[lines.length - 1] === '') lines.pop()

  let file: FileDiff | null = null
  let hunk: Hunk | null = null
  let oldAt = 0
  let newAt = 0
  /** Whether the current hunk's header parsed, and therefore whether to number at all. */
  let numbering = false

  const closeFile = () => {
    if (file) files.push(file)
    file = null
    hunk = null
  }

  for (const raw of lines) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw

    if (line.startsWith('diff --git ')) {
      closeFile()
      /* The paths from the git header, which is the fallback: `a/x b/x` is
         unambiguous only when neither path contains a space. The `---`/`+++`
         lines below are the better source and overwrite this when they arrive.
         Taking the header as a starting point rather than waiting is what
         guarantees a file entry even for a rename with no content change, which
         has no `---` lines at all. */
      const rest = line.slice('diff --git '.length)
      const half = Math.floor(rest.length / 2)
      const guess = rest.slice(half + 1)
      file = {
        path: unprefix(guess || rest),
        from: null,
        status: 'modified',
        binary: false,
        hunks: [],
        added: 0,
        removed: 0,
        lines: 0,
      }
      hunk = null
      continue
    }

    if (!file) continue

    if (line.startsWith('--- ')) {
      const path = line.slice(4).trim()
      if (path === NOWHERE) file.status = 'added'
      else file.from = unprefix(path)
      hunk = null
      continue
    }

    if (line.startsWith('+++ ')) {
      const path = line.slice(4).trim()
      if (path === NOWHERE) {
        file.status = 'removed'
        /* The name of a deleted file is on the OLD side, and it is the only name
           it has. Showing `/dev/null` would be technically faithful and useless. */
        if (file.from) file.path = file.from
      } else {
        file.path = unprefix(path)
        /* A rename is the case where both sides exist and differ. Git says so
           explicitly with `rename from`/`rename to` as well, and that is read
           below; this catches producers that only emit the paths. */
        if (file.from && file.from !== file.path) file.status = 'renamed'
      }
      hunk = null
      continue
    }

    if (line.startsWith('rename from ')) {
      file.from = line.slice('rename from '.length).trim()
      file.status = 'renamed'
      continue
    }
    if (line.startsWith('rename to ')) {
      file.path = line.slice('rename to '.length).trim()
      file.status = 'renamed'
      continue
    }
    if (line.startsWith('new file mode')) {
      file.status = 'added'
      continue
    }
    if (line.startsWith('deleted file mode')) {
      file.status = 'removed'
      continue
    }

    /* Both spellings git uses. `Binary files … differ` is the default and
       `GIT binary patch` is what `--binary` produces; either way there is
       nothing to render and the file must still appear on the list. */
    if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) {
      file.binary = true
      hunk = null
      continue
    }

    if (line.startsWith('@@')) {
      const at = starts(line)
      hunk = { header: line, lines: [] }
      file.hunks.push(hunk)
      numbering = at !== null
      oldAt = at?.old ?? 0
      newAt = at?.new ?? 0
      continue
    }

    if (!hunk) continue

    /*
     * Inside a hunk. The first character is the marker and the rest is content,
     * with two exceptions worth naming:
     *
     * - `\ No newline at end of file` is git talking about the previous line
     *   rather than a line of the file. It is kept as a `note` so the reader
     *   sees it, and it is counted in neither side's numbering.
     * - An empty string is a context line whose content is empty. Git writes a
     *   single space there, but enough producers strip trailing whitespace that
     *   treating '' as "not part of the hunk" would end a hunk early and lose
     *   every line after it. Losing lines is the one thing this file will not do.
     */
    const marker = line[0] ?? ''
    if (marker === '\\') {
      hunk.lines.push({ kind: 'note', text: line.slice(1).trim(), old: null, new: null })
      file.lines += 1
      continue
    }
    if (marker === '+') {
      hunk.lines.push({ kind: 'add', text: line.slice(1), old: null, new: numbering ? newAt : null })
      newAt += 1
      file.added += 1
      file.lines += 1
      continue
    }
    if (marker === '-') {
      hunk.lines.push({ kind: 'del', text: line.slice(1), old: numbering ? oldAt : null, new: null })
      oldAt += 1
      file.removed += 1
      file.lines += 1
      continue
    }
    if (marker === ' ' || marker === '') {
      hunk.lines.push({
        kind: 'context',
        text: marker === '' ? '' : line.slice(1),
        old: numbering ? oldAt : null,
        new: numbering ? newAt : null,
      })
      oldAt += 1
      newAt += 1
      file.lines += 1
      continue
    }

    /*
     * Anything else ends the hunk rather than being swallowed.
     *
     * `index abc..def`, `similarity index`, `old mode`, and whatever a future
     * git writes between files all land here. Ending the hunk is right because
     * none of them is content; ignoring the line is right because inventing a
     * row for it would put git's bookkeeping in among somebody's code.
     */
    hunk = null
  }

  closeFile()
  return files
}

/** Every file, added and removed lines summed. What the header on the container says. */
export function totals(files: FileDiff[]): { files: number; added: number; removed: number; lines: number } {
  let added = 0
  let removed = 0
  let lines = 0
  for (const f of files) {
    added += f.added
    removed += f.removed
    lines += f.lines
  }
  return { files: files.length, added, removed, lines }
}
