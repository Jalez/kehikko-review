import { LIMITS, type HeaderItemInput } from 'kehikot-module-protocol'

/**
 * What this page declares for the container's header (`kehikot.header`).
 *
 * The host draws these in its View menu, in the row a container already has, so
 * this page spends no row of its own on "the review or the pictures" or on
 * "which change to review". A pure function of what the page knows: a keystroke in a
 * comment changes nothing here, so typing declares nothing.
 *
 * ## Ids
 *
 * The change is `c<n>`, by its place in the selection as the page last drew it.
 * The views are `review` and `shots`. Review draws no diff: Source and Diff do,
 * at the place a point's code reference names.
 */

/** The review itself: the document. */
export const DOCUMENT = 'review'
/** The Before / after view: the change's pictures. */
export const SHOTS = 'shots'

/** A label no longer than a label may be, cut with an ellipsis. Never empty. */
export function cut(text: string, max: number = LIMITS.HEADER_LABEL): string {
  const flat = text.replace(/\s+/g, ' ').trim() || '—'
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat
}

export interface HeaderState {
  /** The selected refs that are changes, when there is more than one to choose between; else empty. */
  changes: readonly string[]
  change: string | null
  /** Points not yet sent. */
  waiting: number
  /** Which view is on: the review, or the Before / after pictures. */
  showing: typeof DOCUMENT | typeof SHOTS
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

  items.push({
    kind: 'switch',
    id: 'showing',
    label: 'Showing',
    icon: 'git-commit-horizontal',
    agents: true,
    value: state.showing,
    options: [
      { id: DOCUMENT, label: cut(`Review${state.waiting ? ` · ${state.waiting} ${state.waiting === 1 ? 'draft point' : 'draft points'}` : ''}`) },
      { id: SHOTS, label: 'Before / after' },
    ],
  })
  return items
}
