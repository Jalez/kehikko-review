import { useEffect, useMemo } from 'react'

import { useKehikot as useProtocolKehikot, type Kehikot, type Where } from 'kehikot-module-protocol/client/react'

import { ID } from '../../manifest.ts'

/**
 * What the screen needs from the host, and nothing about how it arrived.
 *
 * A thin wrapper over the protocol's `useKehikot`: it applies the host's theme
 * to <html> and flattens the context into the fields this module reads, so a
 * screen can be rendered in a test with a plain object (see `Host`).
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
  selection: string[]
  /**
   * When the host's shared tracker reading last changed. It moving is the
   * signal that something asked for earlier may have landed, and later that a
   * change may have been pushed to.
   */
  trackerAt: string | null
  /** Ask the host for something (a method from the protocol). Rejects when unhosted or refused. */
  request: Kehikot['request']
}

export function useKehikot(): Host {
  const kehikot = useProtocolKehikot(ID)
  const context = kehikot.context
  const theme = context?.theme ?? 'light'

  useEffect(() => {
    if (!context) return
    const root = document.documentElement
    root.classList.toggle('dark', theme === 'dark')
    root.classList.toggle('light', theme === 'light')
  }, [context, theme])

  /* Joined so that a context repeating the same selection — which a host sends
     after every click anywhere on the canvas — hands the screen the SAME array
     and re-runs nothing that depends on it. */
  const selectionKey = (context?.selection ?? []).join('\n')
  const selection = useMemo(() => (selectionKey ? selectionKey.split('\n') : []), [selectionKey])
  const trackerAt = context?.tracker?.at ?? null

  return useMemo(
    () => ({
      where: kehikot.where,
      project: context?.project ?? null,
      projectPath: context?.projectPath ?? null,
      epic: context?.epic ?? null,
      theme,
      selection,
      trackerAt,
      request: kehikot.request,
    }),
    [kehikot.where, kehikot.request, context?.project, context?.projectPath, context?.epic, theme, selection, trackerAt],
  )
}
