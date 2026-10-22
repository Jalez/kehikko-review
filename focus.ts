import { LIMITS, locationLabel, sharedLocationSchema, type SharedLocation } from 'kehikot-module-protocol'

import type { Target } from './forge/locate.ts'
import { short, spell, urlOf } from './review/shape.ts'

/**
 * What the person is looking at in Review, per project: the change its page has open, and where in
 * that change's code somebody last pointed (`context.location`, protocol 2.13.0). The page reports
 * it (`POST /api/focus`, with its ticket); an agent reads it (`read_focus`), so `/review-pass` with no
 * argument reviews the picked change and `/review-point` writes its point "here".
 *
 * In memory and nowhere else: it is what is on screen now, not a record. A restart forgets it until
 * the page reports again, which it does whenever the change or the location moves.
 */

export interface Focus {
  /** The change's tracker URL. */
  url: string
  /** How the canvas selection spells it: `gh#46`, `!3105`. */
  ref: string
  /** How a person writes it: `owner/repo#46`. */
  change: string
  title: string
  location: SharedLocation | null
  at: string
}

const held = new Map<string, Focus>()
/** A machine has a handful of projects open; past this the oldest is forgotten. */
const MAX_PROJECTS = 50

/** Keep what the page said. A sentence when it is not something a page would say. */
export function keepFocus(projectPath: string, target: Target, body: Record<string, unknown>, now: string): string | null {
  const ref = typeof body.ref === 'string' && body.ref.length > 0 && body.ref.length <= LIMITS.REF ? body.ref : null
  if (!ref) return 'ref is the change as the selection spells it.'
  const title = typeof body.title === 'string' ? body.title.slice(0, 300) : ''
  const location = sharedLocationSchema.nullable().safeParse(body.location ?? null)
  if (!location.success) return 'location is a code location as the host sent it, or null.'
  /* A location in another change than the one on the page is not this page's to report. */
  const stands = location.data && location.data.change === ref ? location.data : null
  held.delete(projectPath)
  held.set(projectPath, { url: urlOf(target), ref, change: spell(target), title, location: stands, at: now })
  while (held.size > MAX_PROJECTS) held.delete(held.keys().next().value!)
  return null
}

export const focusOf = (projectPath: string): Focus | null => held.get(projectPath) ?? null

/** For tests: forget everything. */
export const forgetFocus = (): void => held.clear()

/** The focus as an agent reads it. */
export function printFocus(focus: Focus | null): string {
  if (!focus) {
    return 'Review’s page has not said what it has open in this project (it is not open, or it has not been opened since Review started). Ask the person which change, or give its URL.'
  }
  const lines = [`Review has ${focus.change} open (${focus.ref} on the canvas): ${focus.title ? `${focus.title} — ` : ''}${focus.url}`, `As of ${focus.at}.`]
  const l = focus.location
  if (!l) {
    lines.push('Nobody is pointing at a place in its code.')
  } else {
    lines.push(
      `${l.intent === 'comment' ? 'Somebody asked for a point at' : 'Somebody is pointing at'} ${locationLabel(l)} (${l.side} side${l.commit ? `, at ${short(l.commit)}` : ''})${l.by ? `, from ${l.by}` : ''}${l.at ? ` at ${l.at}` : ''}.`,
      `For add_comment: path "${l.path}", line ${l.endLine ?? l.line}${l.endLine !== undefined && l.endLine !== l.line ? `, start_line ${l.line}` : ''}, side "${l.side}", no commit (a line of the whole change).`,
    )
  }
  return lines.join('\n')
}
