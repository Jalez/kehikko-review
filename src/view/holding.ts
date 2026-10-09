import { createContext, useContext } from 'react'

import type { Draft } from '@/store/held.ts'

/**
 * The words being typed into this change's boxes, held across a reload of the page.
 *
 * `store/held.ts` is the storage; this is how a box three components down reaches it without the
 * project and the change being threaded through every prop. `ChangeReview` provides it, scoped to
 * its project and its change, so a target here is only the rest of the aim: `new:<view>:<commit>:
 * <path>:<side>:<start>:<line>`, `reword:<comment id>`, `summary`.
 *
 * With no provider — a box drawn alone in a test — nothing is held and nothing is restored.
 */
export interface Holding {
  read(target: string): Draft | null
  keep(target: string, draft: Draft | null): void
}

const NOTHING: Holding = { read: () => null, keep: () => {} }

export const HoldingContext = createContext<Holding>(NOTHING)
export const useHolding = (): Holding => useContext(HoldingContext)

/** A held draft counts only if the person changed it: an untouched one loses to whatever the store holds now. */
export const changed = (held: Draft | null): Draft | null => (held && held.text !== held.base && held.text.trim() ? held : null)
