/**
 * What this page holds across a reload of itself, and nothing longer: the words somebody was in the
 * middle of typing, each with what it was aimed at.
 *
 * To be replaced by one shared protocol helper; until then this file is the same in every module that
 * has it (kehikko-orchestrator's `src/store/held.ts` is the pattern), apart from `PREFIX`.
 *
 * ## Why there is any of this
 *
 * A page that is older than its server reloads itself (see the protocol's `reloadWhenStale`) — on
 * the Save press that found it out, or on a read that did, with a box half typed. Vite's client
 * reloads it when the dev server comes back, and a person presses reload. None of those can be
 * caught, so what must survive is written AS IT CHANGES, synchronously, and a reload finds it
 * already there.
 *
 * ## Why `sessionStorage`
 *
 * It lives exactly as long as the tab: a reload of this frame or of the whole host keeps it, closing
 * the tab ends it. It needs a real origin, which this page has because the manifest declares
 * `storage: true`. Where there is none every access throws; each one is caught and the page behaves
 * as it did before this file existed. Nothing here is sent anywhere.
 *
 * ## The scope
 *
 * Keyed by the project the host says is open ('' when it says none), and inside that by `target`:
 * a string naming exactly what the words were aimed at. A draft is only ever given back for the
 * target it was kept under, so it cannot land on a different one. `base` is what was there when the
 * typing started, which is how a caller tells "the person changed this" from "this is just what was
 * loaded", and "the server still holds what I started from" from "somebody has written since".
 */
const PREFIX = 'kehikot.review'

/** Words somebody typed and has not saved. */
export interface Draft {
  /** What was there when the typing started ('' for something new). */
  base: string
  /** What is in the box. Several fields are one JSON string here; the caller knows its own shape. */
  text: string
  /** What it was aimed at, in words a person can read — for when the target is no longer there to show it under. */
  aim: string
}

const key = (project: string | null) => `${PREFIX}.drafts:${project ?? ''}`

/** Every draft held for this project, by target. Never throws; `{}` when there is nothing or no storage. */
export function readDrafts(project: string | null): Record<string, Draft> {
  try {
    const raw = sessionStorage.getItem(key(project))
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: Record<string, Draft> = {}
    for (const [target, one] of Object.entries(parsed as Record<string, unknown>)) {
      const held = one as Partial<Draft> | null
      if (!held || typeof held.text !== 'string' || typeof held.base !== 'string') continue
      out[target] = { base: held.base, text: held.text, aim: typeof held.aim === 'string' ? held.aim : '' }
    }
    return out
  } catch {
    return {}
  }
}

export function readDraft(project: string | null, target: string): Draft | null {
  const all = readDrafts(project)
  return Object.hasOwn(all, target) ? (all[target] ?? null) : null
}

/** `null` forgets it: the words were saved, emptied, put back as they were, or thrown away on purpose. */
export function keepDraft(project: string | null, target: string, draft: Draft | null): void {
  try {
    const all = readDrafts(project)
    if (draft === null) delete all[target]
    else all[target] = draft
    if (Object.keys(all).length) sessionStorage.setItem(key(project), JSON.stringify(all))
    else sessionStorage.removeItem(key(project))
  } catch {
    /* No storage here. The words hold until the next reload, as they always did. */
  }
}
