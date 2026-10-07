import type { Target } from './locate.ts'
import type { Ran, Run, Runner } from './run.ts'

/**
 * Reading one change off its tracker: what it is, its commits, and a diff.
 *
 * Three questions, each asked through the tracker's own CLI and each split the
 * same way: a pure function that builds the argv (asserted exactly in
 * `test/read.test.ts`, because the argv IS the security property), a pure
 * function that reads the answer, and a thin async function that puts a
 * `Runner` between them.
 *
 * ## Why this asks the forge and does not take the host's word for the head
 *
 * The host's tracker reading has a head commit in a ref's detail, and Diff uses
 * it. A review cannot: the head is what a comment is ANCHORED to and what an
 * approval is an approval OF, and the reading is a snapshot from whenever
 * somebody last refreshed. Approving "the head" on the strength of a
 * ten-minute-old reading is approving commits nobody looked at. So `describe`
 * asks the forge every time, and the same call is made again just before a
 * send.
 *
 * ## Every endpoint here was run against a real tracker
 *
 * `gh api repos/{r}/pulls/{n}`, `…/pulls/{n}/commits`, the `diff` media type on
 * both a pull and a commit, and on GitLab `merge_requests/{n}` (with
 * `diff_refs`), `…/commits`, `repository/commits/{sha}/diff` and `glab mr diff
 * --raw`. The fixtures in the tests are cut from those answers.
 */

export type Read<T> = { ok: true; value: T } | { ok: false; error: string }

/**
 * What a commit id looks like, and the only thing allowed into argv as one.
 *
 * Lowercase hex, seven to sixty-four characters: an abbreviation git would
 * print, up to a full SHA-256. A sha reaches this file from a query string, an
 * MCP argument and a draft on disk, and it is spliced into an API PATH — so a
 * value like `abc/../../user` would be a different endpoint, not a different
 * commit. Matched against what it is rather than scanned for what it must not
 * contain, for the reason `locate.ts` gives.
 */
export const SHA = /^[0-9a-f]{7,64}$/

export const isSha = (value: unknown): value is string => typeof value === 'string' && SHA.test(value)

/** How many commits of one change are listed. The trackers page at 100 and a review of more is not a review. */
export const MAX_COMMITS = 100

const MAX_TITLE = 300
const MAX_PERSON = 100

/** A stranger's string, as a bounded string. Anything else is the empty string, never `undefined` in a sentence. */
const text = (value: unknown, max: number): string => (typeof value === 'string' ? value.slice(0, max) : '')

export type ChangeState = 'open' | 'closed' | 'merged'

export interface Described {
  /** The commit at the head of the change right now, as the forge says. */
  head: string
  /**
   * The commit the change's diff is measured from.
   *
   * On GitLab this is `diff_refs.base_sha`, the merge base. On GitHub it is
   * `base.sha`, the tip of the target branch — which is NOT what the diff is
   * measured from (that is the merge base, and GitHub does not print it here).
   * Nothing in this module computes with a GitHub base; it is carried so the
   * page can show it and so the two forges answer in one shape.
   */
  base: string
  /** GitLab's `diff_refs.start_sha`: the target branch commit the MR's diff version started from. Same as `base` on GitHub. */
  start: string
  title: string
  state: ChangeState
  draft: boolean
  author: string
  url: string
}

export interface Commit {
  sha: string
  /** The first line of the message. */
  title: string
  author: string
  /** When it was authored, as the forge printed it. */
  at: string
  parents: string[]
}

export interface Commits {
  /** Oldest first: the order a reviewer walks them in, and the order GitHub posts reviews against. */
  commits: Commit[]
  /** True when the forge's page was full, so there may be commits this list does not have. */
  more: boolean
}

/** Which diff: everything the change does, or what one commit did. */
export type Range = { view: 'all'; sha: string } | { view: 'commit'; sha: string }

export interface Patch {
  /** A unified diff `src/diff/parse.ts` reads. */
  text: string
  /** Whether a cap cut it short. The page says so; it never hides it. */
  truncated: boolean
  view: Range['view']
  /** The commit it was read at: the head for `all`, the commit itself otherwise. */
  sha: string
  from: 'cli' | 'cache'
}

/* ------------------------------------------------------------------ *
 * The command lines
 * ------------------------------------------------------------------ */

/**
 * GitLab's name for a project inside an API path: the namespace path,
 * URL-encoded, so `group/sub/project` is ONE path segment.
 *
 * `encodeURIComponent` is not decoration here. `locate` already limits a
 * segment to letters, digits, dot, dash and underscore, so the only character
 * this ever escapes is the slash — and that one has to be escaped or the path
 * means something else.
 */
const project = (target: Target): string => `projects/${encodeURIComponent(target.repo)}`

/** `glab api <path>` on the right host. Exported for `send.ts`, which posts through the same door. */
export function glabApi(target: Target, path: string, more: string[] = []): Run {
  /* `--hostname` rather than `GITLAB_HOST`: `glab api` resolves its host from
     the current directory's remote first, and this server's directory is this
     module's own repository — which is on GitHub. Saying the host on the
     command line is the one spelling that cannot be overridden by where the
     process happens to be standing. */
  return { cmd: 'glab', args: ['api', path, ...more, ...(target.host ? ['--hostname', target.host] : [])] }
}

export function ghApi(path: string, more: string[] = []): Run {
  return { cmd: 'gh', args: ['api', path, ...more] }
}

/** GitHub's media type for "this resource, as a unified diff". */
const GITHUB_DIFF = ['-H', 'Accept: application/vnd.github.diff']

export function describeCommand(target: Target): Run {
  return target.forge === 'github'
    ? ghApi(`repos/${target.repo}/pulls/${target.number}`)
    : glabApi(target, `${project(target)}/merge_requests/${target.number}`)
}

export function commitsCommand(target: Target): Run {
  return target.forge === 'github'
    ? ghApi(`repos/${target.repo}/pulls/${target.number}/commits?per_page=${MAX_COMMITS}`)
    : glabApi(target, `${project(target)}/merge_requests/${target.number}/commits?per_page=${MAX_COMMITS}`)
}

/**
 * How many files of one GitLab commit are read. The endpoint pages; a commit
 * touching more than a page is drawn with what arrived and marked truncated.
 */
export const GITLAB_COMMIT_FILES = 100

/**
 * The command for one diff, or `null` when the sha is not a sha.
 *
 * `null` rather than a throw, and checked HERE rather than by each caller, so
 * that there is exactly one place where a commit id becomes part of a command
 * and it is the place that refuses.
 */
export function diffCommand(target: Target, range: Range): Run | null {
  if (!SHA.test(range.sha)) return null
  if (target.forge === 'github') {
    return range.view === 'all'
      ? ghApi(`repos/${target.repo}/pulls/${target.number}`, GITHUB_DIFF)
      : ghApi(`repos/${target.repo}/commits/${range.sha}`, GITHUB_DIFF)
  }
  if (range.view === 'all') {
    /*
     * `glab mr diff --raw`, exactly as Diff runs it. `--raw` is not optional:
     * without it glab prints a diff dressed for a terminal, and the parser
     * reads unified diff and nothing else. `--color=never` is the same
     * argument about escape codes. This subcommand has no `--hostname`; it
     * reads `GITLAB_HOST`.
     */
    return {
      cmd: 'glab',
      args: ['mr', 'diff', String(target.number), '--repo', target.repo, '--raw', '--color=never'],
      ...(target.host ? { env: { GITLAB_HOST: target.host } } : {}),
    }
  }
  /* GitLab has no "this commit as a patch" in its API: it answers with JSON, a
     record per file, and `assemblePatch` below turns that back into a patch. */
  return glabApi(target, `${project(target)}/repository/commits/${range.sha}/diff?per_page=${GITLAB_COMMIT_FILES}`)
}

/* ------------------------------------------------------------------ *
 * Reading the answers
 * ------------------------------------------------------------------ */

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null

function parse(textIn: string): unknown {
  try {
    return JSON.parse(textIn)
  } catch {
    return undefined
  }
}

const NOT_JSON = 'The tracker’s command line answered with something that is not the record it was asked for.'

export function readDescribed(target: Target, answer: string): Read<Described> {
  const body = record(parse(answer))
  if (!body) return { ok: false, error: NOT_JSON }

  if (target.forge === 'github') {
    const head = record(body.head)?.sha
    const base = record(body.base)?.sha
    if (!isSha(head) || !isSha(base)) return { ok: false, error: 'GitHub answered for that pull request without naming its head and base commits.' }
    return {
      ok: true,
      value: {
        head,
        base,
        start: base,
        title: text(body.title, MAX_TITLE),
        /* `state` is open or closed, and merged is a separate flag: a merged
           pull request reads `closed`, which is true and is not what anybody
           means by it. */
        state: body.merged === true ? 'merged' : body.state === 'open' ? 'open' : 'closed',
        draft: body.draft === true,
        author: text(record(body.user)?.login, MAX_PERSON),
        url: text(body.html_url, 500),
      },
    }
  }

  const refs = record(body.diff_refs)
  const head = refs?.head_sha
  const base = refs?.base_sha
  const start = refs?.start_sha
  if (!isSha(head) || !isSha(base)) {
    /* A merge request with no commits has `diff_refs: null`. It is a real
       state and there is nothing in it to review. */
    return { ok: false, error: 'GitLab answered for that merge request without diff refs — it has no commits to review yet.' }
  }
  return {
    ok: true,
    value: {
      head,
      base,
      start: isSha(start) ? start : base,
      title: text(body.title, MAX_TITLE),
      state: body.state === 'merged' ? 'merged' : body.state === 'opened' || body.state === 'locked' ? 'open' : 'closed',
      draft: body.draft === true || body.work_in_progress === true,
      author: text(record(body.author)?.username, MAX_PERSON),
      url: text(body.web_url, 500),
    },
  }
}

const firstLine = (message: unknown): string => text(typeof message === 'string' ? message.split('\n', 1)[0] : '', MAX_TITLE)

const shas = (value: unknown): string[] => (Array.isArray(value) ? value.filter(isSha).slice(0, 8) : [])

export function readCommits(target: Target, answer: string): Read<Commits> {
  const body = parse(answer)
  if (!Array.isArray(body)) return { ok: false, error: NOT_JSON }
  const commits: Commit[] = []
  for (const raw of body.slice(0, MAX_COMMITS)) {
    const one = record(raw)
    if (!one) continue
    if (target.forge === 'github') {
      if (!isSha(one.sha)) continue
      const commit = record(one.commit)
      const author = record(commit?.author)
      commits.push({
        sha: one.sha,
        title: firstLine(commit?.message),
        /* The login when GitHub matched the commit to an account, and the name
           git recorded otherwise. Both are what somebody typed. */
        author: text(record(one.author)?.login, MAX_PERSON) || text(author?.name, MAX_PERSON),
        at: text(author?.date, 40),
        parents: Array.isArray(one.parents) ? shas(one.parents.map((p) => record(p)?.sha)) : [],
      })
    } else {
      if (!isSha(one.id)) continue
      commits.push({
        sha: one.id,
        title: text(one.title, MAX_TITLE) || firstLine(one.message),
        author: text(one.author_name, MAX_PERSON),
        at: text(one.authored_date, 40) || text(one.created_at, 40),
        parents: shas(one.parent_ids),
      })
    }
  }
  /* GitHub lists a pull request's commits oldest first and GitLab lists a merge
     request's newest first. Oldest first is the order the commits were written
     in, which is the order somebody reviewing commit by commit reads them. */
  if (target.forge === 'gitlab') commits.reverse()
  return { ok: true, value: { commits, more: body.length >= MAX_COMMITS } }
}

/**
 * GitLab's per-file JSON for one commit, as the patch git would have printed.
 *
 * `repository/commits/{sha}/diff` answers with `[{ old_path, new_path,
 * new_file, renamed_file, deleted_file, a_mode, b_mode, diff }]`, where `diff`
 * is the hunks alone — starting at `@@`, with no file header. The page and the
 * anchoring rule both read ONE format, unified diff, through one parser; so
 * rather than teach either of them a second format this writes the header git
 * would have written and lets the parser do what it already does.
 *
 * The parser's promise is that every `diff --git` becomes a file, and this
 * keeps the other half of it: every record becomes a `diff --git`, including
 * one whose `diff` is empty (a binary file, a pure rename, a file GitLab
 * declined to print for being too large). A file that changed and is not on
 * the list is the failure the whole diff view is written against.
 */
export function assemblePatch(answer: string): Read<{ text: string; files: number }> {
  const body = parse(answer)
  if (!Array.isArray(body)) return { ok: false, error: NOT_JSON }
  const out: string[] = []
  let files = 0
  for (const raw of body) {
    const one = record(raw)
    if (!one) continue
    /* A path is one line of a header. A newline in one would let a file name
       write header lines of its own, so it is cut at the first. */
    const line = (value: unknown) => text(value, 1000).split('\n', 1)[0] ?? ''
    const newPath = line(one.new_path) || line(one.old_path)
    const oldPath = line(one.old_path) || newPath
    if (!newPath) continue
    files += 1
    const hunks = typeof one.diff === 'string' ? one.diff : ''
    out.push(`diff --git a/${oldPath} b/${newPath}`)
    if (one.new_file === true) out.push(`new file mode ${text(one.b_mode, 6) || '100644'}`)
    else if (one.deleted_file === true) out.push(`deleted file mode ${text(one.a_mode, 6) || '100644'}`)
    else if (one.renamed_file === true) out.push(`rename from ${oldPath}`, `rename to ${newPath}`)
    if (hunks.startsWith('@@')) {
      out.push(`--- ${one.new_file === true ? '/dev/null' : `a/${oldPath}`}`)
      out.push(`+++ ${one.deleted_file === true ? '/dev/null' : `b/${newPath}`}`)
    }
    /* Whatever GitLab printed, as it printed it: hunks, or its own
       `Binary files … differ`, or nothing. One trailing newline, so the next
       file's header starts a line. */
    if (hunks) out.push(hunks.endsWith('\n') ? hunks.slice(0, -1) : hunks)
  }
  return { ok: true, value: { text: out.length ? `${out.join('\n')}\n` : '', files } }
}

/* ------------------------------------------------------------------ *
 * Asking
 * ------------------------------------------------------------------ */

const failed = (ran: Extract<Ran, { ok: false }>): { ok: false; error: string } => ({ ok: false, error: ran.error })

/** A JSON answer is small; a megabyte is a ceiling, not a budget. Past it the JSON is cut and reads as "not the record". */
const JSON_BYTES = 4_000_000

export async function describe(run: Runner, target: Target): Promise<Read<Described>> {
  const ran = await run({ ...describeCommand(target), maxBytes: JSON_BYTES })
  return ran.ok ? readDescribed(target, ran.text) : failed(ran)
}

export async function commits(run: Runner, target: Target): Promise<Read<Commits>> {
  const ran = await run({ ...commitsCommand(target), maxBytes: JSON_BYTES })
  return ran.ok ? readCommits(target, ran.text) : failed(ran)
}

/**
 * What was fetched, keyed by the change, the view AND the commit.
 *
 * The key is the design, as it is in Diff: the identity of an entry includes
 * the identity of its content, so a change that gets a new commit gets a new
 * key and there is no invalidation to reason about. A commit's own diff never
 * changes at all. The `all` view is filed under the head it was asked at.
 *
 * ## When it is wrong, stated plainly
 *
 * The forge is asked for "the diff of this change", not "the diff at this
 * sha" — there is no such question for a pull request. So if a push lands
 * between `describe` naming a head and the diff being fetched, the entry filed
 * under the OLD head holds the NEW diff, and stays that way until the process
 * restarts. The window is one request wide, the page asks again under the new
 * head as soon as it learns of it, and a comment anchored in that window would
 * be checked against lines the person was genuinely looking at — but it would
 * be stamped with a head one push too old, and a tracker might then decline to
 * place it. It would be folded into the summary, not lost.
 *
 * In memory, per process, bounded, oldest evicted first.
 */
const cache = new Map<string, Patch>()
const KEEP = 96

const keyOf = (target: Target, range: Range) =>
  `${target.forge}|${target.host ?? ''}|${target.repo}|${target.number}|${range.view}|${range.sha}`

/** Empty the cache. For tests, and for nothing else. */
export function forget(): void {
  cache.clear()
}

/** How many patches are held. Reported on `/healthz`. */
export function held(): number {
  return cache.size
}

export async function diff(run: Runner, target: Target, range: Range): Promise<Read<Patch>> {
  const command = diffCommand(target, range)
  if (!command) return { ok: false, error: 'That is not a commit id, so no diff was asked for.' }

  const key = keyOf(target, range)
  const had = cache.get(key)
  if (had) return { ok: true, value: { ...had, from: 'cache' } }

  const ran = await run(command)
  if (!ran.ok) return failed(ran)

  let patch: Patch
  if (target.forge === 'gitlab' && range.view === 'commit') {
    if (ran.truncated) {
      return { ok: false, error: 'GitLab’s answer for that commit was larger than this app reads into memory, and half a JSON document cannot be drawn as half a diff.' }
    }
    const made = assemblePatch(ran.text)
    if (!made.ok) return made
    patch = { text: made.value.text, truncated: made.value.files >= GITLAB_COMMIT_FILES, view: range.view, sha: range.sha, from: 'cli' }
  } else {
    patch = { text: ran.text, truncated: ran.truncated, view: range.view, sha: range.sha, from: 'cli' }
  }

  cache.set(key, patch)
  /* Oldest first: `Map` iterates in insertion order. */
  while (cache.size > KEEP) {
    const oldest = cache.keys().next()
    if (oldest.done) break
    cache.delete(oldest.value)
  }
  return { ok: true, value: patch }
}

/**
 * Whose login a review would be posted under, when the CLI will say.
 *
 * Shown in the confirmation before a send. `null` rather than an error when it
 * cannot be read: the send would then fail in the CLI's own words, and a
 * confirmation that could not be drawn at all would be a worse place to learn
 * that than the one beside the button.
 */
export async function login(run: Runner, target: Target): Promise<string | null> {
  const ran = await run({ ...(target.forge === 'github' ? ghApi('user') : glabApi(target, 'user')), maxBytes: 200_000 })
  if (!ran.ok) return null
  const body = record(parse(ran.text))
  return text(target.forge === 'github' ? body?.login : body?.username, MAX_PERSON) || null
}
