import { locate } from '../forge/locate.ts'
import { isSha } from '../forge/read.ts'

import { metaOf, proposalOf } from './draft.ts'
import { keyOf } from './key.ts'
import {
  MAX_BODY,
  MAX_CAPTION,
  MAX_COMMENTS,
  MAX_LOG_BYTES,
  MAX_PATH,
  MAX_PICTURE_BYTES,
  MAX_PROOFS,
  MAX_QUOTE,
  MAX_REPLIES,
  MAX_SAID,
  MAX_SENT_LOG,
  MAX_SUMMARY,
  PROOF_FILE,
  PROOF_ID,
  PROOF_KINDS,
  RUN,
  THREAD,
  VERDICTS,
  changeOf,
  spell,
  stateOf,
  type By,
  type Comment,
  type Draft,
  type Evidence,
  type Meta,
  type Proof,
  type Proposal,
  type ReplyDraft,
  type SentRecord,
  type Verdict,
} from './shape.ts'

/**
 * The review as a Markdown file: `<project>/.kehikot/review/<key>.md`, the record behind the page.
 *
 * Written by `writeReview`, read back by `readReview`, and the two are each other's inverse:
 * `readReview(writeReview(d))` is `d`, and `writeReview` of that is the same text, byte for byte.
 * A person can read it, and `git diff` it, and it is still the one source of truth.
 *
 * ## The rules that make it readable AND exact
 *
 * - Front matter (`---` lines) holds the change and what a glance needs: head, verdict, door,
 *   uiux, status.
 * - Every section is in a fixed order: Summary, Points, Evidence, Replies, Sent. One `###` heading
 *   per point, piece of evidence, reply, or send.
 * - Short values are `- Key: value` lines, in a fixed order per section. A value is written as it
 *   is when it is one plain line; otherwise (a newline, a backslash, a quote first, spaces at an
 *   end, nothing at all) it is written as a JSON string, so nothing is ever lost or guessed.
 * - Words a person or an agent wrote — a point's text, the quoted code, a summary, a reply — are
 *   fenced blocks (```` ```text body ````), with a fence longer than any run of backticks inside, so
 *   whatever the words say they cannot end their own block.
 * - A code reference is link-like: `- Code: src/app.ts:40-42@<commit>`.
 *
 * ## Strict
 *
 * The reader refuses anything it did not write, with the line it stopped at. A file a person or a
 * merge has been at is somebody's work, and reading it "roughly" would be rewriting it on the
 * next save; refusing leaves it as it is, and says where.
 */

export const FORMAT = 1

/* ------------------------------------------------------------------ *
 * Values
 * ------------------------------------------------------------------ */

const PLAIN = /^[^\s"\\\u0000-\u001f\u007f][^\\\u0000-\u001f\u007f]*$/u

/** A value as it is written after `Key: `: itself when it is one plain line, else a JSON string. */
export function inline(value: string): string {
  return PLAIN.test(value) && !/\s$/u.test(value) ? value : JSON.stringify(value)
}

function uninline(raw: string, at: number): string {
  if (!raw.startsWith('"')) return raw
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    throw new Unreadable(at, 'a value that opens with a quote is a JSON string, and this one does not parse')
  }
  if (typeof value !== 'string') throw new Unreadable(at, 'a quoted value is a JSON string')
  return value
}

/** Text as a fenced block: info string `text <name>`, a fence longer than any run of backticks inside. */
function fence(name: string, text: string): string[] {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length))
  const ticks = '`'.repeat(Math.max(3, longest + 1))
  return [`${ticks}text ${name}`, ...(text === '' ? [] : text.split('\n')), ticks]
}

/** What the folder of a review's evidence is called, relative to the review file. */
export const evidenceFolder = (key: string): string => key

/* ------------------------------------------------------------------ *
 * Writing
 * ------------------------------------------------------------------ */

export type Status = 'empty' | 'draft' | 'sent'

/** Where the review stands, in one word, for the front matter. Derived; never read back as data. */
export function statusOf(draft: Draft): Status {
  const waiting = draft.comments.some((c) => !c.sent) || draft.replies.some((r) => !r.sent) || draft.summary.trim() !== '' || draft.verdict !== null
  if (waiting) return 'draft'
  if (draft.sent.length || draft.comments.some((c) => c.sent) || draft.replies.some((r) => r.sent)) return 'sent'
  return draft.evidence.length ? 'draft' : 'empty'
}

/** A comment's code reference, link-like: `path:line@commit`, or `path:first-last@commit`. */
export function codeRef(comment: Pick<Comment, 'path' | 'line' | 'startLine' | 'commit'>): string {
  return `${comment.path}:${comment.startLine !== undefined ? `${comment.startLine}-${comment.line}` : comment.line}@${comment.commit}`
}

const yesNo = (value: boolean) => (value ? 'yes' : 'no')

/** The review as Markdown. `key` names the folder its evidence is in (`<key>/`), beside it. */
export function writeReview(draft: Draft, key: string): string {
  const out: string[] = []
  const bullet = (name: string, value: string) => out.push(`- ${name}: ${inline(value)}`)
  const blank = () => out.push('')

  const p = draft.proposal
  out.push('---', `review: ${FORMAT}`, `change: ${inline(draft.change.url)}`)
  if (draft.head) out.push(`head: ${draft.head}`)
  out.push(`verdict: ${draft.verdict ?? 'none'}`)
  if (draft.verdictBy) out.push(`verdict-by: ${draft.verdictBy}`)
  if (draft.summaryBy) out.push(`summary-by: ${draft.summaryBy}`)
  if (p) out.push(`door: ${p.door}`, `uiux: ${yesNo(p.uiux)}`)
  out.push(`status: ${statusOf(draft)}`, '---', '', `# Review of ${inline(spell(draft.change))}`, '')

  /* ---- Summary ---- */
  out.push('## Summary', '', ...fence('summary', draft.summary))
  if (p) {
    blank()
    out.push(`### Proposed by run ${p.run}`, '')
    bullet('Verdict', p.verdict)
    bullet('Head', p.head)
    bullet('At', p.at)
    if (p.taken?.summary !== undefined) bullet('Taken summary', p.taken.summary)
    if (p.taken?.verdict !== undefined) bullet('Taken verdict', p.taken.verdict)
    if (p.sent) {
      bullet('Sent', p.sent.at)
      bullet('Sent at head', p.sent.head)
    }
    blank()
    out.push(...fence('proposal', p.summary))
    if (p.pathToSuccess.length) {
      out.push('', 'To get this approved:', '')
      p.pathToSuccess.forEach((step, at) => out.push(`${at + 1}. ${inline(step)}`))
    }
  }

  /* ---- Points ---- */
  out.push('', '## Points')
  if (!draft.comments.length) out.push('', 'None.')
  for (const c of draft.comments) {
    out.push('', `### ${inline(c.id)}`, '')
    bullet('Code', codeRef(c))
    bullet('Side', c.side)
    bullet('Diff', c.view === 'all' ? 'whole change' : 'commit')
    if (c.parent) bullet('Parent', c.parent)
    if (c.oldPath) bullet('Was', c.oldPath)
    if (c.otherLine !== undefined) bullet('Other line', String(c.otherLine))
    bullet('By', c.by)
    bullet('At', c.at)
    if (c.editedAt !== undefined) bullet('Edited', c.editedAt)
    bullet('State', stateOf(c))
    if (c.kept !== undefined) bullet('Kept', c.kept)
    if (c.sent) {
      bullet('Sent', c.sent.at)
      if (c.sent.url !== undefined) bullet('Sent to', c.sent.url)
      if (c.sent.folded) bullet('Folded', 'yes')
    }
    if (c.resolved !== undefined) bullet('Resolved', c.resolved)
    const m = c.meta
    if (m) {
      bullet('Severity', m.severity)
      bullet('Ruling', m.ruling)
      bullet('Reason', m.reason)
      bullet('Run', m.run)
      if (m.head) bullet('Read at', m.head)
      for (const e of m.evidence) {
        out.push(`- Evidence: ${e.kind} ${inline(e.ref)}`)
        if (e.quote !== undefined) out.push(`  - Quote: ${inline(e.quote)}`)
      }
      if (m.challenge !== undefined) bullet('Challenge', m.challenge)
      for (const item of m.checklist ?? []) bullet('Checklist', item)
    }
    out.push('', ...fence('quote', c.quote), '', ...fence('body', c.body))
  }

  /* ---- Evidence ---- */
  out.push('', '## Evidence')
  if (!draft.evidence.length) out.push('', 'None.')
  for (const e of draft.evidence) {
    out.push('', `### ${e.id}`, '')
    bullet('Kind', e.kind)
    bullet('Caption', e.caption)
    bullet('File', e.file)
    bullet('Size', `${e.bytes} bytes`)
    if (e.point !== undefined) bullet('Point', e.point)
    if (e.run !== undefined) bullet('Run', e.run)
    bullet('By', e.by)
    bullet('At', e.at)
    out.push('', proofLink(e, key))
  }

  /* ---- Replies ---- */
  out.push('', '## Replies')
  if (!draft.replies.length) out.push('', 'None.')
  for (const r of draft.replies) {
    out.push('', `### ${r.id}`, '')
    bullet('Thread', r.thread)
    bullet('Where', r.where)
    bullet('From', r.from)
    bullet('By', r.by)
    bullet('At', r.at)
    if (r.editedAt !== undefined) bullet('Edited', r.editedAt)
    bullet('State', r.sent ? 'sent' : 'draft')
    if (r.sent) {
      bullet('Sent', r.sent.at)
      if (r.sent.url !== undefined) bullet('Sent to', r.sent.url)
    }
    out.push('', ...fence('said', r.said), '', ...fence('reply', r.body), '', ...fence('change', r.todo))
  }

  /* ---- Sent ---- */
  out.push('', '## Sent')
  if (!draft.sent.length) out.push('', 'None.')
  for (const s of draft.sent) {
    out.push('', `### Sent ${inline(s.at)}`, '')
    bullet('Verdict', s.verdict)
    bullet('Head', s.head)
    bullet('Comments', String(s.comments))
    for (const note of s.notes) bullet('Note', note)
    out.push('', ...fence('summary', s.summary))
  }

  out.push('')
  return out.join('\n')
}

/** The line that shows a piece of evidence where Markdown is rendered: a picture, or a link to the text. */
const proofLink = (e: Pick<Proof, 'kind' | 'file'>, key: string): string =>
  e.kind === 'screenshot' ? `![screenshot](${evidenceFolder(key)}/${e.file})` : `[${e.file}](${evidenceFolder(key)}/${e.file})`

/* ------------------------------------------------------------------ *
 * Reading
 * ------------------------------------------------------------------ */

/** Why a file is not a review this module can read: a line number (from 1) and what was expected there. */
export class Unreadable extends Error {
  constructor(
    readonly line: number,
    readonly why: string,
  ) {
    super(`line ${line}: ${why}`)
  }
}

export type ReadReview = { ok: true; draft: Draft } | { ok: false; error: string }

interface Bullet {
  name: string
  value: string
  at: number
  sub: { name: string; value: string; at: number }[]
}

class Cursor {
  private i = 0
  constructor(private readonly all: string[]) {}

  get line(): number {
    return this.i + 1
  }

  peek(): string | undefined {
    return this.all[this.i]
  }

  done(): boolean {
    return this.i >= this.all.length
  }

  next(what: string): string {
    const line = this.all[this.i]
    if (line === undefined) throw new Unreadable(this.line, `the file ends where ${what} was expected`)
    this.i += 1
    return line
  }

  exact(text: string): void {
    const at = this.line
    const line = this.next(JSON.stringify(text))
    if (line !== text) throw new Unreadable(at, `expected ${JSON.stringify(text)}, found ${JSON.stringify(line.slice(0, 80))}`)
  }

  blank(): void {
    this.exact('')
  }

  /** `prefix` then the rest of the line. */
  after(prefix: string): { rest: string; at: number } {
    const at = this.line
    const line = this.next(JSON.stringify(prefix))
    if (!line.startsWith(prefix)) throw new Unreadable(at, `expected a line starting ${JSON.stringify(prefix)}, found ${JSON.stringify(line.slice(0, 80))}`)
    return { rest: line.slice(prefix.length), at }
  }

  fence(name: string): string {
    const at = this.line
    const open = this.next(`a \`\`\`text ${name} block`)
    const m = /^(`{3,})text (\S+)$/.exec(open)
    if (!m || m[2] !== name) throw new Unreadable(at, `expected a fenced block opened with \`\`\`text ${name}`)
    const ticks = m[1]!
    const body: string[] = []
    for (;;) {
      if (this.done()) throw new Unreadable(at, `the \`\`\`text ${name} block is never closed`)
      const line = this.next('the end of the block')
      if (line === ticks) break
      body.push(line)
    }
    return body.join('\n')
  }

  bullets(): Bullet[] {
    const out: Bullet[] = []
    while (!this.done() && this.peek()!.startsWith('- ')) {
      const at = this.line
      const m = /^- ([A-Z][A-Za-z ]*): (.*)$/.exec(this.next('a value'))
      if (!m) throw new Unreadable(at, 'expected "- Name: value"')
      const one: Bullet = { name: m[1]!, value: m[2]!, at, sub: [] }
      while (!this.done() && this.peek()!.startsWith('  - ')) {
        const subAt = this.line
        const s = /^ {2}- ([A-Z][A-Za-z ]*): (.*)$/.exec(this.next('a value'))
        if (!s) throw new Unreadable(subAt, 'expected "  - Name: value"')
        one.sub.push({ name: s[1]!, value: s[2]!, at: subAt })
      }
      out.push(one)
    }
    return out
  }
}

/** Takes named values off a list of bullets in order: the order the writer wrote them in is the only order read. */
class Fields {
  private i = 0
  constructor(
    private readonly list: Bullet[],
    private readonly at: number,
  ) {}

  private here(): Bullet | undefined {
    return this.list[this.i]
  }

  maybe(name: string): string | undefined {
    const one = this.here()
    if (!one || one.name !== name) return undefined
    if (one.sub.length) throw new Unreadable(one.sub[0]!.at, `"${name}" has nothing under it`)
    this.i += 1
    return uninline(one.value, one.at)
  }

  take(name: string): string {
    const got = this.maybe(name)
    if (got === undefined) throw new Unreadable(this.here()?.at ?? this.at, `expected "- ${name}: …" here`)
    return got
  }

  /** A run of one name, each with what is under it. */
  many(name: string): Bullet[] {
    const out: Bullet[] = []
    while (this.here()?.name === name) out.push(this.list[this.i++]!)
    return out
  }

  end(): void {
    const left = this.here()
    if (left) throw new Unreadable(left.at, `"${left.name}" is not expected here`)
  }
}

const oneOf = <T extends string>(value: string, allowed: readonly T[], at: number, what: string): T => {
  const found = allowed.find((one) => one === value)
  if (found === undefined) throw new Unreadable(at, `${what} is one of ${allowed.join(', ')}`)
  return found
}

const bounded = (value: string, max: number, at: number, what: string): string => {
  if (value.length > max) throw new Unreadable(at, `${what} is at most ${max} characters`)
  return value
}

const sha = (value: string, at: number, what: string): string => {
  if (!isSha(value)) throw new Unreadable(at, `${what} is a commit id: 7 to 64 lowercase hex characters`)
  return value
}

const by = (value: string, at: number): By => oneOf(value, ['person', 'agent'] as const, at, 'By')

const time = (value: string, at: number): string => bounded(value, 40, at, 'a time')

const whole = (value: string, at: number, what: string): number => {
  if (!/^[1-9][0-9]{0,9}$/.test(value)) throw new Unreadable(at, `${what} is a whole number from 1`)
  return Number(value)
}

const CODE = /^([\s\S]+):([1-9][0-9]{0,9})(?:-([1-9][0-9]{0,9}))?@([0-9a-f]{7,64})$/

/** The review a Markdown file holds, or why it is not one. Strict: see the top of this file. */
export function readReview(text: string): ReadReview {
  try {
    return { ok: true, draft: parse(text) }
  } catch (e) {
    if (e instanceof Unreadable) return { ok: false, error: e.message }
    throw e
  }
}

function parse(text: string): Draft {
  if (!text.endsWith('\n')) throw new Unreadable(text.split('\n').length, 'the file does not end with a newline')
  const c = new Cursor(text.slice(0, -1).split('\n'))

  /* ---- front matter ---- */
  c.exact('---')
  const head: Record<string, { value: string; at: number }> = {}
  const order = ['review', 'change', 'head', 'verdict', 'verdict-by', 'summary-by', 'door', 'uiux', 'status']
  let last = -1
  for (;;) {
    const at = c.line
    const line = c.next('the end of the front matter (---)')
    if (line === '---') break
    const m = /^([a-z-]+): (.*)$/.exec(line)
    if (!m) throw new Unreadable(at, 'expected "name: value" in the front matter')
    const place = order.indexOf(m[1]!)
    if (place < 0) throw new Unreadable(at, `"${m[1]}" is not something a review's front matter says`)
    if (place <= last) throw new Unreadable(at, `"${m[1]}" is out of order`)
    last = place
    head[m[1]!] = { value: m[2]!, at }
  }
  const front = (name: string): { value: string; at: number } => {
    const got = head[name]
    if (!got) throw new Unreadable(c.line, `the front matter has no "${name}"`)
    return got
  }
  if (front('review').value !== String(FORMAT)) throw new Unreadable(front('review').at, `this is review format ${front('review').value}; this Review reads format ${FORMAT}`)
  const changeAt = front('change')
  const target = locate(uninline(changeAt.value, changeAt.at))
  if (!target) throw new Unreadable(changeAt.at, 'change is the pull or merge request’s URL on its tracker')
  const change = changeOf(target)
  const headSha = head.head ? sha(head.head.value, head.head.at, 'head') : undefined
  const verdictAt = front('verdict')
  const verdict: Verdict | null = verdictAt.value === 'none' ? null : oneOf(verdictAt.value, VERDICTS, verdictAt.at, 'verdict')
  const verdictBy = head['verdict-by'] ? by(head['verdict-by'].value, head['verdict-by'].at) : undefined
  const summaryBy = head['summary-by'] ? by(head['summary-by'].value, head['summary-by'].at) : undefined
  const door = head.door ? oneOf(head.door.value, ['one-way', 'two-way'] as const, head.door.at, 'door') : undefined
  const uiux = head.uiux ? oneOf(head.uiux.value, ['yes', 'no'] as const, head.uiux.at, 'uiux') === 'yes' : undefined
  if ((door === undefined) !== (uiux === undefined)) throw new Unreadable(front('status').at, 'door and uiux come together, from a run’s proposal')
  oneOf(front('status').value, ['empty', 'draft', 'sent'] as const, front('status').at, 'status')

  c.blank()
  c.exact(`# Review of ${inline(spell(change))}`)
  c.blank()

  /* ---- summary ---- */
  c.exact('## Summary')
  c.blank()
  const summary = bounded(c.fence('summary'), MAX_SUMMARY, c.line, 'the summary')
  let proposal: Proposal | undefined
  c.blank()
  if (c.peek()?.startsWith('### Proposed by run ')) {
    const { rest: run, at } = c.after('### Proposed by run ')
    if (!RUN.test(run)) throw new Unreadable(at, 'a run is named by letters, digits and . _ : -')
    if (door === undefined || uiux === undefined) throw new Unreadable(at, 'a proposal needs door and uiux in the front matter')
    c.blank()
    const f = new Fields(c.bullets(), c.line)
    const pVerdict = f.take('Verdict')
    const pHead = f.take('Head')
    const pAt = f.take('At')
    const takenSummary = f.maybe('Taken summary')
    const takenVerdict = f.maybe('Taken verdict')
    const sentAt = f.maybe('Sent')
    const sentHead = sentAt !== undefined ? f.take('Sent at head') : undefined
    f.end()
    c.blank()
    const pSummary = c.fence('proposal')
    const steps: string[] = []
    c.blank()
    if (c.peek() === 'To get this approved:') {
      c.exact('To get this approved:')
      c.blank()
      while (c.peek() !== undefined && /^[1-9][0-9]*\. /.test(c.peek()!)) {
        const { rest, at: stepAt } = c.after(`${steps.length + 1}. `)
        steps.push(uninline(rest, stepAt))
      }
      c.blank()
    }
    const checked = proposalOf({ run, summary: pSummary, verdict: pVerdict, door, uiux, pathToSuccess: steps })
    if (!checked.ok) throw new Unreadable(at, `the proposal: ${checked.error}`)
    if (checked.proposal.summary !== pSummary) throw new Unreadable(at, 'the proposal’s words have spaces at an end')
    proposal = {
      ...checked.proposal,
      head: sha(pHead, at, 'the proposal’s head'),
      at: time(pAt, at),
      ...(takenSummary !== undefined || takenVerdict !== undefined
        ? { taken: { ...(takenSummary !== undefined ? { summary: time(takenSummary, at) } : {}), ...(takenVerdict !== undefined ? { verdict: time(takenVerdict, at) } : {}) } }
        : {}),
      ...(sentAt !== undefined ? { sent: { at: time(sentAt, at), head: sha(sentHead!, at, 'the head it was sent at') } } : {}),
    }
  } else if (door !== undefined) {
    throw new Unreadable(c.line, 'door and uiux are a run’s, and there is no proposal')
  }

  /* ---- points ---- */
  c.exact('## Points')
  const comments: Comment[] = []
  c.blank()
  if (c.peek() === 'None.') {
    c.exact('None.')
    c.blank()
  } else {
    while (c.peek()?.startsWith('### ')) {
      comments.push(point(c))
      if (comments.length > MAX_COMMENTS * 2) throw new Unreadable(c.line, 'more points than one review holds')
      c.blank()
    }
  }

  /* ---- evidence ---- */
  c.exact('## Evidence')
  const evidence: Proof[] = []
  c.blank()
  if (c.peek() === 'None.') {
    c.exact('None.')
    c.blank()
  } else {
    while (c.peek()?.startsWith('### ')) {
      const proof = proofOf(c, comments, keyOf(target))
      evidence.push(proof)
      if (evidence.length > MAX_PROOFS) throw new Unreadable(c.line, 'more evidence than one review holds')
      c.blank()
    }
  }

  /* ---- replies ---- */
  c.exact('## Replies')
  const replies: ReplyDraft[] = []
  c.blank()
  if (c.peek() === 'None.') {
    c.exact('None.')
    c.blank()
  } else {
    while (c.peek()?.startsWith('### ')) {
      replies.push(reply(c))
      if (replies.length > MAX_REPLIES * 2) throw new Unreadable(c.line, 'more replies than one review holds')
      c.blank()
    }
  }

  /* ---- sent ---- */
  c.exact('## Sent')
  const sent: SentRecord[] = []
  c.blank()
  if (c.peek() === 'None.') {
    c.exact('None.')
  } else {
    for (;;) {
      sent.push(record(c))
      if (sent.length > MAX_SENT_LOG) throw new Unreadable(c.line, `more than ${MAX_SENT_LOG} sends`)
      if (c.done()) break
      c.blank()
    }
  }
  if (!c.done()) throw new Unreadable(c.line, 'nothing is expected after the last section')

  const ids = new Set<string>()
  for (const one of [...comments, ...evidence, ...replies]) {
    if (ids.has(one.id)) throw new Unreadable(1, `"${one.id}" is used twice`)
    ids.add(one.id)
  }

  return {
    version: 1,
    change,
    comments,
    summary,
    verdict,
    sent,
    ...(summaryBy ? { summaryBy } : {}),
    ...(verdictBy ? { verdictBy } : {}),
    ...(proposal ? { proposal } : {}),
    ...(headSha ? { head: headSha } : {}),
    evidence,
    replies,
  }
}

function point(c: Cursor): Comment {
  const { rest, at } = c.after('### ')
  const id = bounded(uninline(rest, at), 40, at, 'a point’s id')
  if (!id) throw new Unreadable(at, 'a point has an id')
  c.blank()
  const f = new Fields(c.bullets(), c.line)
  const code = CODE.exec(f.take('Code'))
  if (!code) throw new Unreadable(at, 'Code is path:line@commit, or path:first-last@commit')
  const path = bounded(code[1]!, MAX_PATH, at, 'a path')
  const first = Number(code[2])
  const last = code[3] !== undefined ? Number(code[3]) : undefined
  if (last !== undefined && last <= first) throw new Unreadable(at, 'a range ends after it starts')
  const side = oneOf(f.take('Side'), ['new', 'old'] as const, at, 'Side')
  const view = f.take('Diff') === 'commit' ? ('commit' as const) : ('all' as const)
  const parent = f.maybe('Parent')
  const oldPath = f.maybe('Was')
  const other = f.maybe('Other line')
  const who = by(f.take('By'), at)
  const when = time(f.take('At'), at)
  const edited = f.maybe('Edited')
  const state = f.take('State')
  const kept = f.maybe('Kept')
  const sentAt = f.maybe('Sent')
  const sentTo = sentAt !== undefined ? f.maybe('Sent to') : undefined
  const folded = sentAt !== undefined ? f.maybe('Folded') : undefined
  const resolved = f.maybe('Resolved')
  let meta: Meta | undefined
  const severity = f.maybe('Severity')
  if (severity !== undefined) {
    const ruling = f.take('Ruling')
    const reason = f.take('Reason')
    const run = f.take('Run')
    const readAt = f.maybe('Read at')
    const evidence: Evidence[] = f.many('Evidence').map((one) => {
      const m = /^([a-z]+) (.+)$/.exec(one.value)
      if (!m) throw new Unreadable(one.at, 'Evidence is its kind, then its source')
      const quote = one.sub.find((s) => s.name === 'Quote')
      if (one.sub.some((s) => s.name !== 'Quote') || one.sub.length > 1) throw new Unreadable(one.at, 'under Evidence there is only a Quote')
      return { kind: m[1] as Evidence['kind'], ref: uninline(m[2]!, one.at), ...(quote ? { quote: uninline(quote.value, quote.at) } : {}) }
    })
    const challenge = f.maybe('Challenge')
    const checklist = f.many('Checklist').map((one) => uninline(one.value, one.at))
    const checked = metaOf({ run, severity, evidence, ...(challenge !== undefined ? { challenge } : {}), ruling, reason, ...(checklist.length ? { checklist } : {}) })
    if (!checked.ok) throw new Unreadable(at, `point ${id}: ${checked.error}`)
    meta = { ...checked.meta, ...(readAt !== undefined ? { head: sha(readAt, at, 'Read at') } : {}) }
  }
  f.end()
  c.blank()
  const quote = bounded(c.fence('quote'), MAX_QUOTE, at, 'the quoted code')
  c.blank()
  const body = bounded(c.fence('body'), MAX_BODY, at, 'a point’s text')
  if (folded !== undefined && folded !== 'yes') throw new Unreadable(at, 'Folded is yes, or left out')
  const comment: Comment = {
    id,
    view,
    commit: sha(code[4]!, at, 'the commit'),
    ...(parent !== undefined ? { parent: sha(parent, at, 'Parent') } : {}),
    path,
    ...(oldPath !== undefined ? { oldPath: bounded(oldPath, MAX_PATH, at, 'Was') } : {}),
    side,
    line: last ?? first,
    ...(last !== undefined ? { startLine: first } : {}),
    ...(other !== undefined ? { otherLine: whole(other, at, 'Other line') } : {}),
    quote,
    body,
    by: who,
    at: when,
    ...(edited !== undefined ? { editedAt: time(edited, at) } : {}),
    ...(sentAt !== undefined
      ? { sent: { at: time(sentAt, at), ...(sentTo !== undefined ? { url: bounded(sentTo, 600, at, 'Sent to') } : {}), ...(folded ? { folded: true } : {}) } }
      : {}),
    ...(meta ? { meta } : {}),
    ...(kept !== undefined ? { kept: time(kept, at) } : {}),
    ...(resolved !== undefined ? { resolved: time(resolved, at) } : {}),
  }
  if (resolved !== undefined && !comment.sent) throw new Unreadable(at, 'only a sent point is resolved')
  if (stateOf(comment) !== state) throw new Unreadable(at, `State says ${state}, and what is written says ${stateOf(comment)}`)
  return comment
}

function proofOf(c: Cursor, comments: readonly Comment[], key: string): Proof {
  const { rest: id, at } = c.after('### ')
  if (!PROOF_ID.test(id)) throw new Unreadable(at, 'a piece of evidence is named e- and twelve hex digits')
  c.blank()
  const f = new Fields(c.bullets(), c.line)
  const kind = oneOf(f.take('Kind'), PROOF_KINDS, at, 'Kind')
  const caption = bounded(f.take('Caption'), MAX_CAPTION, at, 'Caption')
  const file = f.take('File')
  if (!PROOF_FILE.test(file) || !file.startsWith(`${id}.`)) throw new Unreadable(at, 'File is the evidence’s id and an extension')
  if ((kind === 'screenshot') === file.endsWith('.txt')) throw new Unreadable(at, 'a screenshot is a picture, and a log or test output is text')
  const size = /^([0-9]{1,10}) bytes$/.exec(f.take('Size'))
  if (!size) throw new Unreadable(at, 'Size is "<n> bytes"')
  const bytes = Number(size[1])
  if (bytes > (kind === 'screenshot' ? MAX_PICTURE_BYTES : MAX_LOG_BYTES)) throw new Unreadable(at, 'larger than evidence of that kind may be')
  const pointId = f.maybe('Point')
  if (pointId !== undefined && !comments.some((one) => one.id === pointId)) throw new Unreadable(at, `there is no point ${pointId} above`)
  const run = f.maybe('Run')
  if (run !== undefined && !RUN.test(run)) throw new Unreadable(at, 'a run is named by letters, digits and . _ : -')
  const who = by(f.take('By'), at)
  const when = time(f.take('At'), at)
  f.end()
  c.blank()
  /* The picture or link line is the writer's own, from the file's name: read as it would be written. */
  const linkAt = c.line
  const link = c.next('the evidence’s link')
  if (link !== proofLink({ kind, file }, key)) throw new Unreadable(linkAt, 'expected the link to the evidence’s file')
  return { id, kind, caption, file, bytes, ...(pointId !== undefined ? { point: pointId } : {}), ...(run !== undefined ? { run } : {}), by: who, at: when }
}

function reply(c: Cursor): ReplyDraft {
  const { rest: id, at } = c.after('### ')
  if (!/^r-[0-9a-f]{12}$/.test(id)) throw new Unreadable(at, 'a reply is named r- and twelve hex digits')
  c.blank()
  const f = new Fields(c.bullets(), c.line)
  const thread = f.take('Thread')
  if (!THREAD.test(thread)) throw new Unreadable(at, 'Thread names a forge thread this module can answer')
  const where = bounded(f.take('Where'), MAX_PATH + 20, at, 'Where')
  const from = bounded(f.take('From'), 100, at, 'From')
  const who = by(f.take('By'), at)
  const when = time(f.take('At'), at)
  const edited = f.maybe('Edited')
  const state = oneOf(f.take('State'), ['draft', 'sent'] as const, at, 'State')
  const sentAt = f.maybe('Sent')
  const sentTo = sentAt !== undefined ? f.maybe('Sent to') : undefined
  f.end()
  if ((state === 'sent') !== (sentAt !== undefined)) throw new Unreadable(at, 'a sent reply says when it was sent, and a draft does not')
  c.blank()
  const said = bounded(c.fence('said'), MAX_SAID, at, 'what was said')
  c.blank()
  const body = bounded(c.fence('reply'), MAX_BODY, at, 'a reply')
  c.blank()
  const todo = bounded(c.fence('change'), MAX_BODY, at, 'what to change')
  return {
    id,
    thread,
    where,
    from,
    said,
    body,
    todo,
    by: who,
    at: when,
    ...(edited !== undefined ? { editedAt: time(edited, at) } : {}),
    ...(sentAt !== undefined ? { sent: { at: time(sentAt, at), ...(sentTo !== undefined ? { url: bounded(sentTo, 600, at, 'Sent to') } : {}) } } : {}),
  }
}

function record(c: Cursor): SentRecord {
  const { rest, at } = c.after('### Sent ')
  const when = time(uninline(rest, at), at)
  c.blank()
  const f = new Fields(c.bullets(), c.line)
  const verdict = oneOf(f.take('Verdict'), VERDICTS, at, 'Verdict')
  const head = bounded(f.take('Head'), 64, at, 'Head')
  const comments = f.take('Comments')
  if (!/^(0|[1-9][0-9]{0,9})$/.test(comments)) throw new Unreadable(at, 'Comments is a whole number')
  const notes = f.many('Note').map((one) => bounded(uninline(one.value, one.at), 1000, one.at, 'a note'))
  if (notes.length > 40) throw new Unreadable(at, 'at most 40 notes')
  f.end()
  c.blank()
  const summary = bounded(c.fence('summary'), MAX_SUMMARY, at, 'the summary sent')
  return { at: when, verdict, head, comments: Number(comments), summary, notes }
}

/** Whether two reviews say the same thing: what a migration checks before it lets the old file go. */
export function sameReview(a: Draft, b: Draft): boolean {
  return canonical(a) === canonical(b)
}

function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined).sort(([x], [y]) => (x < y ? -1 : 1)))
      : v,
  )
}
