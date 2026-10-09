import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'

import { HostRefused, resetServerStanding } from 'kehikot-module-protocol/client'

import type { Report } from '../review/send.ts'
import { emptyDraft } from '../review/draft.ts'
import { changeOf, type Comment, type Draft } from '../review/shape.ts'
import { locate } from '../forge/locate.ts'
import { App, Screen, UNHOSTED } from '../src/app.tsx'
import { api as realApi, type Api, type ChangeRead, type CommentInput, type Confirmed } from '../src/wire/api.ts'
import type { Host } from '../src/wire/use-kehikot.ts'

import { COMMIT_PATCH, FIRST, GH_URL, HEAD, MERGE_BASE, PATCH } from './fake.ts'

/**
 * The words and the controls on screen, asserted by rendering the real page
 * against a plain host object and an `Api` that is an object in this file.
 *
 * Nothing here has a server, and the fake `send` is a function that records
 * its argument — so the test of the Send button cannot send anything.
 */
afterEach(cleanup)

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

/** An `Api` held in memory. Every call is recorded; `send` posts nothing anywhere. */
function fakeApi(start: Partial<Draft> = {}) {
  const calls = { diff: [] as [string, string][], added: [] as CommentInput[], sent: [] as Confirmed[], verdicts: [] as unknown[][], dropped: [] as string[], reworded: [] as string[][] }
  const state = { draft: { ...emptyDraft(changeOf(target)), ...start } as Draft }
  let n = state.draft.comments.length
  const api: Api = {
    change: () => Promise.resolve(change),
    diff: (_url, view, sha) => {
      calls.diff.push([view, sha])
      return Promise.resolve({ text: view === 'all' ? PATCH : COMMIT_PATCH, truncated: false, view, sha, from: 'cli' as const })
    },
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
      state.draft = { ...state.draft, comments: state.draft.comments.map((c) => (c.id === id ? { ...c, body } : c)) }
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
    send: (_p, _u, confirmed) => {
      calls.sent.push(confirmed)
      state.draft = { ...state.draft, summary: '', verdict: null, comments: state.draft.comments.map((c) => ({ ...c, sent: { at: AT } })) }
      return Promise.resolve({ draft: state.draft, report: REPORT })
    },
  }
  return { api, calls, state }
}

/** The page, once the change, its diff and the draft have all arrived. */
async function opened(start: Partial<Draft> = {}, over: Partial<Host> = {}) {
  const made = fakeApi(start)
  const view = render(<Screen host={host(over)} api={made.api} />)
  await waitFor(() => expect(view.container.querySelector('[data-file="src/one.ts"]')).toBeTruthy())
  if (over.projectPath !== null) await screen.findByRole('region', { name: 'Your review' })
  return { ...made, ...view }
}

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
    expect(screen.queryByText(/Your review/)).toBeNull()
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
    expect(screen.queryByText(/Your review/)).toBeNull()
  })
})

describe('a change, with its commits and a diff', () => {
  test('the header names it, links to the tracker, and the picker lists every commit', async () => {
    const { container } = await opened()
    expect(container.querySelector('[data-ref="gh#46"] h2')?.textContent).toBe('gh#46 feat: an official module list')
    expect(screen.getByText('open')).toBeTruthy()
    expect(screen.getByText('by Jalez')).toBeTruthy()
    expect((screen.getByText('open on the tracker') as HTMLAnchorElement).href).toBe(GH_URL)
    const picker = screen.getByLabelText('Which changes to show') as HTMLSelectElement
    expect([...picker.options].map((o) => o.textContent)).toEqual(['All changes', '11111111 first: lay the file down', 'f982d895 second: change it'])
    expect(picker.value).toBe('all')
  })

  test('every file of the diff is drawn, with both line-number gutters and the marks in the text', async () => {
    const { container, calls } = await opened()
    expect(calls.diff).toEqual([['all', HEAD]])
    expect([...container.querySelectorAll('[data-file]')].map((f) => f.getAttribute('data-file'))).toEqual(['src/one.ts', 'src/gone.ts', 'logo.png'])
    expect(container.textContent).toContain('3 files')
    const rows = [...container.querySelectorAll('[data-file="src/one.ts"] .diff-row')].map((r) => r.textContent)
    expect(rows).toContain('11-was this')
    expect(rows).toContain('11+is this')
    expect(screen.getByText(/Git says this file is binary/)).toBeTruthy()
  })

  test('the picker shows how many draft comments sit in each view, and files say so too', async () => {
    const { container } = await opened({
      comments: [comment({ id: 'c-1' }), comment({ id: 'c-2', view: 'commit', commit: HEAD, line: 12 }), comment({ id: 'c-3', view: 'commit', commit: HEAD, line: 11 })],
    })
    const picker = screen.getByLabelText('Which changes to show') as HTMLSelectElement
    expect([...picker.options].map((o) => o.textContent)).toEqual(['All changes — 1 comment', '11111111 first: lay the file down', 'f982d895 second: change it — 2 comments'])
    expect(within(container.querySelector('[data-file="src/one.ts"]') as HTMLElement).getByTestId('file-comments').textContent).toBe('1 draft')
  })

  test('picking a commit reads that commit’s own diff, and shows only the comments written in it', async () => {
    const { container, calls } = await opened({
      comments: [comment({ id: 'c-1', body: 'on the whole change' }), comment({ id: 'c-2', view: 'commit', commit: HEAD, line: 12, body: 'on the commit' })],
    })
    const inline = () => [...container.querySelectorAll('.diff-inset [data-comment]')].map((c) => c.getAttribute('data-comment'))
    expect(inline()).toEqual(['c-1'])
    fireEvent.change(screen.getByLabelText('Which changes to show'), { target: { value: HEAD } })
    await waitFor(() => expect(calls.diff).toEqual([['all', HEAD], ['commit', HEAD]]))
    await waitFor(() => expect(inline()).toEqual(['c-2']))
    /* Both are still in the review panel, each saying which diff it belongs to. */
    const panel = within(screen.getByRole('region', { name: 'Your review' }))
    expect(panel.getByText('src/one.ts:11 · all changes at f982d895')).toBeTruthy()
    expect(panel.getByText('src/one.ts:12 · commit f982d895')).toBeTruthy()
  })

  test('with several changes selected it reviews one and offers the others', async () => {
    const two = reading({ rows: [row('gh#46'), row('gh#47', { number: 47, url: 'https://github.com/o/r/pull/47', title: 'Another' })] })
    const made = fakeApi()
    const { container } = render(<Screen host={host({ selection: ['gh#46', 'gh#47'] }, two)} api={made.api} />)
    const group = await screen.findByRole('group', { name: 'Which change to review' })
    expect(within(group).getByRole('button', { name: 'gh#46' }).getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(within(group).getByRole('button', { name: 'gh#47' }))
    await waitFor(() => expect(container.querySelector('[data-ref="gh#47"]')).toBeTruthy())
    expect(container.querySelector('[data-ref="gh#46"]')).toBeNull()
  })

  test('a tracker that will not answer is quoted, with a way to try again', async () => {
    const made = fakeApi()
    made.api.change = () => Promise.reject(new Error('gh: To get started with GitHub CLI, please run: gh auth login'))
    render(<Screen host={host()} api={made.api} />)
    await screen.findByText(/gh auth login/)
    expect(screen.getByText('Try again')).toBeTruthy()
  })

  test('with no project open the diff is readable and no line is a target', async () => {
    const { container } = await opened({}, { projectPath: null, project: null })
    expect(screen.getByText(/No project is open, so there is nowhere to keep a draft/)).toBeTruthy()
    expect(container.querySelectorAll('.diff-row button')).toHaveLength(0)
    expect(screen.queryByText(/Send review/)).toBeNull()
  })
})

describe('composing a comment', () => {
  test('pressing a line number opens a box under that line, and saving anchors it to the view and commit on screen', async () => {
    const { container, calls } = await opened()
    expect(container.querySelector('.diff-inset')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Comment on new line 11 of src/one.ts' }))
    const box = screen.getByLabelText('Comment on new line 11 of src/one.ts', { selector: 'textarea' }) as HTMLTextAreaElement
    expect(container.querySelectorAll('[data-picked="yes"]')).toHaveLength(1)
    /* An empty comment cannot be saved. */
    expect((screen.getByRole('button', { name: 'Add to review' }) as HTMLButtonElement).disabled).toBe(true)

    fireEvent.change(box, { target: { value: 'This reads wrong.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add to review' }))
    await waitFor(() => expect(calls.added).toEqual([{ view: 'all', commit: HEAD, path: 'src/one.ts', side: 'new', line: 11, body: 'This reads wrong.' }]))

    /* It is drawn under its line, marked as the person's, editable and removable. */
    const card = await waitFor(() => container.querySelector('.diff-inset [data-comment="c-1"]') as HTMLElement)
    expect(within(card).getByText('you')).toBeTruthy()
    expect(within(card).getByRole('button', { name: 'Edit' })).toBeTruthy()
    expect(within(card).getByRole('button', { name: 'Remove' })).toBeTruthy()
    expect(container.querySelector('textarea[id^="box-"]')).toBeNull()
    expect(screen.getByText(/1 draft comment$/)).toBeTruthy()
  })

  test('shift-pressing another line of the same column covers the range; the old gutter is the old side', async () => {
    const { container, calls } = await opened()
    fireEvent.click(screen.getByRole('button', { name: 'Comment on new line 11 of src/one.ts' }))
    fireEvent.click(screen.getByRole('button', { name: 'Comment on new line 13 of src/one.ts' }), { shiftKey: true })
    expect(container.querySelectorAll('[data-picked="yes"]')).toHaveLength(3)
    fireEvent.change(screen.getByLabelText('Comment on new lines 11–13 of src/one.ts', { selector: 'textarea' }), { target: { value: 'All of this.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add to review' }))
    await waitFor(() => expect(calls.added[0]).toEqual({ view: 'all', commit: HEAD, path: 'src/one.ts', side: 'new', line: 13, startLine: 11, body: 'All of this.' }))

    /* A shift-press in the OTHER column starts again rather than making a range across sides. */
    fireEvent.click(screen.getByRole('button', { name: 'Comment on new line 11 of src/one.ts' }))
    fireEvent.click(screen.getByRole('button', { name: 'Comment on old line 11 of src/one.ts' }), { shiftKey: true })
    expect(screen.getByLabelText('Comment on old line 11 of src/one.ts', { selector: 'textarea' })).toBeTruthy()
  })

  test('in a commit’s view the comment is anchored to that commit', async () => {
    const { calls } = await opened()
    fireEvent.change(screen.getByLabelText('Which changes to show'), { target: { value: HEAD } })
    await waitFor(() => expect(calls.diff).toHaveLength(2))
    fireEvent.click(await screen.findByRole('button', { name: 'Comment on new line 12 of src/one.ts' }))
    fireEvent.change(screen.getByLabelText('Comment on new line 12 of src/one.ts', { selector: 'textarea' }), { target: { value: 'In this commit.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add to review' }))
    await waitFor(() => expect(calls.added).toEqual([{ view: 'commit', commit: HEAD, path: 'src/one.ts', side: 'new', line: 12, body: 'In this commit.' }]))
  })

  test('a refusal from the server is shown under the words, and the words are kept', async () => {
    const made = fakeApi()
    made.api.addComment = () => Promise.reject(new Error('Line 11 on the new side of "src/one.ts" is not in the diff of the whole change at f982d895.'))
    const view = render(<Screen host={host()} api={made.api} />)
    await waitFor(() => expect(view.container.querySelector('[data-file="src/one.ts"]')).toBeTruthy())
    await screen.findByRole('region', { name: 'Your review' })
    fireEvent.click(screen.getByRole('button', { name: 'Comment on new line 11 of src/one.ts' }))
    const box = screen.getByLabelText('Comment on new line 11 of src/one.ts', { selector: 'textarea' }) as HTMLTextAreaElement
    fireEvent.change(box, { target: { value: 'A paragraph I do not want to lose.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add to review' }))
    await screen.findByText(/is not in the diff of the whole change/)
    expect(box.value).toBe('A paragraph I do not want to lose.')
  })

  test('an agent’s comment is marked as an agent’s, and removing takes two presses', async () => {
    const { container, calls } = await opened({ comments: [comment({ id: 'c-1', by: 'agent' })] })
    const card = container.querySelector('.diff-inset [data-comment="c-1"]') as HTMLElement
    expect(within(card).getByText('agent')).toBeTruthy()
    fireEvent.click(within(card).getByRole('button', { name: 'Remove' }))
    expect(calls.dropped).toEqual([])
    fireEvent.click(within(card).getByRole('button', { name: 'Remove it?' }))
    await waitFor(() => expect(calls.dropped).toEqual(['c-1']))
    await waitFor(() => expect(container.querySelector('[data-comment="c-1"]')).toBeNull())
  })

  test('a comment an agent adds over MCP appears when the window regains focus', async () => {
    const { container, state } = await opened()
    expect(container.querySelector('[data-comment]')).toBeNull()
    state.draft = { ...state.draft, comments: [comment({ id: 'c-9', by: 'agent', body: 'Added from outside.' })] }
    fireEvent(window, new Event('focus'))
    await waitFor(() => expect(container.querySelector('.diff-inset [data-comment="c-9"]')).toBeTruthy())
  })

  test('a comment written against an older head is not drawn on today’s lines, and is marked in the panel', async () => {
    const older = '2222222222222222222222222222222222222222'
    const { container } = await opened({ comments: [comment({ id: 'c-1', commit: older })] })
    expect(container.querySelector('.diff-inset')).toBeNull()
    const panel = within(screen.getByRole('region', { name: 'Your review' }))
    expect(panel.getByText(/Written against 22222222, an older head: the change has been pushed to since\. It is not moved/)).toBeTruthy()
  })

  test('a sent comment is shown as sent and offers neither edit nor remove', async () => {
    const { container } = await opened({ comments: [comment({ id: 'c-1', sent: { at: AT, url: `${GH_URL}#r1` } })] })
    const card = container.querySelector('.diff-inset [data-comment="c-1"]') as HTMLElement
    expect(card.getAttribute('data-sent')).toBe('yes')
    expect(within(card).getByText('sent')).toBeTruthy()
    expect(within(card).queryByRole('button', { name: 'Edit' })).toBeNull()
    expect(within(card).queryByRole('button', { name: 'Remove' })).toBeNull()
    expect(screen.getByText(/0 draft comments, 1 sent/)).toBeTruthy()
  })
})

describe('sending', () => {
  test('the first press shows exactly what will be posted and posts nothing; the second posts that', async () => {
    const { calls } = await opened({ comments: [comment({ id: 'c-1' }), comment({ id: 'c-2', by: 'agent', line: 12 })], verdict: 'approve', summary: 'Looks right.' })
    fireEvent.click(screen.getByRole('button', { name: 'Send review…' }))
    const confirm = within(await screen.findByTestId('confirm'))
    expect(confirm.getByText('Nothing has been posted yet. This is what will be:')).toBeTruthy()
    expect(confirm.getByText(/2 comments, 1 of them drafted by an agent and posted under your name\./)).toBeTruthy()
    expect(confirm.getByText('A summary of 12 characters.')).toBeTruthy()
    expect(confirm.getByText('Approve')).toBeTruthy()
    await waitFor(() => expect(screen.getByTestId('confirm').textContent).toContain('To o/r#46 on GitHub, through your own gh login — as Jalez.'))
    expect(calls.sent).toEqual([])

    fireEvent.click(confirm.getByRole('button', { name: 'Post it to GitHub' }))
    await waitFor(() => expect(calls.sent).toEqual([{ ids: ['c-1', 'c-2'], verdict: 'approve', summary: 'Looks right.' }]))
    const report = within(await screen.findByTestId('report'))
    expect(report.getByText('Sent.')).toBeTruthy()
    expect(report.getByText('1 comment was posted to GitHub on its line.')).toBeTruthy()
    expect(screen.queryByTestId('confirm')).toBeNull()
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
    await waitFor(() => expect(screen.getByRole('radio', { name: 'Request changes' }).getAttribute('aria-checked')).toBe('true'))
  })

  test('the summary is saved when the box is left, and before a confirmation is shown', async () => {
    const { calls } = await opened({ verdict: 'approve' })
    const summary = screen.getByLabelText(/Summary/) as HTMLTextAreaElement
    fireEvent.change(summary, { target: { value: 'Ship it.' } })
    expect(calls.verdicts).toEqual([])
    fireEvent.click(screen.getByRole('button', { name: 'Send review…' }))
    const confirm = within(await screen.findByTestId('confirm'))
    expect(calls.verdicts).toEqual([[undefined, 'Ship it.']])
    expect(confirm.getByText('A summary of 8 characters.')).toBeTruthy()
    expect(confirm.getByText('0 comments.')).toBeTruthy()
  })

  test('with nothing to send, Send is not offered as a live button', async () => {
    await opened()
    expect((screen.getByRole('button', { name: 'Send review…' }) as HTMLButtonElement).disabled).toBe(true)
  })

  test('a send that is refused shows the tracker’s words and leaves the draft as the server says it is', async () => {
    const made = fakeApi({ comments: [comment({ id: 'c-1' })], verdict: 'approve' })
    made.api.send = () => Promise.reject(new Error('The draft changed after you looked at it, so nothing was sent.'))
    const view = render(<Screen host={host()} api={made.api} />)
    await waitFor(() => expect(view.container.querySelector('[data-file="src/one.ts"]')).toBeTruthy())
    fireEvent.click(await screen.findByRole('button', { name: 'Send review…' }))
    fireEvent.click(within(await screen.findByTestId('confirm')).getByRole('button', { name: 'Post it to GitHub' }))
    await screen.findByText('The draft changed after you looked at it, so nothing was sent.')
    expect(screen.queryByTestId('report')).toBeNull()
    expect(view.container.querySelector('[data-comment="c-1"]')?.getAttribute('data-sent')).toBe('no')
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
    expect(view.querySelector('[data-file="src/one.ts"]')?.closest('[hidden]')).not.toBeNull()
  })

  test('its own server not answering: the down cover over the mounted review, and Try again brings it back', async () => {
    const view = (await opened()).container
    down = true
    await act(async () => void (await realApi.draft('/p', GH_URL).catch(() => {})))
    expect(cover()?.getAttribute('data-cover')).toBe('down')
    expect(cover()?.textContent).toContain('Review’s own server is not answering.')
    /* Hidden, not gone: the diff and anything typed against it are still there. */
    const file = view.querySelector('[data-file="src/one.ts"]')
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
    expect(view.querySelector('[data-file="src/one.ts"]')).toBe(file)
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
