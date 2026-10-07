import { describe, expect, test } from 'bun:test'

import { locate } from '../forge/locate.ts'
import type { Run } from '../forge/run.ts'
import { emptyDraft, stamp } from '../review/draft.ts'
import { CHANGES_REQUESTED, composeBody, execute, foldText, gather, githubPlace, plan, post, readVersions, type Facts, type Hooks, type Plan } from '../review/send.ts'
import { changeOf, type Comment, type Draft, type Sent, type Verdict } from '../review/shape.ts'

import { BASE, FIRST, GH_URL, GL_COMMITS, GL_MR, GL_URL, HEAD, MERGE_BASE, fake, githubReads, isPost, pathOf, refused, sentBody } from './fake.ts'

/**
 * Sending, against a runner that starts nothing.
 *
 * The plan is asserted as a value — every path and every JSON body that would
 * leave the machine — and the executor is run only against `fake`. Nothing in
 * this file, or anywhere in this repository's tests, can reach a tracker.
 */
const gh = locate(GH_URL)!
const gl = locate(GL_URL)!

const OLDER = '2222222222222222222222222222222222222222'

const facts: Facts = {
  head: HEAD,
  base: BASE,
  start: BASE,
  commits: [
    { sha: FIRST, parents: [MERGE_BASE] },
    { sha: HEAD, parents: [FIRST] },
  ],
}

const comment = (over: Partial<Comment> & { id: string }): Comment => ({
  view: 'all',
  commit: HEAD,
  path: 'src/one.ts',
  side: 'new',
  line: 11,
  quote: 'is this',
  body: `words of ${over.id}`,
  by: 'person',
  at: '2026-10-07T00:00:00Z',
  ...over,
})

const draftOf = (target: typeof gh, comments: Comment[], verdict: Verdict | null = 'comment', summary = ''): Draft => ({
  ...emptyDraft(changeOf(target)),
  comments,
  verdict,
  summary,
})

const planned = (target: typeof gh, draft: Draft, with_: Facts = facts, ids?: string[]): Plan => {
  const made = plan(target, draft, with_, ids)
  if (!made.ok) throw new Error(made.error)
  return made.plan
}

/** Hooks that keep the draft in memory, as the store would on disk. */
function memory(draft: Draft) {
  const state = { draft, stamps: [] as { ids: string[]; sent: Sent }[], summaryCleared: 0 }
  const hooks: Hooks = {
    stamp: (ids, sent) => {
      state.stamps.push({ ids: [...ids], sent })
      state.draft = stamp(state.draft, ids, sent)
    },
    summarySent: () => {
      state.summaryCleared += 1
      state.draft = { ...state.draft, summary: '' }
    },
    now: () => 'NOW',
  }
  return { state, hooks }
}

const posts = (calls: Run[]) => calls.filter(isPost)
const reviewOk = JSON.stringify({ id: 1, html_url: `${GH_URL}#pullrequestreview-1` })

describe('where GitHub is told a comment is', () => {
  test('a whole-change comment is at the head it was written against, on its own side', () => {
    expect(githubPlace(comment({ id: 'a' }), facts)).toEqual({ commitId: HEAD, side: 'RIGHT' })
    expect(githubPlace(comment({ id: 'a', side: 'old' }), facts)).toEqual({ commitId: HEAD, side: 'LEFT' })
    /* An older head is not moved to the new one. */
    expect(githubPlace(comment({ id: 'a', commit: OLDER }), facts)).toEqual({ commitId: OLDER, side: 'RIGHT' })
  })

  test('a commit comment on the new side is a line of the file at that commit', () => {
    expect(githubPlace(comment({ id: 'a', view: 'commit', commit: FIRST, parent: MERGE_BASE }), facts)).toEqual({ commitId: FIRST, side: 'RIGHT' })
  })

  test('a line a commit removed lives in its parent: RIGHT at the parent when the parent is in the change', () => {
    /* HEAD's parent is FIRST, a commit of the pull request. Line L of FIRST's
       file is the line HEAD deleted; LEFT at HEAD would be line L of the merge
       base, a different file. */
    expect(githubPlace(comment({ id: 'a', view: 'commit', commit: HEAD, parent: FIRST, side: 'old' }), facts)).toEqual({ commitId: FIRST, side: 'RIGHT' })
  })

  test('…and LEFT at the commit itself when its parent is the merge base', () => {
    expect(githubPlace(comment({ id: 'a', view: 'commit', commit: FIRST, parent: MERGE_BASE, side: 'old' }), facts)).toEqual({ commitId: FIRST, side: 'LEFT' })
  })

  test('a parent not recorded on the comment is looked up among the change’s commits', () => {
    expect(githubPlace(comment({ id: 'a', view: 'commit', commit: HEAD, side: 'old' }), facts)).toEqual({ commitId: FIRST, side: 'RIGHT' })
  })
})

describe('the plan for GitHub', () => {
  test('comments are grouped by the commit they address: older commits first as COMMENT, the head last with the verdict', () => {
    const draft = draftOf(
      gh,
      [
        comment({ id: 'head-1', line: 11 }),
        comment({ id: 'first-1', view: 'commit', commit: FIRST, parent: MERGE_BASE, line: 3 }),
        comment({ id: 'head-2', side: 'old', line: 11, startLine: 10 }),
        comment({ id: 'removed-by-head', view: 'commit', commit: HEAD, parent: FIRST, side: 'old', line: 5 }),
      ],
      'approve',
      'Looks right.',
    )
    const made = planned(gh, draft)
    expect(made.steps).toEqual([
      {
        kind: 'github-review',
        path: 'repos/o/r/pulls/46/reviews',
        commitId: FIRST,
        inline: [
          { id: 'first-1', payload: { path: 'src/one.ts', line: 3, side: 'RIGHT', body: 'words of first-1' } },
          { id: 'removed-by-head', payload: { path: 'src/one.ts', line: 5, side: 'RIGHT', body: 'words of removed-by-head' } },
        ],
      },
      {
        kind: 'github-final',
        path: 'repos/o/r/pulls/46/reviews',
        commitId: HEAD,
        event: 'APPROVE',
        summary: 'Looks right.',
        inline: [
          { id: 'head-1', payload: { path: 'src/one.ts', line: 11, side: 'RIGHT', body: 'words of head-1' } },
          { id: 'head-2', payload: { path: 'src/one.ts', line: 11, side: 'LEFT', start_line: 10, start_side: 'LEFT', body: 'words of head-2' } },
        ],
      },
    ])
    expect(made.ids).toEqual(['head-1', 'first-1', 'head-2', 'removed-by-head'])
  })

  test('each verdict is GitHub’s own event word', () => {
    const one = [comment({ id: 'a' })]
    const event = (verdict: Verdict) => planned(gh, draftOf(gh, one, verdict, 'because')).steps.at(-1)
    expect(event('approve')).toMatchObject({ kind: 'github-final', event: 'APPROVE' })
    expect(event('request-changes')).toMatchObject({ kind: 'github-final', event: 'REQUEST_CHANGES' })
    expect(event('comment')).toMatchObject({ kind: 'github-final', event: 'COMMENT' })
  })

  test('only unsent comments are planned, and only the ones that were confirmed', () => {
    const draft = stamp(draftOf(gh, [comment({ id: 'sent' }), comment({ id: 'shown' }), comment({ id: 'added-since' })], 'comment'), ['sent'], { at: 'before' })
    expect(planned(gh, draft).ids).toEqual(['shown', 'added-since'])
    expect(planned(gh, draft, facts, ['sent', 'shown']).ids).toEqual(['shown'])
  })

  test('it refuses what would be refused anyway, before anything is posted', () => {
    const none = plan(gh, draftOf(gh, [comment({ id: 'a' })], null), facts)
    expect(!none.ok && none.error).toContain('Choose a verdict')
    const empty = plan(gh, draftOf(gh, [], 'comment', '   '), facts)
    expect(!empty.ok && empty.error).toContain('nothing to send')
    const bare = plan(gh, draftOf(gh, [comment({ id: 'a' })], 'request-changes', ''), facts)
    expect(!bare.ok && bare.error).toContain('without a summary')
    /* An approval with no words and no comments is a real review. */
    expect(plan(gh, draftOf(gh, [], 'approve'), facts).ok).toBe(true)
  })
})

describe('the plan for GitLab', () => {
  test('one thread per comment, positioned on the right three commits, then the note, then the approval', () => {
    const draft = draftOf(
      gl,
      [
        comment({ id: 'added', line: 11 }),
        comment({ id: 'removed', side: 'old', line: 11 }),
        comment({ id: 'context', line: 13, otherLine: 12 }),
        comment({ id: 'in-commit', view: 'commit', commit: HEAD, parent: FIRST, line: 12, startLine: 11 }),
        comment({ id: 'renamed', path: 'now.ts', oldPath: 'was.ts', side: 'old', line: 2, otherLine: 2 }),
      ],
      'approve',
      'Fine.',
    )
    const made = planned(gl, draft, { ...facts, base: MERGE_BASE, start: BASE })
    const whole = { position_type: 'text', base_sha: MERGE_BASE, start_sha: BASE, head_sha: HEAD }
    const discussions = 'projects/g%2Fsub%2Fp/merge_requests/7/discussions'
    expect(made.steps).toEqual([
      { kind: 'gitlab-thread', path: discussions, inline: { id: 'added', payload: { body: 'words of added', position: { ...whole, old_path: 'src/one.ts', new_path: 'src/one.ts', new_line: 11 } } } },
      { kind: 'gitlab-thread', path: discussions, inline: { id: 'removed', payload: { body: 'words of removed', position: { ...whole, old_path: 'src/one.ts', new_path: 'src/one.ts', old_line: 11 } } } },
      /* An unchanged line needs both numbers. */
      { kind: 'gitlab-thread', path: discussions, inline: { id: 'context', payload: { body: 'words of context', position: { ...whole, old_path: 'src/one.ts', new_path: 'src/one.ts', new_line: 13, old_line: 12 } } } },
      /* A commit's own diff is parent..commit, with commit_id beside the position. A range is anchored at its last line. */
      {
        kind: 'gitlab-thread',
        path: discussions,
        inline: {
          id: 'in-commit',
          payload: {
            body: 'words of in-commit',
            commit_id: HEAD,
            position: { position_type: 'text', base_sha: FIRST, start_sha: FIRST, head_sha: HEAD, old_path: 'src/one.ts', new_path: 'src/one.ts', new_line: 12 },
          },
        },
      },
      { kind: 'gitlab-thread', path: discussions, inline: { id: 'renamed', payload: { body: 'words of renamed', position: { ...whole, old_path: 'was.ts', new_path: 'now.ts', old_line: 2, new_line: 2 } } } },
      { kind: 'gitlab-note', path: 'projects/g%2Fsub%2Fp/merge_requests/7/notes', summary: 'Fine.', prefix: '' },
      { kind: 'gitlab-approve', path: 'projects/g%2Fsub%2Fp/merge_requests/7/approve', payload: { sha: HEAD } },
    ])
    expect(made.fold).toEqual([])
  })

  test('“request changes” is words at the top of the note, and there is no approve step', () => {
    const made = planned(gl, draftOf(gl, [], 'request-changes', 'Please split this.'))
    expect(made.steps).toEqual([{ kind: 'gitlab-note', path: 'projects/g%2Fsub%2Fp/merge_requests/7/notes', summary: 'Please split this.', prefix: CHANGES_REQUESTED }])
  })

  test('a comment written against an older head is positioned on THAT version’s commits, or folded when GitLab no longer has it', () => {
    const stale = draftOf(gl, [comment({ id: 'stale', commit: OLDER })])
    const known = planned(gl, stale, { ...facts, versions: [{ head: OLDER, base: 'aaaaaaa1', start: 'bbbbbbb2' }] })
    expect(known.steps[0]).toMatchObject({ kind: 'gitlab-thread', inline: { payload: { position: { base_sha: 'aaaaaaa1', start_sha: 'bbbbbbb2', head_sha: OLDER, new_line: 11 } } } })
    const unknown = planned(gl, stale, { ...facts, versions: [] })
    expect(unknown.steps.map((s) => s.kind)).toEqual(['gitlab-note'])
    expect(unknown.fold).toEqual([{ id: 'stale', why: expect.stringContaining('no longer lists') }])
  })

  test('the versions GitLab lists are read by their three commits, and junk among them is dropped', () => {
    expect(readVersions(JSON.stringify([{ id: 1, head_commit_sha: HEAD, base_commit_sha: MERGE_BASE, start_commit_sha: BASE }, { head_commit_sha: 'nope' }, 3]))).toEqual([
      { head: HEAD, base: MERGE_BASE, start: BASE },
    ])
    expect(readVersions('not json')).toEqual([])
  })
})

describe('the request that is made', () => {
  test('a body is JSON on stdin and never an argument', () => {
    const hostile = { body: '$(rm -rf ~) `id` --hostname evil.example \n -f x=@/etc/passwd' }
    const toGithub = post(gh, 'repos/o/r/pulls/46/reviews', hostile)
    expect(toGithub).toEqual({ cmd: 'gh', args: ['api', 'repos/o/r/pulls/46/reviews', '--method', 'POST', '--input', '-'], stdin: JSON.stringify(hostile) })
    const toGitlab = post(gl, 'projects/g%2Fsub%2Fp/merge_requests/7/notes', hostile)
    expect(toGitlab).toEqual({
      cmd: 'glab',
      args: ['api', 'projects/g%2Fsub%2Fp/merge_requests/7/notes', '--method', 'POST', '--input', '-', '-H', 'Content-Type: application/json', '--hostname', 'gitlab.example'],
      stdin: JSON.stringify(hostile),
    })
    for (const made of [toGithub, toGitlab]) expect(made.args.join(' ')).not.toContain('rm -rf')
  })
})

describe('folding', () => {
  test('a folded comment carries what a reader needs to find the place by hand', () => {
    const text = foldText(comment({ id: 'a', view: 'commit', commit: FIRST, side: 'old', line: 12, startLine: 10, quote: 'one\ntwo `tick`', body: 'This is wrong.' }))
    expect(text).toContain('**`src/one.ts`, lines 10–12** (old side, removed) in commit `11111111`')
    expect(text).toContain('> `one`')
    /* A backtick in the source cannot close the code span it is quoted in. */
    expect(text).not.toContain('`tick`')
    expect(text).toEndWith('This is wrong.')
  })

  test('the body is the summary, then each folded comment, and is empty when there is neither', () => {
    expect(composeBody('', [])).toBe('')
    expect(composeBody('  Fine.  ', [])).toBe('Fine.')
    const body = composeBody('Fine.', [comment({ id: 'a' })], CHANGES_REQUESTED)
    expect(body.startsWith(`${CHANGES_REQUESTED}\n\nFine.`)).toBe(true)
    expect(body).toContain('One comment could not be attached to its line')
    expect(body).toContain('words of a')
  })
})

describe('the executor, GitHub', () => {
  const two = () =>
    draftOf(gh, [comment({ id: 'first-1', view: 'commit', commit: FIRST, parent: MERGE_BASE, line: 3 }), comment({ id: 'head-1' })], 'approve', 'Looks right.')

  test('everything posts: each review carries its commit, comments are stamped, the verdict goes last', async () => {
    const draft = two()
    const { state, hooks } = memory(draft)
    const runner = fake(() => reviewOk)
    const report = await execute(runner.run, gh, planned(gh, draft), draft, hooks)

    expect(runner.calls.map(sentBody)).toEqual([
      { commit_id: FIRST, event: 'COMMENT', comments: [{ path: 'src/one.ts', line: 3, side: 'RIGHT', body: 'words of first-1' }] },
      { commit_id: HEAD, event: 'APPROVE', body: 'Looks right.', comments: [{ path: 'src/one.ts', line: 11, side: 'RIGHT', body: 'words of head-1' }] },
    ])
    expect(runner.calls.every((c) => c.cmd === 'gh' && isPost(c) && pathOf(c) === 'repos/o/r/pulls/46/reviews')).toBe(true)
    expect(report).toMatchObject({ posted: ['first-1', 'head-1'], folded: [], unsent: [], summarySent: true, verdictSent: true, complete: true, error: null })
    expect(state.draft.comments.map((c) => c.sent)).toEqual([
      { at: 'NOW', url: `${GH_URL}#pullrequestreview-1` },
      { at: 'NOW', url: `${GH_URL}#pullrequestreview-1` },
    ])
    expect(state.summaryCleared).toBe(1)
  })

  test('a group GitHub will not place (422) is folded into the final review’s body, and marked so', async () => {
    const draft = two()
    const { state, hooks } = memory(draft)
    const runner = fake((run) => (sentBody(run).commit_id === FIRST ? refused(422, 'Unprocessable Entity — Line could not be resolved') : reviewOk))
    const report = await execute(runner.run, gh, planned(gh, draft), draft, hooks)

    expect(runner.calls).toHaveLength(2)
    const final = sentBody(runner.calls[1]!)
    expect(final.event).toBe('APPROVE')
    expect(final.comments).toEqual([{ path: 'src/one.ts', line: 11, side: 'RIGHT', body: 'words of head-1' }])
    expect(final.body).toContain('Looks right.')
    expect(final.body).toContain('**`src/one.ts`, line 3** (new side) in commit `11111111`')
    expect(final.body).toContain('words of first-1')

    expect(report).toMatchObject({ posted: ['head-1'], folded: ['first-1'], unsent: [], complete: true })
    expect(report.notes.join(' ')).toContain('Line could not be resolved')
    expect(state.draft.comments.find((c) => c.id === 'first-1')!.sent).toEqual({ at: 'NOW', url: `${GH_URL}#pullrequestreview-1`, folded: true })
    expect(state.draft.comments.find((c) => c.id === 'head-1')!.sent?.folded).toBeUndefined()
  })

  test('when the final review itself is refused over a line, it is tried once more with its comments in the body', async () => {
    const draft = draftOf(gh, [comment({ id: 'head-1' })], 'comment', '')
    const { state, hooks } = memory(draft)
    const runner = fake((run) => ((sentBody(run).comments as unknown[]).length ? refused(422, 'Unprocessable Entity') : reviewOk))
    const report = await execute(runner.run, gh, planned(gh, draft), draft, hooks)
    expect(runner.calls).toHaveLength(2)
    expect(sentBody(runner.calls[1]!)).toMatchObject({ commit_id: HEAD, event: 'COMMENT', comments: [] })
    expect(sentBody(runner.calls[1]!).body).toContain('words of head-1')
    expect(report).toMatchObject({ posted: [], folded: ['head-1'], complete: true })
    expect(state.draft.comments[0]!.sent?.folded).toBe(true)
  })

  test('a refusal that is not about a line (approving one’s own pull request) is reported in GitHub’s words and stamps nothing', async () => {
    const draft = draftOf(gh, [comment({ id: 'head-1' })], 'approve', '')
    const { state, hooks } = memory(draft)
    const runner = fake(() => refused(422, 'Unprocessable Entity — Can not approve your own pull request'))
    const report = await execute(runner.run, gh, planned(gh, draft), draft, hooks)
    /* Once with the comment inline, once folded. Never a third time. */
    expect(runner.calls).toHaveLength(2)
    expect(report.complete).toBe(false)
    expect(report.error).toContain('Can not approve your own pull request')
    expect(report).toMatchObject({ posted: [], folded: [], unsent: ['head-1'], verdictSent: false, summarySent: false })
    expect(state.draft.comments[0]!.sent).toBeUndefined()
    expect(state.stamps).toEqual([])
  })

  test('a partial failure leaves the draft truthful: what posted is stamped, what did not is not, and the verdict is not sent', async () => {
    const draft = two()
    const { state, hooks } = memory(draft)
    /* The first review lands; then the login is gone. */
    const runner = fake((_run, calls) => (calls.length === 1 ? reviewOk : refused(401, 'Bad credentials')))
    const report = await execute(runner.run, gh, planned(gh, draft), draft, hooks)

    expect(report).toMatchObject({ posted: ['first-1'], folded: [], unsent: ['head-1'], verdictSent: false, summarySent: false, complete: false })
    expect(report.error).toContain('Bad credentials')
    expect(report.notes.join(' ')).toContain('1 comment was not sent and is still in the draft, and the verdict was not submitted')
    expect(state.draft.comments.map((c) => Boolean(c.sent))).toEqual([true, false])
    expect(state.draft.summary).toBe('Looks right.')
  })

  test('nothing is sent twice: sending again after a partial failure posts only what is left', async () => {
    const draft = two()
    const { state, hooks } = memory(draft)
    const failing = fake((_run, calls) => (calls.length === 1 ? reviewOk : refused(500, 'Server Error')))
    await execute(failing.run, gh, planned(gh, draft), draft, hooks)

    const again = fake(() => reviewOk)
    const second = memory(state.draft)
    const report = await execute(again.run, gh, planned(gh, state.draft), state.draft, second.hooks)
    expect(again.calls.map(sentBody)).toEqual([
      { commit_id: HEAD, event: 'APPROVE', body: 'Looks right.', comments: [{ path: 'src/one.ts', line: 11, side: 'RIGHT', body: 'words of head-1' }] },
    ])
    expect(report).toMatchObject({ posted: ['head-1'], complete: true })
    expect(second.state.draft.comments.every((c) => c.sent)).toBe(true)

    /* And a third press has nothing to send at all. */
    const third = plan(gh, { ...second.state.draft, verdict: 'comment' }, facts)
    expect(third.ok).toBe(false)
  })

  test('a failure that is not a refusal stops the send: a later commit’s comments and the verdict are not attempted', async () => {
    const draft = two()
    const { hooks } = memory(draft)
    const runner = fake(() => refused(null, 'gh did not answer within 25 seconds.'))
    const report = await execute(runner.run, gh, planned(gh, draft), draft, hooks)
    expect(runner.calls).toHaveLength(1)
    expect(report.unsent).toEqual(['first-1', 'head-1'])
    /* Nothing came back, so nobody knows whether it landed. It says so. */
    expect(report.error).toContain('may or may not have reached the tracker')
  })

  test('when every comment belonged to an earlier commit and there are no words, there is no empty final review', async () => {
    const draft = draftOf(gh, [comment({ id: 'first-1', view: 'commit', commit: FIRST, parent: MERGE_BASE })], 'comment', '')
    const { hooks } = memory(draft)
    const runner = fake(() => reviewOk)
    const report = await execute(runner.run, gh, planned(gh, draft), draft, hooks)
    expect(runner.calls).toHaveLength(1)
    expect(report).toMatchObject({ posted: ['first-1'], complete: true, verdictSent: true })
  })
})

describe('the executor, GitLab', () => {
  const glFacts: Facts = { ...facts, base: MERGE_BASE, start: BASE }
  const thread = (id: number) => JSON.stringify({ id: 'd', notes: [{ id }] })
  const kindOf = (run: Run) => pathOf(run).split('/').at(-1)

  test('threads, then the note, then the approval pinned to the head', async () => {
    const draft = draftOf(gl, [comment({ id: 'a' }), comment({ id: 'b', side: 'old' })], 'approve', 'Fine.')
    const { state, hooks } = memory(draft)
    const runner = fake((run) => (kindOf(run) === 'discussions' ? thread(900) : kindOf(run) === 'notes' ? JSON.stringify({ id: 901 }) : '{}'))
    const report = await execute(runner.run, gl, planned(gl, draft, glFacts), draft, hooks)

    expect(runner.calls.map(kindOf)).toEqual(['discussions', 'discussions', 'notes', 'approve'])
    expect(runner.calls.every((c) => c.cmd === 'glab' && c.args.includes('gitlab.example') && c.args.includes('Content-Type: application/json'))).toBe(true)
    expect(sentBody(runner.calls[2]!)).toEqual({ body: 'Fine.' })
    expect(sentBody(runner.calls[3]!)).toEqual({ sha: HEAD })
    expect(report).toMatchObject({ posted: ['a', 'b'], folded: [], unsent: [], summarySent: true, verdictSent: true, complete: true })
    expect(report.notes).toContain('The merge request was approved.')
    expect(state.draft.comments[0]!.sent).toEqual({ at: 'NOW', url: `${GL_URL}#note_900` })
  })

  test('a position GitLab rejects (400) is folded into the note, and the result says no reviewer state was set', async () => {
    const draft = draftOf(gl, [comment({ id: 'a' }), comment({ id: 'b', line: 13 })], 'request-changes', 'Please split this.')
    const { state, hooks } = memory(draft)
    const runner = fake((run) => {
      if (kindOf(run) === 'discussions') return sentBody(run).body === 'words of b' ? refused(400, '400 Bad request - Note {:line_code=>["must be a valid line code"]}') : thread(900)
      return JSON.stringify({ id: 901 })
    })
    const report = await execute(runner.run, gl, planned(gl, draft, glFacts), draft, hooks)

    expect(runner.calls.map(kindOf)).toEqual(['discussions', 'discussions', 'notes'])
    const note = sentBody(runner.calls[2]!).body as string
    expect(note.startsWith(`${CHANGES_REQUESTED}\n\nPlease split this.`)).toBe(true)
    expect(note).toContain('words of b')
    expect(report).toMatchObject({ posted: ['a'], folded: ['b'], complete: true, verdictSent: true })
    expect(report.notes.join(' ')).toContain('GitLab was not asked to set a reviewer state')
    expect(report.notes.join(' ')).toContain('must be a valid line code')
    expect(state.draft.comments[1]!.sent).toEqual({ at: 'NOW', url: `${GL_URL}#note_901`, folded: true })
  })

  test('if the note fails, the comment that was to be folded into it is still unsent', async () => {
    const draft = draftOf(gl, [comment({ id: 'b' })], 'comment', 'Words.')
    const { state, hooks } = memory(draft)
    const runner = fake((run) => (kindOf(run) === 'discussions' ? refused(400, 'Bad request') : refused(403, 'Forbidden')))
    const report = await execute(runner.run, gl, planned(gl, draft, glFacts), draft, hooks)
    expect(report).toMatchObject({ posted: [], folded: [], unsent: ['b'], summarySent: false, complete: false })
    expect(state.draft.comments[0]!.sent).toBeUndefined()
    expect(state.draft.summary).toBe('Words.')
  })

  test('a refused approval (409: pushed since) is reported; the comments and the summary that went out stay sent and are not re-sent', async () => {
    const draft = draftOf(gl, [comment({ id: 'a' })], 'approve', 'Fine.')
    const { state, hooks } = memory(draft)
    const runner = fake((run) => (kindOf(run) === 'discussions' ? thread(1) : kindOf(run) === 'notes' ? JSON.stringify({ id: 2 }) : refused(409, 'SHA does not match HEAD of source branch')))
    const report = await execute(runner.run, gl, planned(gl, draft, glFacts), draft, hooks)
    expect(report).toMatchObject({ posted: ['a'], summarySent: true, verdictSent: false, complete: false })
    expect(report.error).toContain('SHA does not match HEAD')
    /* The summary was cleared the moment it posted, so the next press sends
       only the approval. */
    expect(state.draft.summary).toBe('')
    const next = planned(gl, state.draft, glFacts)
    expect(next.steps.map((s) => s.kind)).toEqual(['gitlab-note', 'gitlab-approve'])
    const again = fake(() => '{}')
    await execute(again.run, gl, next, state.draft, memory(state.draft).hooks)
    expect(again.calls.map(kindOf)).toEqual(['approve'])
  })

  test('a comment known in advance to have no place goes straight into the note', async () => {
    const draft = draftOf(gl, [comment({ id: 'stale', commit: OLDER })], 'comment', '')
    const { state, hooks } = memory(draft)
    const runner = fake(() => JSON.stringify({ id: 5 }))
    const report = await execute(runner.run, gl, planned(gl, draft, { ...glFacts, versions: [] }), draft, hooks)
    expect(runner.calls.map(kindOf)).toEqual(['notes'])
    expect(sentBody(runner.calls[0]!).body).toContain('words of stale')
    expect(report).toMatchObject({ folded: ['stale'], complete: true })
    expect(state.draft.comments[0]!.sent?.folded).toBe(true)
  })
})

describe('the facts are read fresh', () => {
  test('GitHub: the head and the commits, from the tracker', async () => {
    const runner = fake(githubReads)
    const got = await gather(runner.run, gh, draftOf(gh, [comment({ id: 'a' })]))
    expect(got).toEqual({ ok: true, value: facts })
    expect(posts(runner.calls)).toEqual([])
  })

  test('GitLab: the versions are read only when a comment was written against an older head', async () => {
    const answer = (run: Run) => (pathOf(run).endsWith('/versions') ? JSON.stringify([{ head_commit_sha: OLDER, base_commit_sha: MERGE_BASE, start_commit_sha: BASE }]) : pathOf(run).includes('/commits') ? GL_COMMITS : GL_MR)
    const fresh = fake(answer)
    await gather(fresh.run, gl, draftOf(gl, [comment({ id: 'a' })]))
    expect(fresh.calls.some((c) => pathOf(c).endsWith('/versions'))).toBe(false)

    const stale = fake(answer)
    const got = await gather(stale.run, gl, draftOf(gl, [comment({ id: 'a', commit: OLDER })]))
    expect(stale.calls.at(-1)).toEqual({ cmd: 'glab', args: ['api', 'projects/g%2Fsub%2Fp/merge_requests/7/versions', '--hostname', 'gitlab.example'] })
    expect(got.ok && got.value.versions).toEqual([{ head: OLDER, base: MERGE_BASE, start: BASE }])
  })

  test('if the change cannot be read, nothing is planned', async () => {
    const got = await gather(fake(() => refused(404, 'Not Found')).run, gh, draftOf(gh, []))
    expect(got.ok).toBe(false)
  })
})
