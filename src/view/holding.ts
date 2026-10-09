import { createContext, useContext } from 'react'

import { held, type Draft, type HeldAt } from 'kehikot-module-protocol/client'

/**
 * The words being typed into this change's boxes, held across a reload of the page.
 *
 * The protocol's `held` is the storage, by project; this is how a box three components down
 * reaches it without the project and the change being threaded through every prop. `ChangeReview`
 * provides it, scoped to its project and its change, so a target here is only the rest of the aim:
 * `new:<view>:<commit>:<side>:<start>:<line>:<path>`, `reword:<comment id>`, `summary`.
 *
 * With no provider — a box drawn alone in a test — nothing is held and nothing is restored.
 */
export const drafts = held('kehikot.review.drafts')

export type Holding = Pick<HeldAt<Draft>, 'read' | 'keep'>

const NOTHING: Holding = { read: () => null, keep: () => {} }

export const HoldingContext = createContext<Holding>(NOTHING)
export const useHolding = (): Holding => useContext(HoldingContext)
