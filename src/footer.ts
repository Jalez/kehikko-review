import { LIMITS, footerItemsSchema, type FooterItem } from 'kehikot-module-protocol'

import { short, type Verdict } from '../review/shape.ts'

/**
 * Review's footer, in a host that draws one (`kehikot.footer`, protocol 2.38.0): where the review
 * stands now, so a container folded to its header and footer still says it. The header keeps what
 * is a choice (which change, which view); the count of draft points left the View switch's label
 * for here, because it is a readout, not a setting. Nothing in the footer is pressable.
 *
 * - the change: its ref, its state on the tracker, a draft, the head commit; its title and author in
 *   the tooltip. While it is asked for, that; when the tracker failed, its words;
 * - the review: draft points not yet sent, and points sent;
 * - the verdict, once one is set.
 *
 * Pure: the page declares it only when the greeting said the host draws it.
 */
export interface FooterState {
  refName: string
  tracker: string
  change:
    | { at: 'loading' }
    | { at: 'error'; error: string }
    | { at: 'ok'; state: string; draft: boolean; head: string; title: string; author: string | null }
  /** The review, once read: its points not yet sent and sent, and its verdict. */
  review: { waiting: number; sent: number; verdict: Verdict | null } | null
}

const VERDICT: Record<Verdict, string> = { approve: 'Approve', 'request-changes': 'Request changes', comment: 'Comment' }

const cut = (text: string, most: number) => (text.length > most ? `${text.slice(0, most - 1)}…` : text)
const points = (n: number) => (n === 1 ? '1 draft point' : `${n} draft points`)

export function footerOf({ refName, tracker, change, review }: FooterState): FooterItem[] {
  const items: unknown[] = []
  if (change.at === 'loading') items.push({ kind: 'text', id: 'change', text: cut(`Asking ${tracker} about ${refName}…`, LIMITS.FOOTER_TEXT) })
  else if (change.at === 'error') {
    items.push({ kind: 'text', id: 'change', text: cut(`${refName}: ${change.error}`, LIMITS.FOOTER_TEXT), level: 'critical', tooltip: cut(change.error, LIMITS.FOOTER_TOOLTIP) })
  } else {
    const tip = `${refName}${change.title ? ` ${change.title}` : ''}${change.author ? `, by ${change.author}` : ''}. Head ${change.head}.`
    items.push({
      kind: 'text',
      id: 'change',
      text: cut(`${refName} · ${change.state}${change.draft ? ' · draft' : ''} · ${short(change.head)}`, LIMITS.FOOTER_TEXT),
      tooltip: cut(tip, LIMITS.FOOTER_TOOLTIP),
    })
  }
  if (review) {
    const said = review.waiting ? points(review.waiting) : 'No draft points'
    items.push({
      kind: 'text',
      id: 'points',
      text: `${said}${review.sent ? ` · ${review.sent} sent` : ''}`,
      align: 'center',
      tooltip: `${review.waiting ? `${points(review.waiting)} not sent yet` : 'Nothing waiting to be sent'}${review.sent ? `; ${review.sent} sent to ${tracker}` : ''}.`,
    })
    if (review.verdict) items.push({ kind: 'text', id: 'verdict', text: `Verdict: ${VERDICT[review.verdict]}`, align: 'end', optional: true })
  }
  return footerItemsSchema.parse(items)
}
