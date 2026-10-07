import { beforeEach, describe, expect, test } from 'bun:test'

import { locate, type Target } from '../forge/locate.ts'
import { assemblePatch, commits, commitsCommand, describe as describeChange, describeCommand, diff, diffCommand, forget, login } from '../forge/read.ts'
import { failureText, statusOf } from '../forge/run.ts'
import { parseDiff } from '../src/diff/parse.ts'

import { BASE, FIRST, GH_COMMITS, GH_PULL, GL_COMMITS, GL_COMMIT_DIFF, GL_MR, GL_URL, HEAD, MERGE_BASE, PATCH, fake, githubReads, refused } from './fake.ts'

/**
 * The forge adapter, driven through a runner that starts nothing.
 *
 * The argv of every command is asserted EXACTLY. It is the security property
 * of the file — an array handed to `spawn` with no shell — and a property
 * nobody asserts is one a later "simplification" removes without a test
 * failing.
 */
const gh: Target = { forge: 'github', repo: 'o/r', number: 46 }
const gl = locate(GL_URL)!

beforeEach(forget)

describe('the command lines', () => {
  test('GitHub reads go through `gh api`, with the repository and number as plain arguments', () => {
    expect(describeCommand(gh)).toEqual({ cmd: 'gh', args: ['api', 'repos/o/r/pulls/46'] })
    expect(commitsCommand(gh)).toEqual({ cmd: 'gh', args: ['api', 'repos/o/r/pulls/46/commits?per_page=100'] })
    expect(diffCommand(gh, { view: 'all', sha: HEAD })).toEqual({ cmd: 'gh', args: ['api', 'repos/o/r/pulls/46', '-H', 'Accept: application/vnd.github.diff'] })
    expect(diffCommand(gh, { view: 'commit', sha: FIRST })).toEqual({
      cmd: 'gh',
      args: ['api', `repos/o/r/commits/${FIRST}`, '-H', 'Accept: application/vnd.github.diff'],
    })
  })

  test('GitLab reads encode the project path as one segment and name a self-hosted host', () => {
    expect(gl).toEqual({ forge: 'gitlab', repo: 'g/sub/p', number: 7, host: 'gitlab.example' })
    expect(describeCommand(gl)).toEqual({ cmd: 'glab', args: ['api', 'projects/g%2Fsub%2Fp/merge_requests/7', '--hostname', 'gitlab.example'] })
    expect(commitsCommand(gl)).toEqual({
      cmd: 'glab',
      args: ['api', 'projects/g%2Fsub%2Fp/merge_requests/7/commits?per_page=100', '--hostname', 'gitlab.example'],
    })
    expect(diffCommand(gl, { view: 'commit', sha: FIRST })).toEqual({
      cmd: 'glab',
      args: ['api', `projects/g%2Fsub%2Fp/repository/commits/${FIRST}/diff?per_page=100`, '--hostname', 'gitlab.example'],
    })
    /* The whole change is `glab mr diff`, which reads its host from the environment. */
    expect(diffCommand(gl, { view: 'all', sha: HEAD })).toEqual({
      cmd: 'glab',
      args: ['mr', 'diff', '7', '--repo', 'g/sub/p', '--raw', '--color=never'],
      env: { GITLAB_HOST: 'gitlab.example' },
    })
  })

  test('gitlab.com is not named: passing the default would override a person’s own configuration', () => {
    const publicOne = locate('https://gitlab.com/gitlab-org/cli/-/merge_requests/4011')!
    expect(describeCommand(publicOne).args).toEqual(['api', 'projects/gitlab-org%2Fcli/merge_requests/4011'])
    expect(diffCommand(publicOne, { view: 'all', sha: HEAD })).not.toHaveProperty('env')
  })

  test('nothing that is not a commit id becomes part of a command', () => {
    for (const sha of ['', 'HEAD', 'abc', 'ABCDEF1', 'abcdef1/../../user', 'abcdef1 --hostname evil', `${HEAD}${HEAD}0`, '--paginate', 'abcdef1\n']) {
      expect(diffCommand(gh, { view: 'commit', sha })).toBeNull()
      expect(diffCommand(gl, { view: 'commit', sha })).toBeNull()
      expect(diffCommand(gh, { view: 'all', sha })).toBeNull()
    }
  })

  test('a sha that is not one is refused before anything is run', async () => {
    const runner = fake(() => 'never')
    const got = await diff(runner.run, gh, { view: 'commit', sha: '../../user' })
    expect(got.ok).toBe(false)
    expect(runner.calls).toHaveLength(0)
  })
})

describe('reading a change', () => {
  test('GitHub: head, base, title, author, and merged told apart from closed', async () => {
    const got = await describeChange(fake(githubReads).run, gh)
    expect(got).toEqual({
      ok: true,
      value: { head: HEAD, base: BASE, start: BASE, title: 'feat: an official module list', state: 'open', draft: false, author: 'Jalez', url: 'https://github.com/o/r/pull/46' },
    })
    const merged = await describeChange(fake(() => JSON.stringify({ ...JSON.parse(GH_PULL), state: 'closed', merged: true })).run, gh)
    expect(merged.ok && merged.value.state).toBe('merged')
  })

  test('GitLab: the three shas come from diff_refs, and `opened` is open', async () => {
    const got = await describeChange(fake(() => GL_MR).run, gl)
    expect(got).toEqual({
      ok: true,
      value: { head: HEAD, base: MERGE_BASE, start: BASE, title: 'Draft: tidy the parser', state: 'open', draft: true, author: 'ada', url: GL_URL },
    })
  })

  test('a merge request with no diff refs has nothing to review, and says so', async () => {
    const got = await describeChange(fake(() => JSON.stringify({ iid: 7, diff_refs: null })).run, gl)
    expect(!got.ok && got.error).toContain('no commits to review')
  })

  test('commits come back oldest first from both trackers, with parents', async () => {
    const fromGithub = await commits(fake(() => GH_COMMITS).run, gh)
    const fromGitlab = await commits(fake(() => GL_COMMITS).run, gl)
    for (const got of [fromGithub, fromGitlab]) {
      expect(got.ok && got.value.commits.map((c) => [c.sha, c.title, c.parents])).toEqual([
        [FIRST, 'first: lay the file down', [MERGE_BASE]],
        [HEAD, 'second: change it', [FIRST]],
      ])
      expect(got.ok && got.value.more).toBe(false)
    }
    /* The login when GitHub matched one, the name git recorded otherwise. */
    expect(fromGithub.ok && fromGithub.value.commits.map((c) => c.author)).toEqual(['Jalez', 'Jaakko'])
  })

  test('a full page of commits is flagged as possibly not all of them', async () => {
    const page = JSON.stringify(Array.from({ length: 100 }, (_, i) => ({ sha: i.toString(16).padStart(40, '0'), commit: { message: `c${i}` }, parents: [] })))
    const got = await commits(fake(() => page).run, gh)
    expect(got.ok && got.value.commits).toHaveLength(100)
    expect(got.ok && got.value.more).toBe(true)
  })

  test('a commit whose id is not an id is left out rather than carried into a later command', async () => {
    const got = await commits(fake(() => JSON.stringify([{ sha: 'not a sha; rm -rf', commit: { message: 'x' }, parents: [] }])).run, gh)
    expect(got.ok && got.value.commits).toEqual([])
  })

  test('the CLI’s own words are passed on when it fails', async () => {
    const got = await describeChange(fake(() => refused(null, 'gh: To get started with GitHub CLI, please run: gh auth login')).run, gh)
    expect(got).toEqual({ ok: false, error: 'gh: To get started with GitHub CLI, please run: gh auth login' })
  })

  test('an answer that is not the record asked for is an error, not an empty change', async () => {
    expect((await describeChange(fake(() => '<html>').run, gh)).ok).toBe(false)
    expect((await commits(fake(() => '{}').run, gh)).ok).toBe(false)
  })

  test('the login is read for the confirmation, and its absence is not an error', async () => {
    expect(await login(fake(githubReads).run, gh)).toBe('Jalez')
    expect(await login(fake(() => refused(401, 'Unauthorized')).run, gl)).toBeNull()
  })
})

describe('diffs', () => {
  test('a diff is cached by change, view and commit, and says where it came from', async () => {
    const runner = fake(githubReads)
    const first = await diff(runner.run, gh, { view: 'all', sha: HEAD })
    const second = await diff(runner.run, gh, { view: 'all', sha: HEAD })
    expect(first.ok && first.value.from).toBe('cli')
    expect(second.ok && second.value.from).toBe('cache')
    expect(second.ok && second.value.text).toBe(PATCH)
    expect(runner.calls).toHaveLength(1)
    /* Another commit, or the same commit as another view, is another document. */
    await diff(runner.run, gh, { view: 'commit', sha: HEAD })
    expect(runner.calls).toHaveLength(2)
  })

  test('a failed fetch is not cached', async () => {
    let fail = true
    const runner = fake((run) => (fail ? refused(502, 'Bad Gateway') : githubReads(run)))
    expect((await diff(runner.run, gh, { view: 'all', sha: HEAD })).ok).toBe(false)
    fail = false
    expect((await diff(runner.run, gh, { view: 'all', sha: HEAD })).ok).toBe(true)
  })

  test('truncation is carried to the caller, not hidden', async () => {
    const got = await diff(fake(() => ({ ok: true, text: PATCH, truncated: true })).run, gh, { view: 'all', sha: HEAD })
    expect(got.ok && got.value.truncated).toBe(true)
  })

  test('GitLab’s per-file JSON for a commit becomes a patch the parser reads, one file per record', async () => {
    const got = await diff(fake(() => GL_COMMIT_DIFF).run, gl, { view: 'commit', sha: FIRST })
    expect(got.ok).toBe(true)
    const files = parseDiff(got.ok ? got.value.text : '')
    expect(files.map((f) => [f.path, f.status, f.from, f.binary, f.added, f.removed])).toEqual([
      ['go.mod', 'modified', 'go.mod', false, 1, 1],
      ['new.txt', 'added', null, false, 2, 0],
      ['old.txt', 'removed', 'old.txt', false, 0, 1],
      ['a/now.ts', 'renamed', 'a/was.ts', false, 0, 0],
      ['pic.png', 'modified', null, true, 0, 0],
    ])
    /* The numbers are the ones GitLab's hunk header gave, which is what a
       position on that commit will be checked against. */
    expect(files[0]!.hunks[0]!.lines.map((l) => [l.kind, l.old, l.new])).toEqual([
      ['context', 46, 46],
      ['del', 47, null],
      ['add', null, 47],
    ])
  })

  test('a file name cannot write header lines of its own', () => {
    const made = assemblePatch(JSON.stringify([{ old_path: 'a.ts', new_path: 'a.ts\ndiff --git a/evil b/evil', diff: '@@ -1 +1 @@\n-a\n+b\n' }]))
    expect(made.ok && parseDiff(made.value.text).map((f) => f.path)).toEqual(['a.ts'])
  })
})

describe('what a failed call says', () => {
  test('the status is read out of the CLI’s last words', () => {
    expect(statusOf('gh: Validation Failed (HTTP 422)')).toBe(422)
    expect(statusOf('glab: 404 Not found (HTTP 404)')).toBe(404)
    expect(statusOf('could not resolve host')).toBeNull()
  })

  test('the API’s own message is added when stderr does not already carry it', () => {
    const body = JSON.stringify({ message: 'Unprocessable Entity', errors: ['Can not approve your own pull request'] })
    expect(failureText('gh', 'gh: Unprocessable Entity (HTTP 422)', body, 1)).toBe(
      'gh: Unprocessable Entity (HTTP 422) Unprocessable Entity — Can not approve your own pull request',
    )
    expect(failureText('gh', '', '', 3)).toBe('gh exited 3 without saying why.')
  })
})
