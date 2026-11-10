import { footerOf } from '@/footer'
import { DOCUMENT, SHOTS, headerOf } from '@/header'

/**
 * The rows Review declares to a host that draws a header and a footer, one state per moment worth
 * checking, for `kehikot-check-rows` (protocol 2.70.0). Built from the real header and footer
 * functions, so `kehikot.rows.json` (written by `bun run rows`, held equal to this by
 * `test/rows.test.ts`) cannot drift from what the page sends.
 *
 * The header sets the module up (which change, which view); the footer says where the review stands
 * (the change's state and head, the points waiting and sent, the verdict).
 */

const HEAD = 'a'.repeat(40)
const ok = { at: 'ok' as const, state: 'open', draft: false, head: HEAD, title: 'feat: an official module list', author: 'jalez' }

export function rowsStates() {
  return [
    {
      name: 'a change, its review drafted',
      header: headerOf({ changes: [], change: 'gh#46', waiting: 2, showing: DOCUMENT, footed: true }),
      footer: footerOf({ refName: 'gh#46', tracker: 'GitHub', change: ok, review: { waiting: 2, sent: 1, verdict: 'request-changes' } }),
      state: true,
    },
    {
      name: 'two changes selected, the pictures shown',
      header: headerOf({ changes: ['gh#46', 'gh#47'], change: 'gh#47', waiting: 0, showing: SHOTS, footed: true }),
      footer: footerOf({ refName: 'gh#47', tracker: 'GitHub', change: { ...ok, draft: true }, review: { waiting: 0, sent: 0, verdict: null } }),
      state: true,
    },
    {
      name: 'the change being asked for',
      header: [],
      footer: footerOf({ refName: '!3105', tracker: 'GitLab', change: { at: 'loading' }, review: null }),
      state: true,
    },
    {
      name: 'the tracker failed',
      header: [],
      footer: footerOf({ refName: 'gh#46', tracker: 'GitHub', change: { at: 'error', error: 'GitHub did not answer.' }, review: null }),
      state: true,
    },
    { name: 'nothing selected', header: [], footer: [] },
  ]
}
