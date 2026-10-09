import { useMemo } from 'react'

import { useHost, type Host as ProtocolHost, type Where } from 'kehikot-module-protocol/client/react'

import { ID } from '../../manifest.ts'

/**
 * What the screen needs from the host, and nothing about how it arrived.
 *
 * A thin wrapper over the protocol's `useHost`, which is the listener, the grace,
 * the theme on <html> and the page that reloads itself when it is older than its
 * server. What is left here is this module's own: the selection held steady, the
 * tracker reading's clock, and a `Host` narrow enough that a screen can be
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
  selection: string[]
  /**
   * When the host's shared tracker reading last changed. It moving is the
   * signal that something asked for earlier may have landed, and later that a
   * change may have been pushed to.
   */
  trackerAt: string | null
  /** Ask the host for something (a method from the protocol). Rejects when unhosted or refused. */
  request: ProtocolHost['request']
}

export function useKehikot(): Host {
  const host = useHost(ID)
  const context = host.context

  /* Joined so that a context repeating the same selection — which a host sends
     after every click anywhere on the canvas — hands the screen the SAME array
     and re-runs nothing that depends on it. */
  const selectionKey = (context?.selection ?? []).join('\n')
  const selection = useMemo(() => (selectionKey ? selectionKey.split('\n') : []), [selectionKey])
  const trackerAt = context?.tracker?.at ?? null

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
    }),
    [host.where, host.request, host.project, host.projectPath, host.epic, host.theme, selection, trackerAt],
  )
}
