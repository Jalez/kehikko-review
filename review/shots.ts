import type { Target } from '../forge/locate.ts'

/**
 * The Before / after view's pictures: the images a change's author posted in its description and
 * comments, labelled before or after by the words next to them, and paired.
 *
 * Pure, and imported by the page as well as the server: no node, no fetch. What it decides is the
 * whole safety of the view, so it is decided here and tested here.
 *
 * ## Which images are shown
 *
 * Only `https:` images on the forge's OWN hosts: github.com and GitHub's content hosts
 * (`*.githubusercontent.com`), or the GitLab host the change is on (its `/uploads/…` paths made
 * absolute under the project). Anything else — `http:`, `data:`, `javascript:`, another host, an
 * address with a login or a port in it — is not loaded and not linked; it is listed by its host,
 * as text, with why. A picture from somewhere else is a request from the person's browser to
 * whoever put it there, saying they looked.
 *
 * ## How before and after are told apart
 *
 * By words, the way people post them: the alt text (`![Before](…)`) first; otherwise the words
 * "before" and "after" between the previous image and this one (at most `WINDOW` characters back).
 * A header row that names both — `| Before | After |`, or `<th>` cells — labels the images that
 * follow it in that order. Then each before is paired with the nearest unpaired after, in either
 * order. What has no partner is shown alone, never guessed into a pair.
 */

export type Label = 'before' | 'after'

export interface Shot {
  url: string
  alt: string
  label: Label | null
  /** Where it was posted: "the description", "a comment by ada". */
  where: string
}

export interface RefusedShot {
  /** What was written, cut short: shown as text, never as a link. */
  raw: string
  why: string
  where: string
}

export interface Shots {
  pairs: { before: Shot; after: Shot }[]
  single: Shot[]
  refused: RefusedShot[]
  /** More images were posted than are listed. */
  more: boolean
}

/** At most this many images are listed for one change. */
export const MAX_SHOTS = 60
const MAX_URL = 2000
const MAX_ALT = 300
/** How far back from an image its label word may be. */
const WINDOW = 200

export interface Found {
  raw: string
  alt: string
  start: number
  end: number
}

const MARKDOWN = /!\[([^\]\n]{0,500})\]\(\s*<?([^\s)<>]+)>?(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g
const HTML = /<img\b[^>]{0,2000}>/gi
const attribute = (tag: string, name: string): string | null => {
  const m = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag)
  return m ? (m[1] ?? m[2] ?? m[3] ?? '') : null
}

/** Every image in a piece of markdown (which may hold HTML), in the order written. */
export function findImages(text: string): Found[] {
  const found: Found[] = []
  for (const m of text.matchAll(MARKDOWN)) found.push({ raw: m[2] ?? '', alt: (m[1] ?? '').slice(0, MAX_ALT), start: m.index, end: m.index + m[0].length })
  for (const m of text.matchAll(HTML)) {
    const src = attribute(m[0], 'src')
    if (src) found.push({ raw: src, alt: (attribute(m[0], 'alt') ?? '').slice(0, MAX_ALT), start: m.index, end: m.index + m[0].length })
  }
  return found.sort((a, b) => a.start - b.start)
}

/** Whether an image may be shown, and at which address. */
export function allowedImage(raw: string, target: Target): { ok: true; url: string } | { ok: false; why: string } {
  const cut = raw.trim()
  if (cut.length > MAX_URL) return { ok: false, why: 'its address is too long to be one this app shows' }
  const gitlabHost = target.forge === 'gitlab' ? (target.host ?? 'gitlab.com').toLowerCase() : null
  let absolute = cut
  if (cut.startsWith('//')) absolute = `https:${cut}`
  else if (gitlabHost && /^\/?uploads\//.test(cut)) absolute = `https://${gitlabHost}/${target.repo}/${cut.replace(/^\//, '')}`
  else if (gitlabHost && cut.startsWith('/')) absolute = `https://${gitlabHost}${cut}`
  let url: URL
  try {
    url = new URL(absolute)
  } catch {
    return { ok: false, why: 'it is not an https address' }
  }
  if (url.protocol !== 'https:') return { ok: false, why: `it is a ${url.protocol.replace(/:$/, '')} address, and only https images are shown` }
  if (url.username || url.password) return { ok: false, why: 'its address carries a login' }
  if (url.port) return { ok: false, why: 'its address names a port' }
  const host = url.hostname.toLowerCase()
  const own = gitlabHost ? host === gitlabHost : host === 'github.com' || host.endsWith('.githubusercontent.com')
  if (!own) return { ok: false, why: `${host.slice(0, 120)} is not one of ${gitlabHost ? `${gitlabHost}’s` : 'GitHub’s'} own hosts` }
  return { ok: true, url: url.href }
}

const WORD = /\b(before|after)\b/gi

const wordsIn = (text: string): Label[] => [...text.matchAll(WORD)].map((m) => (m[1]!.toLowerCase() === 'before' ? 'before' : 'after'))

/** The images of all the sources, labelled, allowed or refused, and paired. */
export function shotsOf(target: Target, sources: readonly { where: string; text: string }[]): Shots {
  const shown: Shot[] = []
  const refused: RefusedShot[] = []
  let more = false
  for (const source of sources) {
    const found = findImages(source.text)
    let queued: Label[] = []
    let last = 0
    for (const one of found) {
      const between = source.text.slice(Math.max(last, one.start - WINDOW), one.start)
      last = one.end
      const words = wordsIn(between)
      if (words.length) queued = words
      const own = wordsIn(one.alt)
      const label: Label | null = own.length ? own[0]! : (queued.shift() ?? null)
      if (shown.length + refused.length >= MAX_SHOTS) {
        more = true
        continue
      }
      const allowed = allowedImage(one.raw, target)
      if (allowed.ok) shown.push({ url: allowed.url, alt: one.alt, label, where: source.where })
      else refused.push({ raw: one.raw.slice(0, 200), why: allowed.why, where: source.where })
    }
  }

  const pairs: Shots['pairs'] = []
  const open: Shot[] = []
  const single: Shot[] = []
  for (const shot of shown) {
    if (!shot.label) {
      single.push(shot)
      continue
    }
    const partner = open.findIndex((o) => o.label !== shot.label)
    if (partner < 0) {
      open.push(shot)
      continue
    }
    const [other] = open.splice(partner, 1)
    pairs.push(shot.label === 'before' ? { before: shot, after: other! } : { before: other!, after: shot })
  }
  /* Unpaired, in the order they were posted. */
  const alone = [...single, ...open].sort((a, b) => shown.indexOf(a) - shown.indexOf(b))
  return { pairs, single: alone, refused, more }
}
