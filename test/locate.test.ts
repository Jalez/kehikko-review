import { describe, expect, test } from 'bun:test'

import { locate } from '../forge/locate.ts'

/**
 * The one file in this program where a string becomes part of a command line.
 *
 * These are written as a whitelist's tests rather than a sanitiser's: the
 * assertions are about what IS accepted, and the hostile cases are there to
 * prove the shape of the accepted set rather than to enumerate attacks somebody
 * thought of. An attack this file has never heard of still fails, because it
 * does not look like `owner/repo` and a number.
 */
describe('locate', () => {
  test('reads a GitHub pull request', () => {
    expect(locate('https://github.com/jaakkorajalasol/roadmap/pull/105')).toEqual({
      forge: 'github',
      repo: 'jaakkorajalasol/roadmap',
      number: 105,
    })
  })

  test('a GitHub issue has no diff, and is not a target', () => {
    expect(locate('https://github.com/jaakkorajalasol/roadmap/issues/131')).toBeNull()
  })

  test('reads a gitlab.com merge request, and does not override GITLAB_HOST for it', () => {
    const found = locate('https://gitlab.com/group/project/-/merge_requests/12')
    expect(found).toEqual({ forge: 'gitlab', repo: 'group/project', number: 12 })
    expect(found && 'host' in found).toBe(false)
  })

  test('reads a nested group on a self-hosted GitLab, and carries the host', () => {
    expect(locate('https://gitlab.example.com/group/sub/deeper/project/-/merge_requests/4')).toEqual({
      forge: 'gitlab',
      repo: 'group/sub/deeper/project',
      number: 4,
      host: 'gitlab.example.com',
    })
  })

  test('the GitLab separator is what makes a deep namespace unambiguous', () => {
    /* Without reading `-` as the separator, this would have to be counted from
       the left and a three-level group would come out as the wrong project. */
    const found = locate('https://gitlab.example.com/a/b/c/-/merge_requests/9')
    expect(found?.repo).toBe('a/b/c')
  })

  test('anything that is not a change page is not a target', () => {
    expect(locate('https://github.com/owner/repo')).toBeNull()
    expect(locate('https://github.com/owner/repo/commit/abc')).toBeNull()
    expect(locate('https://gitlab.com/group/project/-/issues/3')).toBeNull()
    expect(locate('https://example.com/owner/repo/pull/1')).toBeNull()
  })

  test('a number is digits, and nothing that merely converts to one', () => {
    expect(locate('https://github.com/o/r/pull/1e3')).toBeNull()
    expect(locate('https://github.com/o/r/pull/0x10')).toBeNull()
    expect(locate('https://github.com/o/r/pull/0')).toBeNull()
    expect(locate('https://github.com/o/r/pull/-1')).toBeNull()
    expect(locate('https://github.com/o/r/pull/')).toBeNull()
  })

  test('shell metacharacters in a path segment are not a repository', () => {
    /* The array-and-no-shell spawn in `patch/fetch.ts` is what actually makes
       these harmless. This is the second line: they never get that far. */
    expect(locate('https://github.com/owner/repo;curl evil.example/pull/1')).toBeNull()
    expect(locate('https://github.com/owner/$(id)/pull/1')).toBeNull()
    expect(locate('https://github.com/owner/`id`/pull/1')).toBeNull()
    expect(locate('https://github.com/owner/re|po/pull/1')).toBeNull()
  })

  test('an argument that looks like a flag is not a repository either', () => {
    /* `--repo=--version` would be an argument that changes what the CLI does
       rather than which repository it reads. A leading dash is not in the
       segment pattern, so it never becomes one. */
    expect(locate('https://github.com/--version/repo/pull/1')).toBeNull()
    expect(locate('https://github.com/owner/-rf/pull/1')).toBeNull()
  })

  test('only http and https are addresses', () => {
    expect(locate('javascript:alert(1)//github.com/o/r/pull/1')).toBeNull()
    expect(locate('file:///etc/passwd')).toBeNull()
    expect(locate('ssh://git@github.com/o/r/pull/1')).toBeNull()
  })

  test('nothing at all is not a target, and does not throw', () => {
    expect(locate('')).toBeNull()
    expect(locate(null)).toBeNull()
    expect(locate(undefined)).toBeNull()
    expect(locate(12)).toBeNull()
    expect(locate('not a url')).toBeNull()
  })
})
