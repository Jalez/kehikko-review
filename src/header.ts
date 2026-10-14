import { LIMITS, type HeaderItemInput } from 'kehikot-module-protocol'

import { short } from '../review/shape.ts'

/**
 * What this page declares for the container's header (`kehikot.header`).
 *
 * The host draws these in its View menu, in the row a container already has, so
 * this page spends no row of its own on "which changes to show" or on "which
 * change to review". A pure function of what the page knows: a keystroke in a
 * comment changes nothing here, so typing declares nothing.
 *
 * ## Ids
 *
 * The change is `c<n>`, by its place in the selection as the page last drew it.
 * A commit is its own sha, and the whole change is `all`: a sha is stable while
 * the list of commits moves under it, which a position would not be.
 */

export const ALL = 'all'

/** A label no longer than a label may be, cut with an ellipsis. Never empty. */
export function cut(text: string, max: number = LIMITS.HEADER_LABEL): string {
  const flat = text.replace(/\s+/g, ' ').trim() || '—'
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat
}

const counted = (n: number): string => (n ? ` · ${n} ${n === 1 ? 'comment' : 'comments'}` : '')

export interface HeaderCommit {
  sha: string
  title: string
  /** Draft comments waiting in this commit's view. */
  waiting: number
}

export interface HeaderState {
  /** The selected refs that are changes, when there is more than one to choose between; else empty. */
  changes: readonly string[]
  change: string | null
  commits: readonly HeaderCommit[]
  /** Draft comments waiting in the whole-change view. */
  waitingAll: number
  /** Which view is on: `all` or a commit's sha. */
  showing: string
  /** The forge listed more commits than are kept. */
  more: boolean
}

export function headerOf(state: HeaderState): HeaderItemInput[] {
  const items: HeaderItemInput[] = []

  if (state.changes.length > 1 && state.changes.length <= LIMITS.HEADER_OPTIONS && state.change !== null) {
    const on = state.changes.indexOf(state.change)
    if (on >= 0) {
      items.push({
        kind: 'switch',
        id: 'change',
        label: 'Change under review',
        icon: 'git-pull-request',
        agents: true,
        value: `c${on}`,
        options: state.changes.map((ref, at) => ({ id: `c${at}`, label: cut(ref) })),
      })
    }
  }

  /* As many as a switch may hold: the newest commits, and the picked one wherever it is. */
  const room = LIMITS.HEADER_OPTIONS - 1
  let commits = state.commits.slice(-room)
  const picked = state.commits.find((one) => one.sha === state.showing)
  if (picked && !commits.includes(picked)) commits = [picked, ...commits.slice(1)]
  items.push({
    kind: 'switch',
    id: 'showing',
    label: state.more || state.commits.length > room ? 'Showing · not every commit is listed' : 'Showing',
    icon: 'git-commit-horizontal',
    agents: true,
    value: state.showing === ALL || commits.some((one) => one.sha === state.showing) ? state.showing : ALL,
    options: [
      { id: ALL, label: cut(`All changes${counted(state.waitingAll)}`) },
      ...commits.map((one) => ({ id: one.sha, label: cut(`${short(one.sha)} ${one.title}${counted(one.waiting)}`) })),
    ],
  })
  return items
}
