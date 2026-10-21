import { describe, expect, test } from 'bun:test'

import {
  addComment,
  dropComment,
  dropRunComments,
  emptyDraft,
  metaOf,
  proposalBody,
  proposalOf,
  proposeReview,
  readDraft,
  rewordComment,
  setVerdict,
  takeProposal,
} from '../review/draft.ts'
import { changeOf, type Comment, type Draft, type Meta } from '../review/shape.ts'
import { locate } from '../forge/locate.ts'

import { FIRST, GH_URL, HEAD } from './fake.ts'

/**
 * What an agent review run may do to a draft, as pure functions: the person's
 * words are theirs, a run's are the run's, and a re-run replaces only its own.
 */

const AT = '2026-10-21T10:00:00.000Z'
const target = locate(GH_URL)!

const META = {
  run: 'run-1',
  severity: 'blocking',
  evidence: [{ kind: 'line', ref: 'src/one.ts:11', quote: 'is this' }],
  challenge: 'It may be deliberate.',
  ruling: 'required',
  reason: 'It breaks the parser.',
  checklist: ['tests-pass'],
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
  at: AT,
  ...over,
})

const meta = (over: Partial<Meta> = {}): Meta => ({ ...(metaOf(META) as { ok: true; meta: Meta }).meta, head: HEAD, ...over })

const PROPOSAL = {
  run: 'run-1',
  summary: 'One thing blocks this.',
  verdict: 'request-changes',
  door: 'two-way',
  uiux: false,
  pathToSuccess: ['Fix the parser at src/one.ts:11.'],
}

function draft(over: Partial<Draft> = {}): Draft {
  return { ...emptyDraft(changeOf(target)), ...over }
}

const must = <T extends { ok: boolean }>(got: T): Extract<T, { ok: true }> => {
  if (!got.ok) throw new Error((got as unknown as { error: string }).error)
  return got as Extract<T, { ok: true }>
}

describe('a point’s meta', () => {
  test('the contract’s shape is taken as it is', () => {
    const got = must(metaOf(META))
    expect(got.meta).toEqual(META as unknown as Meta)
  })

  test('each part that is not what the contract says is refused in a sentence', () => {
    const refusals: [Record<string, unknown>, string][] = [
      [{ ...META, severity: 'urgent' }, 'severity'],
      [{ ...META, ruling: 'rejected' }, 'ruling'],
      [{ ...META, evidence: [] }, 'evidence'],
      [{ ...META, evidence: [{ kind: 'hunch', ref: 'x' }] }, 'evidence'],
      [{ ...META, evidence: [{ kind: 'line', ref: '' }] }, 'evidence'],
      [{ ...META, run: '' }, 'run'],
      [{ ...META, run: 'a run with spaces' }, 'run'],
      [{ ...META, reason: '' }, 'reason'],
      [{ ...META, reason: 'x'.repeat(601) }, 'reason'],
      [{ ...META, checklist: [1, 2] }, 'checklist'],
      [{ ...META, challenge: 7 }, 'challenge'],
    ]
    for (const [value, word] of refusals) {
      const got = metaOf(value)
      expect(got.ok).toBe(false)
      if (!got.ok) expect(got.error).toContain(word)
    }
    expect(metaOf('nope').ok).toBe(false)
  })

  test('a draft on disk keeps a comment’s meta, and a broken meta is dropped rather than the comment', () => {
    const kept = readDraft({ ...draft(), comments: [comment({ id: 'c-1', by: 'agent', meta: meta() }), { ...comment({ id: 'c-2', by: 'agent' }), meta: { run: 'x', severity: 'odd' } }] })!
    expect(kept.comments[0]!.meta).toEqual(meta())
    expect(kept.comments[1]!.id).toBe('c-2')
    expect(kept.comments[1]!.meta).toBeUndefined()
  })
})

describe('a proposal stands beside the person’s summary and verdict', () => {
  test('proposing never touches the person’s summary or verdict', () => {
    const before = draft({ summary: 'My own words.', verdict: 'approve', summaryBy: 'person', verdictBy: 'person' })
    const after = must(proposeReview(before, must(proposalOf(PROPOSAL)).proposal, HEAD, AT)).draft
    expect(after.summary).toBe('My own words.')
    expect(after.verdict).toBe('approve')
    expect(after.proposal).toMatchObject({ ...PROPOSAL, head: HEAD, at: AT })
  })

  test('a second run’s proposal replaces the first; a sent one is not replaced by its own run', () => {
    const one = must(proposeReview(draft(), must(proposalOf(PROPOSAL)).proposal, HEAD, AT)).draft
    const two = must(proposeReview(one, must(proposalOf({ ...PROPOSAL, run: 'run-2', summary: 'Now fine.', verdict: 'approve', pathToSuccess: [] })).proposal, HEAD, AT)).draft
    expect(two.proposal?.run).toBe('run-2')
    const sent: Draft = { ...one, proposal: { ...one.proposal!, sent: { at: AT, head: HEAD } } }
    const again = proposeReview(sent, must(proposalOf(PROPOSAL)).proposal, HEAD, AT)
    expect(again.ok).toBe(false)
  })

  test('what a proposal must say', () => {
    const refusals: [Record<string, unknown>, string][] = [
      [{ ...PROPOSAL, verdict: 'merge' }, 'verdict'],
      [{ ...PROPOSAL, door: 'sideways' }, 'door'],
      [{ ...PROPOSAL, uiux: 'no' }, 'uiux'],
      [{ ...PROPOSAL, summary: '   ' }, 'summary'],
      [{ ...PROPOSAL, pathToSuccess: 'fix it' }, 'pathToSuccess'],
      [{ ...PROPOSAL, pathToSuccess: [] }, 'To get this approved'],
      [{ ...PROPOSAL, run: '../x' }, 'run'],
    ]
    for (const [value, word] of refusals) {
      const got = proposalOf(value)
      expect(got.ok).toBe(false)
      if (!got.ok) expect(got.error).toContain(word)
    }
  })

  test('its body ends with the path to success, numbered', () => {
    const p = must(proposeReview(draft(), must(proposalOf({ ...PROPOSAL, pathToSuccess: ['First.', 'Second.'] })).proposal, HEAD, AT)).draft.proposal!
    expect(proposalBody(p)).toBe('One thing blocks this.\n\n**To get this approved:**\n\n1. First.\n2. Second.')
    expect(proposalBody({ ...p, pathToSuccess: [] })).toBe('One thing blocks this.')
  })

  test('the person takes the summary or the verdict, and a stale page cannot take a newer run’s', () => {
    const one = must(proposeReview(draft({ summary: 'Mine.', summaryBy: 'person' }), must(proposalOf(PROPOSAL)).proposal, HEAD, AT)).draft
    const summary = must(takeProposal(one, 'summary', 'run-1', AT)).draft
    expect(summary.summary).toBe(proposalBody(one.proposal!))
    expect(summary.summaryBy).toBe('person')
    expect(summary.verdict).toBeNull()
    const verdict = must(takeProposal(summary, 'verdict', 'run-1', AT)).draft
    expect(verdict.verdict).toBe('request-changes')
    expect(verdict.verdictBy).toBe('person')
    expect(verdict.proposal?.taken).toEqual({ summary: AT, verdict: AT })
    expect(takeProposal(one, 'summary', 'run-0', AT).ok).toBe(false)
    expect(takeProposal(draft(), 'summary', 'run-1', AT).ok).toBe(false)
    expect(takeProposal(one, 'everything' as 'summary', 'run-1', AT).ok).toBe(false)
  })

  test('a draft on disk keeps its proposal and who set the summary and verdict', () => {
    const one = must(proposeReview(draft({ summary: 'Mine.', summaryBy: 'person', verdictBy: 'agent', verdict: 'comment' }), must(proposalOf(PROPOSAL)).proposal, HEAD, AT)).draft
    const read = readDraft(JSON.parse(JSON.stringify(one)))!
    expect(read.proposal).toEqual(one.proposal!)
    expect(read.summaryBy).toBe('person')
    expect(read.verdictBy).toBe('agent')
    expect(readDraft({ ...one, proposal: { run: 'x', verdict: 'nah' } })!.proposal).toBeUndefined()
  })
})

describe('a re-run replaces only its own unsent comments', () => {
  const mixed = draft({
    summary: 'Mine.',
    summaryBy: 'person',
    comments: [
      comment({ id: 'p-1' }),
      comment({ id: 'a-1', by: 'agent', meta: meta() }),
      comment({ id: 'a-2', by: 'agent', meta: meta(), sent: { at: AT } }),
      comment({ id: 'a-3', by: 'agent', meta: meta({ run: 'run-2' }) }),
      comment({ id: 'a-4', by: 'agent' }),
      /* A person's comment can never carry a run, but if a file says one does, it is still the person's. */
      comment({ id: 'p-2', meta: meta() }),
    ],
  })

  test('only that run’s unsent agent comments go', () => {
    const after = must(dropRunComments(mixed, 'run-1')).draft
    expect(after.comments.map((c) => c.id)).toEqual(['p-1', 'a-2', 'a-3', 'a-4', 'p-2'])
    expect(after.summary).toBe('Mine.')
  })

  test('a run id that is not one is refused', () => {
    expect(dropRunComments(mixed, '').ok).toBe(false)
    expect(dropRunComments(mixed, 7 as unknown as string).ok).toBe(false)
  })

  test('a comment can carry a run’s meta when it is added', () => {
    const added = must(
      addComment(draft(), { view: 'all', commit: HEAD, anchor: { path: 'src/one.ts', side: 'new', line: 11, quote: 'is this' } }, 'Body.', 'agent', AT, 'c-9', meta()),
    ).draft
    expect(added.comments[0]!.meta?.run).toBe('run-1')
  })
})

describe('an agent cannot change what the person wrote', () => {
  const mine = draft({ comments: [comment({ id: 'p-1' }), comment({ id: 'a-1', by: 'agent', commit: FIRST, view: 'commit' })] })

  test('an agent may not reword or drop the person’s comment, and may its own', () => {
    for (const got of [rewordComment(mine, 'p-1', 'Changed.', AT, 'agent'), dropComment(mine, 'p-1', 'agent')]) {
      expect(got.ok).toBe(false)
      if (!got.ok) expect(got.error).toContain('the person’s own')
    }
    expect(rewordComment(mine, 'a-1', 'Changed.', AT, 'agent').ok).toBe(true)
    expect(dropComment(mine, 'a-1', 'agent').ok).toBe(true)
    /* The person may change either. */
    expect(rewordComment(mine, 'a-1', 'Changed.', AT).ok).toBe(true)
    expect(dropComment(mine, 'p-1').ok).toBe(true)
  })

  test('an agent may not replace a summary or verdict the person set; it may set its own and an empty one', () => {
    const set = draft({ summary: 'Mine.', verdict: 'approve', summaryBy: 'person', verdictBy: 'person' })
    expect(setVerdict(set, undefined, 'Theirs.', 'agent').ok).toBe(false)
    expect(setVerdict(set, 'comment', undefined, 'agent').ok).toBe(false)
    /* Repeating what is there changes nothing, so it is not a refusal. */
    expect(setVerdict(set, 'approve', 'Mine.', 'agent').ok).toBe(true)
    /* A draft from before `summaryBy` existed: a summary there is the person's. */
    expect(setVerdict(draft({ summary: 'Old words.' }), undefined, 'Theirs.', 'agent').ok).toBe(false)
    const fresh = must(setVerdict(draft(), 'comment', 'Theirs.', 'agent')).draft
    expect(fresh.summaryBy).toBe('agent')
    expect(fresh.verdictBy).toBe('agent')
    expect(must(setVerdict(fresh, 'approve', 'Theirs, again.', 'agent')).draft.summary).toBe('Theirs, again.')
    /* The person's write marks it theirs. */
    expect(must(setVerdict(fresh, undefined, 'Mine now.')).draft.summaryBy).toBe('person')
  })
})
