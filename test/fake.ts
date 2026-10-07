import type { Ran, Run, Runner } from '../forge/run.ts'

/**
 * A runner that starts nothing.
 *
 * It records every command it was asked to run and answers from a function the
 * test wrote. This is the only runner any test in this repository uses, which
 * is the guarantee behind the sentence in the README: no review, comment,
 * approval or note was posted to a real tracker to build or test this.
 */
export function fake(answer: (run: Run, calls: Run[]) => Ran | string | undefined) {
  const calls: Run[] = []
  const run: Runner = (one) => {
    calls.push(one)
    const said = answer(one, calls)
    if (said === undefined) return Promise.resolve(refused(404, 'Not Found'))
    return Promise.resolve(typeof said === 'string' ? { ok: true, text: said, truncated: false } : said)
  }
  return { run, calls }
}

/** A failure shaped as the real runner shapes one: the CLI's words, and the status out of `(HTTP nnn)`. */
export const refused = (status: number | null, error: string): Ran => ({ ok: false, status, text: '', error: status ? `gh: ${error} (HTTP ${status})` : error })

/** The API path of a call, which is what a test routes on. */
export const pathOf = (run: Run): string => run.args[1] ?? ''

export const isPost = (run: Run): boolean => run.args.includes('POST')

export const sentBody = (run: Run): Record<string, unknown> => JSON.parse(run.stdin ?? '{}') as Record<string, unknown>

/* ---- fixtures, cut from real answers and shortened ---- */

export const HEAD = 'f982d895148c2dd49f71ccbaa31ee0d829e8ae8f'
export const FIRST = '1111111111111111111111111111111111111111'
export const BASE = '084457597d899b04df76c7295b6cf10ad5cd59a5'
export const MERGE_BASE = '8315a0b86c2026fe769cdc53c77711d08920942f'

export const GH_URL = 'https://github.com/o/r/pull/46'
export const GL_URL = 'https://gitlab.example/g/sub/p/-/merge_requests/7'

export const GH_PULL = JSON.stringify({
  number: 46,
  title: 'feat: an official module list',
  state: 'open',
  merged: false,
  draft: false,
  user: { login: 'Jalez' },
  html_url: GH_URL,
  head: { sha: HEAD },
  base: { sha: BASE },
})

/** Two commits, oldest first, as GitHub lists them. */
export const GH_COMMITS = JSON.stringify([
  { sha: FIRST, commit: { message: 'first: lay the file down\n\nbody', author: { name: 'Jaakko', date: '2026-10-06T00:00:00Z' } }, author: { login: 'Jalez' }, parents: [{ sha: MERGE_BASE }] },
  { sha: HEAD, commit: { message: 'second: change it', author: { name: 'Jaakko', date: '2026-10-07T00:00:00Z' } }, author: null, parents: [{ sha: FIRST }] },
])

/** The whole change: one file, two hunks with a gap between them, and a deleted file. */
export const PATCH = `diff --git a/src/one.ts b/src/one.ts
index 1111111..2222222 100644
--- a/src/one.ts
+++ b/src/one.ts
@@ -10,4 +10,5 @@ export const thing = 1
 context before
-was this
+is this
+and this too
 context after
@@ -40,3 +41,3 @@ function later() {
 far context
-old far
+new far
diff --git a/src/gone.ts b/src/gone.ts
deleted file mode 100644
--- a/src/gone.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-first
-second
diff --git a/logo.png b/logo.png
index 4444444..5555555 100644
Binary files a/logo.png and b/logo.png differ
`

/** What the second commit alone did: a different diff of the same file, with different numbers. */
export const COMMIT_PATCH = `diff --git a/src/one.ts b/src/one.ts
--- a/src/one.ts
+++ b/src/one.ts
@@ -11,2 +11,3 @@
 is this
+and this too
 context after
`

export const GL_MR = JSON.stringify({
  iid: 7,
  title: 'Draft: tidy the parser',
  state: 'opened',
  draft: true,
  author: { username: 'ada' },
  web_url: GL_URL,
  diff_refs: { base_sha: MERGE_BASE, head_sha: HEAD, start_sha: BASE },
})

/** Newest first, as GitLab lists them. */
export const GL_COMMITS = JSON.stringify([
  { id: HEAD, title: 'second: change it', author_name: 'Ada', authored_date: '2026-10-07T00:00:00.000+00:00', parent_ids: [FIRST] },
  { id: FIRST, title: 'first: lay the file down', author_name: 'Ada', authored_date: '2026-10-06T00:00:00.000+00:00', parent_ids: [MERGE_BASE] },
])

export const GL_COMMIT_DIFF = JSON.stringify([
  { old_path: 'go.mod', new_path: 'go.mod', new_file: false, renamed_file: false, deleted_file: false, a_mode: '100644', b_mode: '100644', diff: '@@ -46,3 +46,3 @@ require (\n \ta v1\n-\tb v3.15.0\n+\tb v3.16.0\n' },
  { old_path: 'new.txt', new_path: 'new.txt', new_file: true, renamed_file: false, deleted_file: false, a_mode: '0', b_mode: '100644', diff: '@@ -0,0 +1,2 @@\n+hello\n+there\n' },
  { old_path: 'old.txt', new_path: 'old.txt', new_file: false, renamed_file: false, deleted_file: true, a_mode: '100644', b_mode: '0', diff: '@@ -1 +0,0 @@\n-bye\n' },
  { old_path: 'a/was.ts', new_path: 'a/now.ts', new_file: false, renamed_file: true, deleted_file: false, a_mode: '100644', b_mode: '100644', diff: '' },
  { old_path: 'pic.png', new_path: 'pic.png', new_file: false, renamed_file: false, deleted_file: false, a_mode: '100644', b_mode: '100644', diff: 'Binary files a/pic.png and b/pic.png differ\n' },
])

/** A GitHub tracker that answers every read this module makes, and nothing else. */
export function githubReads(run: Run): string | undefined {
  const path = pathOf(run)
  if (isPost(run)) return undefined
  if (path === 'repos/o/r/pulls/46') return run.args.includes('Accept: application/vnd.github.diff') ? PATCH : GH_PULL
  if (path === 'repos/o/r/pulls/46/commits?per_page=100') return GH_COMMITS
  /* Both commits answer with the same small patch: what matters to the tests
     is that a commit's diff is a DIFFERENT diff from the whole change's. */
  if (path === `repos/o/r/commits/${HEAD}` || path === `repos/o/r/commits/${FIRST}`) return COMMIT_PATCH
  if (path === 'user') return JSON.stringify({ login: 'Jalez' })
  return undefined
}
