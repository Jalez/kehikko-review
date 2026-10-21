import { describe, expect, test } from 'bun:test'

import { locate, type Target } from '../forge/locate.ts'
import { describe as describeChange, notes, notesCommand, people, readDescribed, readNotes, readPeople, reviewsCommand } from '../forge/read.ts'

import { GH_PULL, GL_MR, GL_URL, fake, refused } from './fake.ts'

/**
 * Who reviews a change, read from the forge itself (gh/glab), and what was said on it — so
 * `read_change` can say reviewers and approvals without waiting on a host, and the Before / after
 * view can find pictures. Argv asserted exactly, as everywhere in this repository.
 */
const gh: Target = { forge: 'github', repo: 'o/r', number: 46 }
const gl = locate(GL_URL)!

const ghPull = (over: Record<string, unknown>) => JSON.stringify({ ...JSON.parse(GH_PULL), ...over })
const glMr = (over: Record<string, unknown>) => JSON.stringify({ ...JSON.parse(GL_MR), ...over })

describe('the command lines', () => {
  test('reviews on GitHub, approvals on GitLab, and the conversation on both', () => {
    expect(reviewsCommand(gh)).toEqual({ cmd: 'gh', args: ['api', 'repos/o/r/pulls/46/reviews?per_page=100'] })
    expect(reviewsCommand(gl)).toEqual({ cmd: 'glab', args: ['api', 'projects/g%2Fsub%2Fp/merge_requests/7/approvals', '--hostname', 'gitlab.example'] })
    expect(notesCommand(gh)).toEqual({ cmd: 'gh', args: ['api', 'repos/o/r/issues/46/comments?per_page=100'] })
    expect(notesCommand(gl)).toEqual({
      cmd: 'glab',
      args: ['api', 'projects/g%2Fsub%2Fp/merge_requests/7/notes?per_page=100&sort=asc', '--hostname', 'gitlab.example'],
    })
  })
})

describe('what a change says about itself', () => {
  test('its description, and who was asked to review it', () => {
    const one = readDescribed(gh, ghPull({ body: 'Before ![b](https://github.com/x.png)', requested_reviewers: [{ login: 'ada' }, { nope: 1 }] }))
    expect(one.ok && one.value.description).toBe('Before ![b](https://github.com/x.png)')
    expect(one.ok && one.value.requested).toEqual([{ login: 'ada' }])
    const two = readDescribed(gl, glMr({ description: 'GitLab words', reviewers: [{ username: 'bo', name: 'Bo B' }] }))
    expect(two.ok && two.value.description).toBe('GitLab words')
    expect(two.ok && two.value.requested).toEqual([{ login: 'bo', name: 'Bo B' }])
    const none = readDescribed(gh, GH_PULL)
    expect(none.ok && none.value.description).toBe('')
    expect(none.ok && none.value.requested).toEqual([])
  })
})

describe('reviewers and approvals', () => {
  test('GitHub: the latest decision per login; a re-request is “requested”; the author is not a reviewer', () => {
    const described = readDescribed(gh, ghPull({ requested_reviewers: [{ login: 'cy' }] }))
    if (!described.ok) throw new Error(described.error)
    const reviews = JSON.stringify([
      { user: { login: 'ada' }, state: 'CHANGES_REQUESTED' },
      { user: { login: 'ada' }, state: 'APPROVED' },
      { user: { login: 'ada' }, state: 'COMMENTED' },
      { user: { login: 'bo' }, state: 'COMMENTED' },
      { user: { login: 'cy' }, state: 'APPROVED' },
      { user: { login: 'dee' }, state: 'APPROVED' },
      { user: { login: 'dee' }, state: 'DISMISSED' },
      { user: { login: 'eve' }, state: 'CHANGES_REQUESTED' },
      { user: { login: 'Jalez' }, state: 'COMMENTED' },
      { user: { login: 'pen' }, state: 'PENDING' },
      { nobody: true },
    ])
    const got = readPeople(gh, described.value, reviews)
    expect(got.ok && got.value).toEqual({
      reviewers: [
        { login: 'cy', state: 'requested' },
        { login: 'ada', state: 'approved' },
        { login: 'bo', state: 'commented' },
        { login: 'dee', state: 'commented' },
        { login: 'eve', state: 'changes' },
      ],
      approvals: { by: ['ada'] },
    })
  })

  test('GitLab: the reviewers named on the merge request, and who approved it of how many needed', () => {
    const described = readDescribed(gl, glMr({ reviewers: [{ username: 'bo', name: 'Bo B' }, { username: 'cy' }] }))
    if (!described.ok) throw new Error(described.error)
    const approvals = JSON.stringify({ approved_by: [{ user: { username: 'bo', name: 'Bo B' } }, { user: { username: 'zed' } }], approvals_required: 2, approvals_left: 0 })
    const got = readPeople(gl, described.value, approvals)
    expect(got.ok && got.value).toEqual({
      reviewers: [
        { login: 'bo', name: 'Bo B', state: 'approved' },
        { login: 'cy', state: 'requested' },
        { login: 'zed', state: 'approved' },
      ],
      approvals: { by: ['bo', 'zed'], required: 2, left: 0 },
    })
  })

  test('an answer that is not the list is said, and the read goes through the runner', async () => {
    const described = readDescribed(gh, GH_PULL)
    if (!described.ok) throw new Error(described.error)
    expect(readPeople(gh, described.value, '<html>').ok).toBe(false)
    const runner = fake(() => '[]')
    const got = await people(runner.run, gh, described.value)
    expect(got.ok && got.value).toEqual({ reviewers: [], approvals: { by: [] } })
    expect(runner.calls[0]?.args).toEqual(['api', 'repos/o/r/pulls/46/reviews?per_page=100'])
    const failing = await people(fake(() => refused(403, 'Forbidden')).run, gh, described.value)
    expect(failing.ok).toBe(false)
  })
})

describe('the conversation', () => {
  test('comments with their authors, oldest first; GitLab’s system notes are not the conversation', async () => {
    expect(readNotes(gh, JSON.stringify([{ user: { login: 'ada' }, body: 'After: ![a](u)' }, { body: 7 }]))).toEqual({ ok: true, value: [{ author: 'ada', body: 'After: ![a](u)' }] })
    expect(readNotes(gl, JSON.stringify([{ author: { username: 'bo' }, body: 'Hi', system: false }, { author: { username: 'bot' }, body: 'added 1 commit', system: true }]))).toEqual({
      ok: true,
      value: [{ author: 'bo', body: 'Hi' }],
    })
    expect(readNotes(gh, '{}').ok).toBe(false)
    const runner = fake(() => '[]')
    expect((await notes(runner.run, gl)).ok).toBe(true)
    expect(runner.calls[0]?.args[1]).toBe('projects/g%2Fsub%2Fp/merge_requests/7/notes?per_page=100&sort=asc')
    expect((await describeChange(fake(() => GH_PULL).run, gh)).ok).toBe(true)
  })
})
