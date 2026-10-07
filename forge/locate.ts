/**
 * Turning a tracker's own URL into a command line, safely.
 *
 * ## Why the URL and not the ref
 *
 * A selection is `['gh#105']` and that string cannot become a command. It does
 * not name a repository, and on GitHub it does not even say whether it is a pull
 * request — issues and pull requests share one number sequence, which is the
 * whole reason `src/live/changes.ts` reads the kind out of the row the host's
 * tracker reading has for it rather than out of the text.
 *
 * The reading has a `url` for every reference, written by the tracker itself
 * when the refresh read it. That URL is the one place where the forge, the
 * repository path and the number all appear together, already agreeing with each
 * other. So this file reads those three out of it and nothing else does.
 *
 * ## Everything here is a whitelist, and that is the point
 *
 * The output of this function becomes `argv` for a subprocess. It is built as an
 * ARRAY and spawned with no shell — see `forge/run.ts` — so a semicolon in a
 * repository name is a semicolon in a repository name and not a second command.
 * That is the real defence and it is one line.
 *
 * This is the second one, and it is here because the first line should never be
 * the only line. Every field is matched against a pattern that describes what it
 * IS rather than being scanned for what it must not be: a path segment is
 * letters, digits and a few punctuation marks; a number is digits. Anything else
 * is not a target, and `null` comes back. A blacklist is a guess about the
 * attacks somebody thought of; a whitelist is a statement about the data.
 *
 * Written as a pure function over a string so that it can be tested exhaustively
 * without a process, a network or a host — which is exactly what
 * `test/locate.test.ts` does with the malicious cases.
 */

/** Which CLI answers for this address. */
export type Forge = 'github' | 'gitlab'

export interface Target {
  forge: Forge
  /**
   * The repository as the CLI wants it written: `owner/repo` on GitHub, and on
   * GitLab the full namespace path, which may have several segments —
   * `group/subgroup/project` is ordinary there and `glab --repo` takes it.
   */
  repo: string
  /** The change's number, as digits. Never negative, never zero, never a float. */
  number: number
  /**
   * The host, when it is not the public one.
   *
   * Self-hosted GitLab is the common case in the workspaces this app is for, and
   * `glab mr diff` finds it through `GITLAB_HOST` while `glab api` takes
   * `--hostname`. Carried here so `read.ts` can say it for the one call, in
   * whichever spelling that call reads, rather than reading process state and
   * hoping. Absent for github.com and gitlab.com, which is a
   * deliberate absence: passing the default explicitly would override a person's
   * own `GITLAB_HOST` for no reason.
   */
  host?: string
}

/**
 * One path segment: what a forge lets a namespace or a project be called.
 *
 * Letters, digits, dot, dash, underscore. Not a slash — segments are joined by
 * the caller, so a slash arriving inside one would be a segment claiming to be
 * two. Not empty. Bounded, because a name has a length before it has a meaning
 * and nothing downstream should have to care how long an argument is.
 *
 * And never starting with a dash, which is the one restriction here that is
 * about the command line rather than about what a forge allows. `--repo` takes
 * its value as the next argument, so a repository called `--version` would be
 * handed to `gh` as a flag rather than as a name — an argument that changes what
 * the program DOES rather than which repository it reads. No forge lets a
 * namespace begin with a dash, so nothing legitimate is lost.
 */
const SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$/

/**
 * GitLab's own route separator, which is a path segment that is exactly one
 * dash: `/group/project/-/merge_requests/12`.
 *
 * Allowed through explicitly rather than by loosening `SEGMENT`, because it is
 * not a name — it is punctuation in GitLab's URL scheme, and it is what makes a
 * namespace of arbitrary depth readable. Loosening the pattern to admit it would
 * also admit `-rf` and `--version` as project names, which is exactly the case
 * `SEGMENT` exists to refuse.
 */
const GITLAB_ROUTE = '-'

const segments = (path: string): string[] | null => {
  const parts = path.split('/').filter(Boolean)
  if (!parts.length || parts.length > 8) return null
  return parts.every((p) => p === GITLAB_ROUTE || SEGMENT.test(p)) ? parts : null
}

/**
 * A number, as it appears in a URL and nowhere else.
 *
 * `Number(...)` alone would accept `'1e3'`, `' 12'`, `'0x10'` and `''`, each of
 * which becomes a plausible-looking integer that no tracker ever wrote. The
 * pattern is checked first so that what is parsed is known to be digits, and the
 * bound is a bound rather than a budget — a merge request number is four digits
 * on the busiest project anyone here has.
 */
const number = (raw: string): number | null => {
  if (!/^[0-9]{1,9}$/.test(raw)) return null
  const n = Number(raw)
  return n > 0 ? n : null
}

/**
 * Where a change lives, read out of the URL a tracker wrote for it.
 *
 * `null` for anything this cannot read with confidence, and the caller draws
 * that as a sentence rather than as an error: a reference whose URL this does not
 * understand is a reference this app cannot fetch a diff for, which is a fact
 * about the reference and not a failure of the program.
 *
 * Only `https` and `http`. A `javascript:` or `file:` URL out of somebody's
 * tracker is not an address, and this is the second place in the codebase that
 * has had to say so — `collect.ts` in References says it about `href`.
 */
export function locate(url: unknown): Target | null {
  if (typeof url !== 'string' || !url) return null
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null

  const host = parsed.hostname.toLowerCase()
  const parts = segments(parsed.pathname)
  if (!parts) return null

  /*
   * GitHub: `/owner/repo/pull/105`, and `/pull/` is the only shape with a diff.
   * `/issues/105` reaches here too — the caller has usually already decided from
   * the bag that it is an issue, but a URL that says `issues` is a second,
   * independent witness to the same fact and there is no reason to disagree with
   * it. Either way there is nothing to fetch, so `null`.
   *
   * Enterprise GitHub is not handled and should not be pretended at: `gh` finds
   * its host through `GH_HOST` or through the repository's own remote, and
   * guessing from a hostname this app has never seen would be inventing a
   * configuration. A URL on an unrecognised host comes back null and the page
   * says it does not know how to reach it.
   */
  if (host === 'github.com' || host === 'www.github.com') {
    const [owner, repo, kind, id] = parts
    if (!owner || !repo || kind !== 'pull' || !id) return null
    const n = number(id)
    return n === null ? null : { forge: 'github', repo: `${owner}/${repo}`, number: n }
  }

  /*
   * GitLab: `/group/…/project/-/merge_requests/12`. The `-` is GitLab's own
   * separator between the project path and the route, which is what makes a
   * namespace of arbitrary depth unambiguous — everything before it is the
   * project, everything after is the page. Reading it that way rather than
   * counting segments from the left is why a three-level group works.
   *
   * Any host, not only gitlab.com, because self-hosted is the normal case. The
   * hostname is carried through as `GITLAB_HOST` for the one call; it came out
   * of a URL a tracker wrote, and it is passed as an environment value to a
   * process spawned without a shell, so it is a string and not an instruction.
   */
  const dash = parts.indexOf(GITLAB_ROUTE)
  if (dash > 0 && parts[dash + 1] === 'merge_requests') {
    const id = parts[dash + 2]
    if (!id) return null
    const n = number(id)
    if (n === null) return null
    const repo = parts.slice(0, dash).join('/')
    if (!repo) return null
    const onPublic = host === 'gitlab.com' || host === 'www.gitlab.com'
    return { forge: 'gitlab', repo, number: n, ...(onPublic ? {} : { host: parsed.host }) }
  }

  return null
}
