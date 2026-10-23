import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'

import { HostRefused, PAGE_OLD, resetServerStanding } from 'kehikot-module-protocol/client'

import type { Report } from '../review/send.ts'
import { emptyDraft, proposalBody } from '../review/draft.ts'
import { shotsOf, type Shots } from '../review/shots.ts'
import { changeOf, type Comment, type Draft, type Proof, type ReplyDraft } from '../review/shape.ts'
import { locate } from '../forge/locate.ts'
import { App, Screen, UNHOSTED } from '../src/app.tsx'
import { drafts } from '../src/view/holding.ts'
import { api as realApi, type Api, type ChangeRead, type CommentInput, type Confirmed } from '../src/wire/api.ts'
import type { CodeLocation, HeaderItemInput, LocationIntent, LocationSetResult, SharedLocation } from 'kehikot-module-protocol'
import type { Host, Press } from '../src/wire/use-kehikot.ts'

import { FIRST, GH_URL, HEAD, MERGE_BASE } from './fake.ts'

/**
 * The words and the controls on screen, asserted by rendering the real page
 * against a plain host object and an `Api` that is an object in this file.
 *
 * Nothing here has a server, and the fake `send` is a function that records
 * its argument — so the test of the Send button cannot send anything.
 */
afterEach(cleanup)
/* Every test is a new tab: what one typed and left in a box is not the next one's to find. */
afterEach(() => sessionStorage.clear())

const AT = '2026-10-07T10:00:00.000Z'
const target = locate(GH_URL)!

const row = (ref: string, over: Record<string, unknown> = {}) => ({
  ref,
  tracker: 'github',
  host: 'github.com',
  repo: 'o/r',
  number: 46,
  kind: 'change',
  state: 'open',
  title: 'feat: an official module list',
  url: GH_URL,
  readAt: AT,
  ...over,
})

const reading = (over: Record<string, unknown>) => ({ at: AT, refreshing: false, sources: [], rows: [], missing: [], ...over })

/* What the page declared to the host's header, whole each time, and where a press on it is taken. */
let declared: HeaderItemInput[][] = []
let pressing: { current: Press | null } = { current: null }
beforeEach(() => {
  declared = []
  pressing = { current: null }
})
const header = (name: string): HeaderItemInput | undefined => declared.at(-1)?.find((item) => item.id === name)
const optionsOf = (name: string): string[] => {
  const item = header(name)
  return item && 'options' in item ? item.options.map((o) => o.label) : []
}
/** Press a header item as the host would, inside act. */
const press = (item: string, value?: string | boolean) => {
  const out: { answer: unknown } = { answer: undefined }
  act(() => {
    out.answer = pressing.current?.({ item, value })
  })
  return out.answer
}

function host(over: Partial<Host> = {}, answer: unknown = reading({ rows: [row('gh#46')] })): Host {
  return {
    where: 'hosted',
    project: 'Thesis',
    projectPath: '/work/thesis',
    epic: 'review-the-list',
    theme: 'dark',
    selection: ['gh#46'],
    trackerAt: AT,
    request: () => Promise.resolve(answer),
    header: (items) => {
      declared.push(items)
    },
    presses: pressing,
    pressed: true,
    ...over,
  }
}

const change: ChangeRead = {
  target,
  ref: 'o/r#46',
  head: HEAD,
  base: MERGE_BASE,
  start: MERGE_BASE,
  title: 'feat: an official module list',
  state: 'open',
  draft: false,
  author: 'Jalez',
  url: GH_URL,
  description: '',
  requested: [],
  commits: [
    { sha: FIRST, title: 'first: lay the file down', author: 'Jalez', at: AT, parents: [MERGE_BASE] },
    { sha: HEAD, title: 'second: change it', author: 'Jalez', at: AT, parents: [FIRST] },
  ],
  more: false,
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

const REPORT: Report = {
  posted: ['c-1'],
  folded: [],
  unsent: [],
  summarySent: true,
  verdictSent: true,
  complete: true,
  error: null,
  notes: ['1 comment was posted to GitHub on its line.', 'The review was submitted as “approve”.'],
}

/** The Before / after view's answer: one pair, one alone, one refused. */
const SHOTS: Shots = shotsOf(target, [
  { where: 'the description', text: '| Before | After |\n|---|---|\n| ![](https://github.com/a.png) | ![](https://github.com/b.png) |' },
  { where: 'a comment by ada', text: 'Also ![menu](https://user-images.githubusercontent.com/c.png) and ![x](javascript:alert(1)) ![y](https://evil.example/y.png)' },
])

/** An `Api` held in memory. Every call is recorded; `send` posts nothing anywhere. */
function fakeApi(start: Partial<Draft> = {}) {
  const calls = {
    added: [] as CommentInput[],
    kept: [] as string[],
    resolved: [] as [string, boolean][],
    evidenceDropped: [] as string[],
    focus: [] as unknown[][],
    replies: [] as unknown[][],
    sent: [] as Confirmed[],
    verdicts: [] as unknown[][],
    dropped: [] as string[],
    reworded: [] as string[][],
    taken: [] as string[][],
    shots: 0,
  }
  const state = { draft: { ...emptyDraft(changeOf(target)), ...start } as Draft }
  let n = state.draft.comments.length
  const api: Api = {
    change: () => Promise.resolve(change),
    draft: () => Promise.resolve(state.draft),
    login: () => Promise.resolve('Jalez'),
    addComment: (_p, _u, input) => {
      calls.added.push(input)
      n += 1
      state.draft = { ...state.draft, comments: [...state.draft.comments, comment({ id: `c-${n}`, ...input, quote: 'q' })] }
      return Promise.resolve(state.draft)
    },
    reword: (_p, _u, id, body) => {
      calls.reworded.push([id, body])
      state.draft = { ...state.draft, comments: state.draft.comments.map((c) => (c.id === id ? { ...c, body, ...(c.by === 'agent' ? { kept: AT } : {}) } : c)) }
      return Promise.resolve(state.draft)
    },
    keep: (_p, _u, id) => {
      calls.kept.push(id)
      state.draft = { ...state.draft, comments: state.draft.comments.map((c) => (c.id === id ? { ...c, kept: AT } : c)) }
      return Promise.resolve(state.draft)
    },
    resolve: (_p, _u, id, resolved) => {
      calls.resolved.push([id, resolved])
      state.draft = { ...state.draft, comments: state.draft.comments.map((c) => (c.id === id ? (resolved ? { ...c, resolved: AT } : (({ resolved: _r, ...rest }) => rest)(c)) : c)) }
      return Promise.resolve(state.draft)
    },
    dropEvidence: (_p, _u, id) => {
      calls.evidenceDropped.push(id)
      state.draft = { ...state.draft, evidence: state.draft.evidence.filter((e) => e.id !== id) }
      return Promise.resolve(state.draft)
    },
    evidenceUrl: (_p, _u, id) => `./api/evidence?id=${id}`,
    evidenceText: (_p, _u, id) => Promise.resolve(`the text of ${id}`),
    focus: (...args) => {
      calls.focus.push(args.slice(2))
      return Promise.resolve()
    },
    rewordReply: (_p, _u, id, body, todo) => {
      calls.replies.push(['reword', id, body, todo])
      state.draft = { ...state.draft, replies: state.draft.replies.map((r) => (r.id === id ? { ...r, body, todo, editedAt: AT } : r)) }
      return Promise.resolve(state.draft)
    },
    dropReply: (_p, _u, id) => {
      calls.replies.push(['drop', id])
      state.draft = { ...state.draft, replies: state.draft.replies.filter((r) => r.id !== id) }
      return Promise.resolve(state.draft)
    },
    sendReply: (_p, _u, id, body) => {
      calls.replies.push(['send', id, body])
      state.draft = { ...state.draft, replies: state.draft.replies.map((r) => (r.id === id ? { ...r, sent: { at: AT, url: 'https://github.com/o/r/pull/46#r1' } } : r)) }
      return Promise.resolve(state.draft)
    },
    drop: (_p, _u, id) => {
      calls.dropped.push(id)
      state.draft = { ...state.draft, comments: state.draft.comments.filter((c) => c.id !== id) }
      return Promise.resolve(state.draft)
    },
    setVerdict: (_p, _u, verdict, summary) => {
      calls.verdicts.push([verdict, summary])
      state.draft = { ...state.draft, ...(verdict !== undefined ? { verdict } : {}), ...(summary !== undefined ? { summary } : {}) }
      return Promise.resolve(state.draft)
    },
    takeProposal: (_p, _u, which, run) => {
      calls.taken.push([which, run])
      const p = state.draft.proposal!
      state.draft =
        which === 'summary'
          ? { ...state.draft, summary: proposalBody(p), summaryBy: 'person' }
          : { ...state.draft, verdict: p.verdict, verdictBy: 'person' }
      return Promise.resolve(state.draft)
    },
    shots: () => {
      calls.shots += 1
      return Promise.resolve({ shots: SHOTS })
    },
    send: (_p, _u, confirmed) => {
      calls.sent.push(confirmed)
      state.draft = { ...state.draft, summary: '', verdict: null, comments: state.draft.comments.map((c) => (confirmed.ids.includes(c.id) ? { ...c, sent: { at: AT } } : c)) }
      return Promise.resolve({ draft: state.draft, report: REPORT })
    },
  }
  return { api, calls, state }
}

/** The page, once the change and the review have both arrived. */
async function opened(start: Partial<Draft> = {}, over: Partial<Host> = {}) {
  const made = fakeApi(start)
  const view = render(<Screen host={host(over)} api={made.api} />)
  await waitFor(() => expect(view.container.querySelector('[data-ref="gh#46"] h2')?.textContent).toContain('feat'))
  if (over.projectPath !== null) await screen.findByRole('article', { name: 'The review' })
  return { ...made, ...view }
}

/** A host that records where the page pointed, and answers as `answer` says. */
function pointing(answer: LocationSetResult | null = { outcome: 'taken', why: '' }) {
  const asked: [CodeLocation | null, LocationIntent | undefined][] = []
  return { asked, locate: (location: CodeLocation | null, intent?: LocationIntent) => (asked.push([location, intent]), Promise.resolve(answer)) }
}

const card = (id: string) => document.querySelector(`[data-comment="${id}"]`) as HTMLElement

describe('when there is no change to review, the page says which absence it is', () => {
  test('nothing is framing it', () => {
    render(<Screen host={host({ where: 'unhosted', selection: [], projectPath: null, project: null, epic: null })} api={fakeApi().api} />)
    const cover = document.querySelector('[data-cover]')
    expect(cover?.getAttribute('data-cover')).toBe('unhosted')
    expect(cover?.textContent).toContain('Nothing is framing this page — open Review in Kehikot.')
    /* What this module is for, under the shared sentence. */
    expect(cover?.textContent).toContain(UNHOSTED)
    expect(UNHOSTED).toContain('select a pull request or merge request')
    expect(screen.queryByText(/Nothing is selected/)).toBeNull()
  })

  test('it is still listening for a host', () => {
    render(<Screen host={host({ where: 'listening', selection: [] })} api={fakeApi().api} />)
    expect(document.querySelector('[data-cover]')?.getAttribute('data-cover')).toBe('waiting')
    expect(screen.getByText('Waiting for Kehikot…')).toBeTruthy()
  })

  test('nothing is selected', () => {
    render(<Screen host={host({ selection: [] })} api={fakeApi().api} />)
    expect(document.querySelector('[data-cover]')).toBeNull()
    expect(screen.getByText(/Nothing is selected\. Select a pull request or merge request/)).toBeTruthy()
  })

  test('an issue is selected: it says so, and that nothing went wrong', async () => {
    const issue = reading({ rows: [row('gh#12', { kind: 'issue', url: 'https://github.com/o/r/issues/12' })] })
    const { container } = render(<Screen host={host({ selection: ['gh#12'] }, issue)} api={fakeApi().api} />)
    await screen.findByText(/gh#12 is an issue rather than a change, so there is nothing to review/)
    expect(container.querySelector('[data-kind="issue"]')).toBeTruthy()
    expect(screen.queryByRole('article', { name: 'The review' })).toBeNull()
  })

  test('a reference the tracker has never heard of is named, with the tracker’s reason', async () => {
    const unknown = reading({ missing: [{ ref: 'gh#9999', reason: 'not-found' }] })
    render(<Screen host={host({ selection: ['gh#9999'] }, unknown)} api={fakeApi().api} />)
    await screen.findByText('gh#9999 cannot be reviewed — the tracker has nothing under that reference.')
  })

  test('a reference not read yet is being asked, and a failed read offers a refresh', async () => {
    const pending = reading({ missing: [{ ref: '!3105', reason: 'pending' }], refreshing: true })
    const first = render(<Screen host={host({ selection: ['!3105'] }, pending)} api={fakeApi().api} />)
    await screen.findByText('Asking Kehikot’s tracker reading what !3105 is…')
    first.unmount()
    const failed = reading({ missing: [{ ref: '!3105', reason: 'failed' }] })
    render(<Screen host={host({ selection: ['!3105'] }, failed)} api={fakeApi().api} />)
    await screen.findByText(/the last read of its tracker failed\. Refreshing the trackers may bring it\./)
  })

  test('the host refuses the question: its own words, and no review', async () => {
    const refusing = host({ request: () => Promise.reject(new HostRefused({ reason: 'failed', error: 'This module was not granted trackers:read.' })) })
    render(<Screen host={refusing} api={fakeApi().api} />)
    await screen.findByText(/Kehikot would not say what gh#46 is: This module was not granted trackers:read\./)
    expect(screen.queryByRole('article', { name: 'The review' })).toBeNull()
  })
})

describe('the review, as a document', () => {
  test('the header names the change and links to the tracker; the View switch is the review or the pictures', async () => {
    const { container } = await opened()
    expect(container.querySelector('[data-ref="gh#46"] h2')?.textContent).toBe('gh#46 feat: an official module list')
    expect(screen.getByText('by Jalez')).toBeTruthy()
    expect((screen.getByText('open on the tracker') as HTMLAnchorElement).href).toBe(GH_URL)
    expect(optionsOf('showing')).toEqual(['Review', 'Before / after'])
    expect(header('showing')).toMatchObject({ kind: 'switch', value: 'review' })
  })

  test('with a host that takes addresses, "open on the tracker" hands the change to the canvas instead of a new tab', async () => {
    const handed: string[] = []
    await opened({}, { openAddress: (url) => (handed.push(url), Promise.resolve({ outcome: 'shown', why: '' })) })
    const link = screen.getByText('open on the tracker') as HTMLAnchorElement
    expect(fireEvent.click(link)).toBe(false)
    expect(handed).toEqual([GH_URL])
  })

  test('without one, "open on the tracker" is an ordinary new-tab link', async () => {
    await opened()
    const link = screen.getByText('open on the tracker') as HTMLAnchorElement
    expect(link.target).toBe('_blank')
    expect(fireEvent.click(link)).toBe(true)
  })

  test('no diff is drawn here any more: no file, no line gutter, no commit picker', async () => {
    const { container } = await opened({ comments: [comment({ id: 'c-1' })] })
    expect(container.querySelector('[data-file]')).toBeNull()
    expect(container.querySelector('.diff-row')).toBeNull()
    expect(optionsOf('showing').some((label) => label.includes('first: lay the file down'))).toBe(false)
  })

  test('verdict and summary come first, then the points, the evidence, and the send', async () => {
    const { container } = await opened({ comments: [comment({ id: 'c-1' })], summary: 'Overall fine.', verdict: 'approve' })
    const order = [...container.querySelectorAll('[aria-label="The review"] > section')].map((s) => s.getAttribute('aria-label'))
    expect(order).toEqual(['Verdict and summary', 'Points', 'Evidence', 'Send'])
    expect((screen.getByLabelText(/Summary/) as HTMLTextAreaElement).value).toBe('Overall fine.')
    expect(screen.getByRole('radio', { name: 'Approve' }).getAttribute('aria-checked')).toBe('true')
  })

  test('a point is a card with its code reference, its quoted code, its words and its state', async () => {
    await opened({ comments: [comment({ id: 'c-1', startLine: 9, line: 11, quote: 'const a = 1\nconst b = 2' })] })
    const one = within(card('c-1'))
    expect(one.getByRole('button', { name: 'src/one.ts:9-11@f982d895' })).toBeTruthy()
    expect(card('c-1').querySelector('pre')?.textContent).toBe('const a = 1\nconst b = 2')
    expect(card('c-1').textContent).toContain('words of c-1')
    expect(card('c-1').getAttribute('data-state')).toBe('draft')
  })

  test('with several changes selected it reviews one and offers the others', async () => {
    const two = reading({ rows: [row('gh#46'), row('gh#47', { number: 47, url: 'https://github.com/o/r/pull/47', title: 'Another' })] })
    const made = fakeApi()
    const { container } = render(<Screen host={host({ selection: ['gh#46', 'gh#47'] }, two)} api={made.api} />)
    await waitFor(() => expect(container.querySelector('[data-ref="gh#46"]')).toBeTruthy())
    await waitFor(() => expect(header('change')).toBeTruthy())
    expect(header('change')).toMatchObject({ kind: 'switch', value: 'c0', options: [{ id: 'c0', label: 'gh#46' }, { id: 'c1', label: 'gh#47' }] })
    expect(String(press('change', 'c9'))).toContain('no longer')
    press('change', 'c1')
    await waitFor(() => expect(container.querySelector('[data-ref="gh#47"]')).toBeTruthy())
    expect(container.querySelector('[data-ref="gh#46"]')).toBeNull()
  })

  test('a tracker that will not answer is quoted, with a way to try again', async () => {
    const made = fakeApi()
    let fail = true
    made.api.change = () => (fail ? Promise.reject(new Error('gh: To get started with GitHub CLI, please run: gh auth login')) : Promise.resolve(change))
    render(<Screen host={host()} api={made.api} />)
    await screen.findByText(/gh auth login/)
    fail = false
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await screen.findByRole('article', { name: 'The review' })
  })

  test('with no project open it says there is nowhere to keep a review', async () => {
    render(<Screen host={host({ projectPath: null })} api={fakeApi().api} />)
    await screen.findByText(/No project is open, so there is nowhere to keep a review/)
    expect(screen.queryByRole('article', { name: 'The review' })).toBeNull()
  })
})

describe('a point’s code reference, and a comment asked for at a place', () => {
  test('pressing the code reference points Source and Diff there: location.set, intent show', async () => {
    const at = pointing()
    await opened({ comments: [comment({ id: 'c-1', startLine: 9, line: 11 }), comment({ id: 'c-2', side: 'old', line: 4 })] }, { locate: at.locate })
    fireEvent.click(within(card('c-1')).getByRole('button', { name: /src\/one\.ts:9-11/ }))
    await waitFor(() => expect(at.asked).toHaveLength(1))
    expect(at.asked[0]).toEqual([{ change: 'gh#46', path: 'src/one.ts', line: 9, endLine: 11, side: 'new', commit: HEAD }, 'show'])
    /* A removed line counts on the base, which a whole-change point does not record: no commit. */
    fireEvent.click(within(card('c-2')).getByRole('button', { name: /src\/one\.ts:4/ }))
    await waitFor(() => expect(at.asked).toHaveLength(2))
    expect(at.asked[1]).toEqual([{ change: 'gh#46', path: 'src/one.ts', line: 4, side: 'old' }, 'show'])
    expect(screen.queryByTestId('located')).toBeNull()
  })

  test('a press the host did not take says why, on the card', async () => {
    const at = pointing({ outcome: 'not-selected', why: '' })
    await opened({ comments: [comment({ id: 'c-1' })] }, { locate: at.locate })
    fireEvent.click(within(card('c-1')).getByRole('button', { name: /src\/one\.ts:11/ }))
    expect((await within(card('c-1')).findByTestId('located')).textContent).toContain('not selected on the canvas')
  })

  const asking = (over: Partial<SharedLocation> = {}): SharedLocation => ({
    change: 'gh#46',
    path: 'src/one.ts',
    line: 12,
    side: 'new',
    commit: HEAD,
    intent: 'comment',
    by: 'kehikot.source',
    at: '2026-10-22T10:00:00.000Z',
    ...over,
  })

  test('“comment here” opens New point at that place, and saving anchors it there', async () => {
    const made = fakeApi()
    const view = render(<Screen host={host({ location: asking({ line: 10, endLine: 12 }) })} api={made.api} />)
    const box = await screen.findByLabelText('New point at src/one.ts:10-12', { selector: 'textarea' })
    fireEvent.change(box, { target: { value: 'This branch never runs.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add to review' }))
    await waitFor(() => expect(made.calls.added).toEqual([{ view: 'all', commit: HEAD, path: 'src/one.ts', side: 'new', line: 12, startLine: 10, body: 'This branch never runs.' }]))
    await waitFor(() => expect(screen.queryByTestId('new-point')).toBeNull())
    /* The same ask, delivered again, is not opened twice. */
    view.rerender(<Screen host={host({ location: asking({ line: 10, endLine: 12 }) })} api={made.api} />)
    expect(screen.queryByTestId('new-point')).toBeNull()
    /* A new ask at the same place is: `at` moved. */
    view.rerender(<Screen host={host({ location: asking({ line: 10, endLine: 12, at: '2026-10-22T10:01:00.000Z' }) })} api={made.api} />)
    await screen.findByTestId('new-point')
  })

  test('a removed line is asked at the head the page read, whatever commit the base had', async () => {
    const made = fakeApi()
    render(<Screen host={host({ location: asking({ side: 'old', line: 11, commit: MERGE_BASE }) })} api={made.api} />)
    const box = await screen.findByLabelText('New point at src/one.ts:11 (removed)', { selector: 'textarea' })
    fireEvent.change(box, { target: { value: 'Keep this.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add to review' }))
    await waitFor(() => expect(made.calls.added[0]).toMatchObject({ commit: HEAD, side: 'old', line: 11 }))
  })

  test('“show here”, another change’s place, or this page’s own pointing opens nothing', async () => {
    const made = fakeApi()
    const view = render(<Screen host={host({ location: asking({ intent: 'show' }) })} api={made.api} />)
    await screen.findByRole('article', { name: 'The review' })
    expect(screen.queryByTestId('new-point')).toBeNull()
    view.rerender(<Screen host={host({ location: asking({ change: 'gh#47' }) })} api={made.api} />)
    view.rerender(<Screen host={host({ location: asking({ by: 'kehikot.review' }) })} api={made.api} />)
    await act(async () => void (await new Promise((resolve) => setTimeout(resolve, 20))))
    expect(screen.queryByTestId('new-point')).toBeNull()
  })

  test('the page tells its server what it has open and where somebody points, for read_focus', async () => {
    const made = fakeApi()
    render(<Screen host={host({ location: asking({ intent: 'show' }) })} api={made.api} />)
    await waitFor(() => expect(made.calls.focus.at(-1)).toEqual(['gh#46', 'feat: an official module list', asking({ intent: 'show' })]))
  })

  test('New point… takes a file and lines typed by the person', async () => {
    const { calls } = await opened()
    fireEvent.click(screen.getByRole('button', { name: 'New point…' }))
    const where = within(screen.getByTestId('new-point-where'))
    expect((where.getByRole('button', { name: 'Write the point' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(where.getByLabelText('File'), { target: { value: 'src/one.ts' } })
    fireEvent.change(where.getByLabelText('Lines'), { target: { value: '11' } })
    fireEvent.click(where.getByRole('button', { name: 'Write the point' }))
    fireEvent.change(screen.getByLabelText('New point at src/one.ts:11', { selector: 'textarea' }), { target: { value: 'Why?' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add to review' }))
    await waitFor(() => expect(calls.added).toEqual([{ view: 'all', commit: HEAD, path: 'src/one.ts', side: 'new', line: 11, body: 'Why?' }]))
  })

  test('a refusal from the server is shown under the words, and the words are kept', async () => {
    const made = fakeApi()
    made.api.addComment = () => Promise.reject(new Error('Line 12 is not in the diff of the whole change at f982d895.'))
    render(<Screen host={host({ location: asking() })} api={made.api} />)
    const box = (await screen.findByLabelText('New point at src/one.ts:12', { selector: 'textarea' })) as HTMLTextAreaElement
    fireEvent.change(box, { target: { value: 'Keep me.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add to review' }))
    await screen.findByText('Line 12 is not in the diff of the whole change at f982d895.')
    expect(box.value).toBe('Keep me.')
  })
})

describe('what the person does with a point', () => {
  test('an agent’s point is marked as an agent’s and offers Keep; Remove takes two presses', async () => {
    const { calls } = await opened({ comments: [comment({ id: 'c-1', by: 'agent' }), comment({ id: 'c-2' })] })
    expect(within(card('c-1')).getByText('agent')).toBeTruthy()
    expect(within(card('c-2')).queryByRole('button', { name: 'Keep' })).toBeNull()
    fireEvent.click(within(card('c-1')).getByRole('button', { name: 'Keep' }))
    await waitFor(() => expect(calls.kept).toEqual(['c-1']))
    await waitFor(() => expect(card('c-1').getAttribute('data-state')).toBe('kept'))
    expect(within(card('c-1')).queryByRole('button', { name: 'Keep' })).toBeNull()
    fireEvent.click(within(card('c-2')).getByRole('button', { name: 'Remove' }))
    expect(calls.dropped).toEqual([])
    fireEvent.click(within(card('c-2')).getByRole('button', { name: 'Remove it?' }))
    await waitFor(() => expect(calls.dropped).toEqual(['c-2']))
  })

  test('Edit rewords a point in place', async () => {
    const { calls } = await opened({ comments: [comment({ id: 'c-1', body: 'first words' })] })
    fireEvent.click(within(card('c-1')).getByRole('button', { name: 'Edit' }))
    fireEvent.change(screen.getByLabelText(/Reword the point on/, { selector: 'textarea' }), { target: { value: 'better words' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(calls.reworded).toEqual([['c-1', 'better words']]))
  })

  test('a point an agent adds over MCP appears when the window regains focus', async () => {
    const made = await opened()
    made.state.draft = { ...made.state.draft, comments: [comment({ id: 'c-9', by: 'agent', body: 'from the agent' })] }
    act(() => void window.dispatchEvent(new Event('focus')))
    await screen.findByText('from the agent')
  })

  test('a point written against an older head is marked, not moved', async () => {
    await opened({ comments: [comment({ id: 'c-1', commit: FIRST })] })
    expect(card('c-1').textContent).toContain('an older head')
  })

  test('a sent point says so, offers neither edit nor remove, and can be resolved and opened again', async () => {
    const { calls } = await opened({ comments: [comment({ id: 'c-1', sent: { at: AT, url: 'https://github.com/o/r/pull/46#r1' } })] })
    expect(card('c-1').getAttribute('data-state')).toBe('sent')
    expect(within(card('c-1')).queryByRole('button', { name: 'Edit' })).toBeNull()
    expect(within(card('c-1')).queryByRole('button', { name: 'Remove' })).toBeNull()
    fireEvent.click(within(card('c-1')).getByRole('button', { name: 'Mark resolved' }))
    await waitFor(() => expect(calls.resolved).toEqual([['c-1', true]]))
    await waitFor(() => expect(card('c-1').getAttribute('data-state')).toBe('resolved'))
    fireEvent.click(within(card('c-1')).getByRole('button', { name: 'Open again' }))
    await waitFor(() => expect(calls.resolved).toEqual([['c-1', true], ['c-1', false]]))
  })
})

describe('evidence', () => {
  const proof = (over: Partial<Proof> & { id: string }): Proof => ({ kind: 'screenshot', caption: `caption of ${over.id}`, file: `${over.id}.png`, bytes: 100, by: 'agent', at: AT, ...over })

  test('a point shows its evidence small; a screenshot opens full size, a log opens as text', async () => {
    await opened({
      comments: [comment({ id: 'c-1' })],
      evidence: [proof({ id: 'e-000000000001', point: 'c-1' }), proof({ id: 'e-000000000002', kind: 'log', file: 'e-000000000002.txt', point: 'c-1' }), proof({ id: 'e-000000000003' })],
    })
    const small = within(card('c-1')).getByTestId('point-evidence')
    expect([...small.querySelectorAll('[data-evidence]')].map((e) => e.getAttribute('data-evidence'))).toEqual(['e-000000000001', 'e-000000000002'])
    const img = small.querySelector('img')!
    expect(img.getAttribute('src')).toBe('./api/evidence?id=e-000000000001')
    expect(img.getAttribute('referrerpolicy')).toBe('no-referrer')
    fireEvent.click(img.closest('button')!)
    expect((await screen.findByTestId('evidence-full')).getAttribute('src')).toBe('./api/evidence?id=e-000000000001')
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByTestId('evidence-full')).toBeNull())
    fireEvent.click(within(small).getByTitle('Open: caption of e-000000000002'))
    await waitFor(() => expect(screen.getByTestId('evidence-text').textContent).toBe('the text of e-000000000002'))
  })

  test('the Evidence section lists everything, says which point it supports, and the person can remove it', async () => {
    const { calls } = await opened({ comments: [comment({ id: 'c-1' })], evidence: [proof({ id: 'e-000000000001', point: 'c-1', run: 'review-pass' })] })
    const section = within(screen.getByRole('region', { name: 'Evidence' }))
    expect(section.getByText(/collected by an agent \(run review-pass\) · on src\/one\.ts:11@f982d895/)).toBeTruthy()
    fireEvent.click(section.getByRole('button', { name: 'Remove' }))
    fireEvent.click(section.getByRole('button', { name: 'Remove it?' }))
    await waitFor(() => expect(calls.evidenceDropped).toEqual(['e-000000000001']))
  })
})

describe('replies to the reviewers of the person’s own change', () => {
  const REPLY: ReplyDraft = { id: 'r-000000000001', thread: 'gh-comment:7', where: 'src/one.ts:11', from: 'ada', said: 'Why this?', body: 'Because of the parser.', todo: 'Nothing.', by: 'agent', at: AT }

  test('a reply shows what was said and the answer; posting takes two presses and posts the words shown', async () => {
    const { calls } = await opened({ replies: [REPLY] })
    const reply = within(document.querySelector('[data-reply="r-000000000001"]') as HTMLElement)
    expect(reply.getByText(/Why this\?/)).toBeTruthy()
    expect(reply.getByText('Because of the parser.')).toBeTruthy()
    fireEvent.click(reply.getByRole('button', { name: 'Post reply…' }))
    expect(calls.replies).toEqual([])
    expect(reply.getByTestId('reply-confirm').textContent).toContain('Nothing has been posted yet')
    fireEvent.click(reply.getByRole('button', { name: 'Post it' }))
    await waitFor(() => expect(calls.replies).toEqual([['send', 'r-000000000001', 'Because of the parser.']]))
    await waitFor(() => expect(reply.getByText('posted')).toBeTruthy())
  })

  test('the person edits a reply and what to change', async () => {
    const { calls } = await opened({ replies: [REPLY] })
    const reply = within(document.querySelector('[data-reply="r-000000000001"]') as HTMLElement)
    fireEvent.click(reply.getByRole('button', { name: 'Edit' }))
    fireEvent.change(reply.getByLabelText('Your reply'), { target: { value: 'Fixed in the next push.' } })
    fireEvent.click(reply.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(calls.replies).toEqual([['reword', 'r-000000000001', 'Fixed in the next push.', 'Nothing.']]))
  })
})

describe('sending', () => {
  test('the first press shows exactly what will be posted and posts nothing; the second posts that', async () => {
    const { calls } = await opened({
      comments: [comment({ id: 'c-1' }), comment({ id: 'c-2', by: 'agent', line: 12, kept: AT }), comment({ id: 'c-3', by: 'agent', line: 13 })],
      verdict: 'approve',
      summary: 'Looks right.',
    })
    fireEvent.click(screen.getByRole('button', { name: 'Send review…' }))
    const confirm = within(await screen.findByTestId('confirm'))
    expect(confirm.getByText('Nothing has been posted yet. This is what will be:')).toBeTruthy()
    expect(confirm.getByText(/2 points, 1 of them drafted by an agent and kept by you, posted under your name\./)).toBeTruthy()
    expect(confirm.getByText(/1 agent point you have not kept stays here as a draft, unsent\./)).toBeTruthy()
    expect(confirm.getByText('A summary of 12 characters.')).toBeTruthy()
    expect(confirm.getByText('Approve')).toBeTruthy()
    await waitFor(() => expect(screen.getByTestId('confirm').textContent).toContain('To o/r#46 on GitHub, through your own gh login — as Jalez.'))
    expect(calls.sent).toEqual([])

    fireEvent.click(confirm.getByRole('button', { name: 'Post it to GitHub' }))
    /* Only the person's point and the one they kept. */
    await waitFor(() => expect(calls.sent).toEqual([{ ids: ['c-1', 'c-2'], verdict: 'approve', summary: 'Looks right.' }]))
    const report = within(await screen.findByTestId('report'))
    expect(report.getByText('Sent.')).toBeTruthy()
    expect(screen.queryByTestId('confirm')).toBeNull()
    expect(card('c-3').getAttribute('data-sent')).toBe('no')
  })

  test('“Not yet” closes the confirmation and nothing was sent', async () => {
    const { calls } = await opened({ comments: [comment({ id: 'c-1' })], verdict: 'comment' })
    fireEvent.click(screen.getByRole('button', { name: 'Send review…' }))
    fireEvent.click(within(await screen.findByTestId('confirm')).getByRole('button', { name: 'Not yet' }))
    expect(screen.queryByTestId('confirm')).toBeNull()
    expect(calls.sent).toEqual([])
  })

  test('without a verdict it asks for one instead of confirming', async () => {
    const { calls } = await opened({ comments: [comment({ id: 'c-1' })] })
    fireEvent.click(screen.getByRole('button', { name: 'Send review…' }))
    await screen.findByText('Choose a verdict first: Comment, Approve or Request changes.')
    expect(screen.queryByTestId('confirm')).toBeNull()
    fireEvent.click(screen.getByRole('radio', { name: 'Request changes' }))
    await waitFor(() => expect(calls.verdicts).toEqual([['request-changes', undefined]]))
  })

  test('the summary is saved when the box is left, and before a confirmation is shown', async () => {
    const { calls } = await opened({ verdict: 'approve' })
    fireEvent.change(screen.getByLabelText(/Summary/), { target: { value: 'Ship it.' } })
    expect(calls.verdicts).toEqual([])
    fireEvent.click(screen.getByRole('button', { name: 'Send review…' }))
    const confirm = within(await screen.findByTestId('confirm'))
    expect(calls.verdicts).toEqual([[undefined, 'Ship it.']])
    expect(confirm.getByText('0 points.')).toBeTruthy()
  })

  test('with nothing the person may send, Send is not offered as a live button', async () => {
    await opened({ comments: [comment({ id: 'c-1', by: 'agent' })] })
    expect((screen.getByRole('button', { name: 'Send review…' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByRole('region', { name: 'Send' }).textContent).toContain('1 agent point is not kept yet')
  })

  test('a send that is refused shows the tracker’s words and leaves the review as the server says it is', async () => {
    const made = fakeApi({ comments: [comment({ id: 'c-1' })], verdict: 'approve' })
    made.api.send = () => Promise.reject(new Error('The review changed after you looked at it, so nothing was sent.'))
    render(<Screen host={host()} api={made.api} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Send review…' }))
    fireEvent.click(within(await screen.findByTestId('confirm')).getByRole('button', { name: 'Post it to GitHub' }))
    await screen.findByText('The review changed after you looked at it, so nothing was sent.')
    expect(screen.queryByTestId('report')).toBeNull()
    expect(card('c-1').getAttribute('data-sent')).toBe('no')
  })
})

/*
 * The page's own server, through the protocol's `ask()`: which header a write carries, what a
 * refusal says, and what the page draws when nothing answers or it is older than its server.
 */
describe('this app’s own server: the ticket a write carries, and the cover when it is not there', () => {
  const realFetch = globalThis.fetch
  let down = false
  let reply: (url: string, init?: RequestInit) => Response = () => new Response('{}', { status: 200 })
  let calls: { url: string; init: RequestInit | undefined }[] = []
  const cover = () => document.querySelector('[data-cover]')
  const island = () => {
    const ticket = document.createElement('script')
    ticket.id = 'ticket'
    ticket.type = 'application/json'
    ticket.textContent = JSON.stringify('the-ticket')
    document.body.append(ticket)
  }

  beforeEach(() => {
    down = false
    calls = []
    reply = () => new Response(JSON.stringify({ ok: true }), { status: 200 })
    resetServerStanding()
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), init })
      if (down) throw new TypeError('Load failed')
      return reply(String(url), init)
    }) as unknown as typeof fetch
  })
  afterEach(() => {
    globalThis.fetch = realFetch
    resetServerStanding()
    document.documentElement.className = ''
    document.getElementById('ticket')?.remove()
  })

  test('a write carries the page’s ticket in x-module-ticket; a read carries none', async () => {
    island()
    const draft = emptyDraft(changeOf(target))
    reply = () => new Response(JSON.stringify({ ok: true, draft }), { status: 200 })
    await realApi.addComment('/p', GH_URL, { view: 'all', commit: HEAD, path: 'src/one.ts', side: 'new', line: 11, body: 'why?' })
    await realApi.draft('/p', GH_URL)
    const [write, read] = calls
    expect(write?.url).toBe('./api/comment')
    expect(write?.init?.method).toBe('POST')
    expect((write?.init?.headers as Record<string, string>)['x-module-ticket']).toBe('the-ticket')
    expect(JSON.parse(String(write?.init?.body))).toMatchObject({ projectPath: '/p', url: GH_URL, path: 'src/one.ts', line: 11, body: 'why?' })
    expect(read?.url).toBe(`./api/draft?${new URLSearchParams({ projectPath: '/p', url: GH_URL })}`)
    expect((read?.init?.headers as Record<string, string>)['x-module-ticket']).toBeUndefined()
  })

  test('a refused write throws the server’s own sentence — at 409, and at 200 with ok: false', async () => {
    reply = () => new Response(JSON.stringify({ ok: false, error: 'A send for this change is already under way. Wait for it to finish.' }), { status: 409 })
    await expect(realApi.send('/p', GH_URL, { ids: [], verdict: 'approve', summary: '' })).rejects.toThrow('A send for this change is already under way.')
    reply = () => new Response(JSON.stringify({ ok: false, error: 'not done, and why' }), { status: 200 })
    await expect(realApi.drop('/p', GH_URL, 'c-1')).rejects.toThrow('not done, and why')
    /* A refusal is the server answering: no cover. */
    render(<Screen host={host()} api={fakeApi().api} />)
    expect(cover()).toBeNull()
  })

  test('a write refused for the ticket is a page older than its server: the stale cover, the review still mounted', async () => {
    const view = (await opened()).container
    reply = () => new Response(JSON.stringify({ ok: false, error: 'old page', refused: 'ticket' }), { status: 403 })
    await act(async () => void (await realApi.drop('/p', GH_URL, 'c-1').catch(() => {})))
    expect(cover()?.getAttribute('data-cover')).toBe('stale')
    expect(cover()?.textContent).toContain('This page is older than its server')
    expect(view.querySelector('[aria-label="The review"]')?.closest('[hidden]')).not.toBeNull()
  })

  test('its own server not answering: the down cover over the mounted review, and Try again brings it back', async () => {
    const view = (await opened()).container
    down = true
    await act(async () => void (await realApi.draft('/p', GH_URL).catch(() => {})))
    expect(cover()?.getAttribute('data-cover')).toBe('down')
    expect(cover()?.textContent).toContain('Review’s own server is not answering.')
    /* Hidden, not gone: the review and anything typed in it are still there. */
    const file = view.querySelector('[aria-label="The review"]')
    expect(file?.closest('[hidden]')).not.toBeNull()
    await act(async () => {
      fireEvent.click(within(cover() as HTMLElement).getByRole('button', { name: 'Try again' }))
      await new Promise((resolve) => setTimeout(resolve, 30))
    })
    expect(cover()?.getAttribute('data-cover')).toBe('down')
    down = false
    await act(async () => {
      fireEvent.click(within(cover() as HTMLElement).getByRole('button', { name: 'Try again' }))
      await new Promise((resolve) => setTimeout(resolve, 30))
    })
    expect(cover()).toBeNull()
    expect(calls.at(-1)?.url).toBe('./healthz')
    expect(view.querySelector('[aria-label="The review"]')).toBe(file)
  })

  test('the real page waits, then says nothing is framing it; a greeting brings the host’s theme and no cover', async () => {
    const view = render(<App />)
    await act(async () => void (await new Promise((resolve) => setTimeout(resolve, 30))))
    expect(cover()?.getAttribute('data-cover')).toBe('waiting')
    await act(async () => void (await new Promise((resolve) => setTimeout(resolve, 800))))
    expect(cover()?.getAttribute('data-cover')).toBe('unhosted')
    view.unmount()

    render(<App />)
    await act(async () => {
      window.postMessage({ type: 'kehikot.hello', protocol: 2, session: 's', state: null, context: { epic: null, project: 'p', projectPath: '/p', theme: 'dark', selection: [] } }, '*')
      await new Promise((resolve) => setTimeout(resolve, 30))
    })
    expect(cover()).toBeNull()
    expect(document.documentElement.classList.contains('dark')).toBe(true)
    expect(screen.getByText(/Nothing is selected/)).toBeTruthy()
    /* This module offers neither a clear nor a refresh, so those presses — which `useHost` does deliver — change nothing. */
    await act(async () => {
      window.postMessage({ type: 'kehikot.clear', protocol: 2 }, '*')
      window.postMessage({ type: 'kehikot.refresh', protocol: 2 }, '*')
      await new Promise((resolve) => setTimeout(resolve, 30))
    })
    expect(screen.getByText(/Nothing is selected/)).toBeTruthy()
    expect(cover()).toBeNull()
  })
})

/*
 * What was being typed survives a reload of the page. A stale page reloads itself — on the Save
 * press that found it out, or on the review re-read — so every box writes its words as they change,
 * under the project, the change and exactly what they were aimed at. "Reload" here is unmounting the
 * page and mounting a new one over the same sessionStorage, which is what a reload is to this code.
 */
describe('typed words are held across a reload, aimed at what they were typed on', () => {
  const P = '/work/thesis'
  const held = (project = P) => Object.entries(drafts.at(project).all())
  const reload = async (start: Partial<Draft> = {}, over: Partial<Host> = {}) => {
    cleanup()
    return opened(start, over)
  }

  test('a new point at a place: typed → reload → asked again there, its words are back', async () => {
    const at: SharedLocation = { change: 'gh#46', path: 'src/one.ts', line: 12, side: 'new', intent: 'comment', at: 'a' }
    await opened({}, { location: at })
    fireEvent.change(screen.getByLabelText('New point at src/one.ts:12', { selector: 'textarea' }), { target: { value: 'Half a thought' } })
    expect(held()[0]?.[0]).toBe(`${GH_URL}|new:new:12:12:src/one.ts`)
    await reload({}, { location: { ...at, at: 'b' } })
    expect((screen.getByLabelText('New point at src/one.ts:12', { selector: 'textarea' }) as HTMLTextAreaElement).value).toBe('Half a thought')
    /* Cancel is throwing them away on purpose. */
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(held()).toEqual([])
  })

  test('a rewording: restored open on its card; and when the point changed meanwhile it says so', async () => {
    await opened({ comments: [comment({ id: 'c-1', body: 'first words' })] })
    fireEvent.click(within(card('c-1')).getByRole('button', { name: 'Edit' }))
    const label = /Reword the point on/
    expect(held()).toEqual([])
    fireEvent.change(screen.getByLabelText(label, { selector: 'textarea' }), { target: { value: 'better words' } })
    expect(held()[0]).toEqual([`${GH_URL}|reword:c-1`, { base: 'first words', text: 'better words', aim: expect.stringContaining('a rewording of the point on') }])
    await reload({ comments: [comment({ id: 'c-1', body: 'an agent reworded this' })] })
    expect((screen.getByLabelText(label, { selector: 'textarea' }) as HTMLTextAreaElement).value).toBe('better words')
    expect(screen.getByTestId('held-stale').textContent).toContain('an agent reworded this')
  })

  test('the summary: typed and not yet left → reload → in the box, still unsaved, and saved by the next blur', async () => {
    const first = await opened({ summary: 'saved words' })
    const summary = () => screen.getByLabelText(/Summary/) as HTMLTextAreaElement
    fireEvent.change(summary(), { target: { value: 'saved words, and more' } })
    expect(first.calls.verdicts).toEqual([])
    expect(held()[0]).toEqual([`${GH_URL}|summary`, { base: 'saved words', text: 'saved words, and more', aim: 'the review’s summary' }])
    const second = await reload({ summary: 'saved words' })
    expect(summary().value).toBe('saved words, and more')
    fireEvent.blur(summary())
    await waitFor(() => expect(second.calls.verdicts).toEqual([[undefined, 'saved words, and more']]))
    await waitFor(() => expect(held()).toEqual([]))
  })

  test('a write that was refused leaves the words in the box and held', async () => {
    const made = fakeApi()
    made.api.addComment = () => Promise.reject(new Error(PAGE_OLD))
    render(<Screen host={host({ location: { change: 'gh#46', path: 'src/one.ts', line: 12, side: 'new', intent: 'comment', at: 'x' } })} api={made.api} />)
    const box = (await screen.findByLabelText('New point at src/one.ts:12', { selector: 'textarea' })) as HTMLTextAreaElement
    fireEvent.change(box, { target: { value: 'Do not lose this.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add to review' }))
    await screen.findByText(PAGE_OLD)
    expect(box.value).toBe('Do not lose this.')
    expect(held()[0]?.[1]).toMatchObject({ text: 'Do not lose this.' })
  })

  test('a held summary does not silently replace one the server has changed since: it says so', async () => {
    drafts.at(P).keep(`${GH_URL}|summary`, { base: 'saved words', text: 'my unsaved words', aim: 'the review’s summary' })
    await opened({ summary: 'an agent wrote this summary' })
    expect((screen.getByLabelText(/Summary/) as HTMLTextAreaElement).value).toBe('my unsaved words')
    expect(screen.getByTestId('summary-stale').textContent).toContain('an agent wrote this summary')
  })

  test('a different project does not see them', async () => {
    drafts.at('/somewhere/else').keep(`${GH_URL}|summary`, { base: '', text: 'not yours', aim: 'the review’s summary' })
    await opened()
    expect((screen.getByLabelText(/Summary/) as HTMLTextAreaElement).value).toBe('')
  })
})

describe('the header: what the host draws in the container’s own row', () => {
  test('typing in a point declares nothing again', async () => {
    await opened({ comments: [comment({ id: 'c-1' })] })
    fireEvent.click(within(card('c-1')).getByRole('button', { name: 'Edit' }))
    const before = declared.length
    const box = screen.getByLabelText(/Reword the point on/, { selector: 'textarea' })
    fireEvent.change(box, { target: { value: 'a' } })
    fireEvent.change(box, { target: { value: 'ab' } })
    expect(declared.length).toBe(before)
  })

  test('the view switch counts the draft points, and refuses what it does not have', async () => {
    await opened({ comments: [comment({ id: 'c-1' }), comment({ id: 'c-2', line: 12 })] })
    expect(optionsOf('showing')).toEqual(['Review · 2 draft points', 'Before / after'])
    expect(String(press('showing', HEAD))).toContain('review or the Before / after')
  })

  test('the page’s own control is there until a host has pressed one, and not after', async () => {
    const made = fakeApi()
    const { container, rerender } = render(<Screen host={host({ pressed: false })} api={made.api} />)
    await waitFor(() => expect(container.querySelector('[data-header-fallback]')).toBeTruthy())
    rerender(<Screen host={host({ pressed: true })} api={made.api} />)
    await waitFor(() => expect(container.querySelector('[data-header-fallback]')).toBeNull())
  })

  test('the header is taken away when the change is', async () => {
    const made = fakeApi()
    const view = render(<Screen host={host()} api={made.api} />)
    await waitFor(() => expect(header('showing')).toBeTruthy())
    view.unmount()
    expect(declared.at(-1)).toEqual([])
  })
})


describe('a review run, on the page', () => {
  const META = {
    run: 'run-1',
    severity: 'blocking' as const,
    evidence: [
      { kind: 'line' as const, ref: 'src/one.ts:11', quote: 'is this' },
      { kind: 'practice' as const, ref: 'https://example.org/practice' },
      { kind: 'doc' as const, ref: 'javascript:alert(1)' },
    ],
    challenge: 'It may be deliberate.',
    ruling: 'required' as const,
    reason: 'It breaks the parser.',
    head: HEAD,
  }
  const PROPOSAL = {
    run: 'run-1',
    summary: 'One thing blocks this.',
    verdict: 'request-changes' as const,
    door: 'two-way' as const,
    uiux: false,
    pathToSuccess: ['Fix the parser at src/one.ts:11.', 'Add a test.'],
    head: HEAD,
    at: AT,
  }

  test('a point says its severity, ruling, reason, evidence and challenge, in words', async () => {
    await opened({ comments: [comment({ id: 'c-1', by: 'agent', meta: META })] })
    expect(card('c-1').textContent).toContain('Blocking')
    const point = within(card('c-1')).getByTestId('point')
    expect(point.textContent).toContain('Required')
    expect(point.textContent).toContain('It breaks the parser.')
    expect(point.textContent).toContain('It may be deliberate.')
    expect(point.textContent).toContain('src/one.ts:11')
    /* Only an https source is a link; anything else is text. */
    const links = [...point.querySelectorAll('a')].map((a) => a.getAttribute('href'))
    expect(links).toEqual(['https://example.org/practice'])
    expect(point.textContent).toContain('javascript:alert(1)')
  })

  test('the proposal is beside the person’s summary, with the path to success, and is taken only when pressed', async () => {
    const made = await opened({ summary: 'My own words.', summaryBy: 'person', proposal: PROPOSAL })
    const box = screen.getByTestId('proposal')
    expect(box.textContent).toContain('Proposed by review run run-1')
    expect(box.textContent).toContain('Request changes')
    expect(box.textContent).toContain('To get this approved:')
    expect([...box.querySelectorAll('ol li')].map((li) => li.textContent)).toEqual(['Fix the parser at src/one.ts:11.', 'Add a test.'])
    expect(box.textContent).toContain('Two-way')
    /* The person's summary is untouched. */
    expect((screen.getByLabelText(/Summary/) as HTMLTextAreaElement).value).toBe('My own words.')

    fireEvent.click(within(box).getByRole('button', { name: 'Use this verdict' }))
    await waitFor(() => expect(made.calls.taken).toEqual([['verdict', 'run-1']]))

    /* Their own words are there, so taking the summary asks first. */
    fireEvent.click(within(box).getByRole('button', { name: 'Use this summary' }))
    expect(made.calls.taken).toHaveLength(1)
    fireEvent.click(within(box).getByRole('button', { name: 'Replace your summary?' }))
    await waitFor(() => expect(made.calls.taken).toEqual([['verdict', 'run-1'], ['summary', 'run-1']]))
    await waitFor(() => expect((screen.getByLabelText(/Summary/) as HTMLTextAreaElement).value).toBe(proposalBody(PROPOSAL)))
  })

  test('a one-way or UI change says it waits for the person; a sent one says so', async () => {
    await opened({ proposal: { ...PROPOSAL, door: 'one-way', uiux: true } })
    const box = screen.getByTestId('proposal')
    expect(box.textContent).toContain('One-way')
    expect(box.textContent).toContain('what people see')
    cleanup()
    await opened({ proposal: { ...PROPOSAL, sent: { at: AT, head: HEAD } } })
    expect(screen.getByTestId('proposal').textContent).toContain('Sent by Factory')
  })
})

describe('the Before / after view', () => {
  test('is a View option; it shows pairs side by side, and a refused picture only as text', async () => {
    const made = await opened()
    expect(header('showing')).toBeTruthy()
    expect(press('showing', 'shots')).toBe(true)
    const view = await screen.findByTestId('shots')
    await waitFor(() => expect(view.querySelectorAll('img').length).toBe(3))
    expect(made.calls.shots).toBe(1)
    const pair = view.querySelector('[data-pair]')!
    expect([...pair.querySelectorAll('img')].map((img) => img.getAttribute('src'))).toEqual(['https://github.com/a.png', 'https://github.com/b.png'])
    expect(pair.textContent).toContain('Before')
    expect(pair.textContent).toContain('After')
    for (const img of view.querySelectorAll('img')) {
      expect(img.getAttribute('src')!.startsWith('https://')).toBe(true)
      expect(img.getAttribute('referrerpolicy')).toBe('no-referrer')
    }
    const refused = view.querySelector('[data-refused]')!
    expect(refused.textContent).toContain('evil.example')
    expect(refused.querySelector('a')).toBeNull()
    expect(refused.querySelector('img')).toBeNull()
    /* The review is not drawn under it. */
    expect(document.querySelector('[aria-label="The review"]')).toBeNull()
    await waitFor(() => expect(header('showing')).toMatchObject({ value: 'shots' }))
    /* And back. */
    expect(press('showing', 'review')).toBe(true)
    await waitFor(() => expect(document.querySelector('[aria-label="The review"]')).toBeTruthy())
  })
})
