import { useMemo, useRef, useState, type MutableRefObject } from 'react'

import type { HeaderItemInput } from 'kehikot-module-protocol'

import { useHost, type Host as ProtocolHost, type Where } from 'kehikot-module-protocol/client/react'

import { ID } from '../../manifest.ts'
import { headerDrawn, rememberHeaderDrawn } from '../header-fallback.tsx'

/** One press on a header item: nothing or `true` for taken, a sentence for not taken, and why. */
export type Press = (press: { item: string; value?: string | boolean }) => string | boolean | void

/**
 * What the screen needs from the host, and nothing about how it arrived.
 *
 * A thin wrapper over the protocol's `useHost`, which is the listener, the grace,
 * the theme on <html> and the page that reloads itself when it is older than its
 * server. What is left here is this module's own: the tracker reading's clock, and a `Host` narrow enough that a screen can be
 * rendered in a test with a plain object.
 *
 * No `onClear` or `onRefresh` is passed. `useHost` would deliver those presses
 * (the older `useKehikot` never did), and this module offers neither: it calls
 * neither `clearable` nor `refreshable`, so a host draws no such button for it
 * and a press that arrived anyway is ignored.
 */
export interface Host {
  /** 'listening' until a host greets or the grace runs out; then 'hosted' or 'unhosted'. */
  where: Where
  project: string | null
  /** The absolute directory of the open project. Where this module keeps its drafts. */
  projectPath: string | null
  epic: string | null
  theme: 'light' | 'dark'
  /**
   * What the canvas has picked out, as the host last said it.
   *
   * Refs and nothing else — `['gh#46']`, `['!3105']`. Never what this page
   * asked for: it declares no `selection:set` and has no control that would
   * make one. What each ref IS has to be asked; see `live/changes.ts`.
   */
  selection: readonly string[]
  /**
   * When the host's shared tracker reading last changed. It moving is the
   * signal that something asked for earlier may have landed, and later that a
   * change may have been pushed to.
   */
  trackerAt: string | null
  /** Ask the host for something (a method from the protocol). Rejects when unhosted or refused. */
  request: ProtocolHost['request']
  /** Declare the header items, whole (`kehikot.header`). Absent in a test that draws no header. */
  header?(items: HeaderItemInput[]): void
  /** Where the page puts what takes a press on one of them. */
  presses?: MutableRefObject<Press | null>
  /** Whether a host has ever pressed one: such a host draws the header, and the page's own control is gone. */
  pressed?: boolean
}

export function useKehikot(): Host {
  const presses = useRef<Press | null>(null)
  const [pressed, setPressed] = useState(headerDrawn)
  const host = useHost(ID, {
    onPress: (press) => {
      rememberHeaderDrawn()
      setPressed(true)
      return presses.current ? presses.current(press) : 'There is no change open here to press on.'
    },
  })
  /* `selection` is the same array for as long as the host repeats the same selection. */
  const { selection } = host
  const trackerAt = host.context?.tracker?.at ?? null

  return useMemo(
    () => ({
      where: host.where,
      project: host.project,
      projectPath: host.projectPath,
      epic: host.epic,
      theme: host.theme,
      selection,
      trackerAt,
      request: host.request,
      header: host.header,
      presses,
      pressed,
    }),
    [host.where, host.request, host.header, pressed, host.project, host.projectPath, host.epic, host.theme, selection, trackerAt],
  )
}
