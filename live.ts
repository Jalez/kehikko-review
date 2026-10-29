import { createHash } from 'node:crypto'
import { existsSync, realpathSync, watch, type FSWatcher } from 'node:fs'

import { moduleDir } from 'kehikot-module-protocol'
import { events, publish, watching } from 'kehikot-module-protocol/serve'

import { locate } from './forge/locate.ts'
import { ID } from './id.ts'
import { keyOf } from './review/key.ts'

/**
 * Telling the page that a review changed, over one held stream: the page never asks on a clock
 * (protocol 2.32.0, `events`/`subscribe`). What travels is that there IS news; the page reads
 * `/api/draft` again, the door it already reads.
 *
 * News is published where a review changes: every write of one (`changed`, from `changeDraft` in
 * `store.ts` — the page's presses, an agent's MCP tools, Factory's send), and a watcher over the
 * project's `.kehikot/review/` while a page follows the review, for a file somebody edited by hand.
 *
 * The forge is not asked here: `/api/change` reads the tracker when the page asks for it, and the
 * page never asked it on a clock.
 */

export const EVENTS_PATH = '/api/draft/events'

/** The news itself. The page re-reads on any event; the first is sent as a stream opens. */
export const NEWS = { changed: true } as const

/** The project folder as it resolves, so the page's spelling and a write's are one topic. */
function rootOf(projectPath: string): string {
  try {
    return realpathSync(projectPath.trim())
  } catch {
    return projectPath.trim()
  }
}

/** One topic per project and review, hashed: a topic is at most 512 characters, a project path is not. */
export const topicOf = (projectPath: string, key: string): string =>
  `draft:${createHash('sha256').update(`${rootOf(projectPath)}\0${key}`).digest('hex')}`

/* A write, then the watcher seeing that write, is one piece of news. */
const SETTLE_MS = 50
const settling = new Map<string, ReturnType<typeof setTimeout>>()

function tell(topic: string): void {
  if (settling.has(topic) || watching(topic) === 0) return
  settling.set(
    topic,
    setTimeout(() => {
      settling.delete(topic)
      publish(topic, NEWS)
    }, SETTLE_MS),
  )
}

/** Say that the review `key` in `projectPath` changed. Nothing is sent when no page follows it. */
export function changed(projectPath: string, key: string): void {
  const topic = topicOf(projectPath, key)
  /* The first write makes the folder: a page that opened before it existed is watched from now on. */
  if (watching(topic) > 0) watchReview(topic, projectPath, key)
  tell(topic)
}

const watchers = new Map<string, FSWatcher>()

/**
 * Watch the project's review folder for one review while a page follows it. A watcher whose topic
 * nobody follows any more is closed at its next event; one for a folder that does not exist yet is
 * made at the first write through this server, which makes the folder (and publishes by itself).
 */
function watchReview(topic: string, projectPath: string, key: string): void {
  if (watchers.has(topic)) return
  const root = rootOf(projectPath)
  const folder = moduleDir(root, ID)
  if (!folder || !existsSync(folder)) return
  const names = new Set([`${key}.md`, `${key}.json`])
  try {
    const watcher = watch(folder, { persistent: false }, (_event, name) => {
      if (watching(topic) === 0) {
        watcher.close()
        watchers.delete(topic)
        return
      }
      /* Some platforms name nothing; then any change in the folder is worth one read. */
      if (typeof name === 'string' && !names.has(name)) return
      tell(topic)
    })
    watcher.on('error', () => {
      watcher.close()
      watchers.delete(topic)
    })
    watchers.set(topic, watcher)
  } catch {
    /* A folder that cannot be watched: writes through this server still publish. */
  }
}

/** Stop every watcher (tests, and a server that stops). */
export function stopWatching(): void {
  for (const watcher of watchers.values()) watcher.close()
  watchers.clear()
  for (const timer of settling.values()) clearTimeout(timer)
  settling.clear()
}

/** How many watchers are open, for tests. */
export const watcherCount = (): number => watchers.size

/** The doors' `stream` option: `/api/draft/events?projectPath=…&url=…`. Ungated, as the read it stands for is. */
export const stream = events((path, query) => {
  if (path !== EVENTS_PATH) return null
  const url = query.get('url')
  const target = locate(url && url.length <= 600 ? url : null)
  const projectPath = query.get('projectPath')?.trim()
  if (!target || !projectPath) return null
  const key = keyOf(target)
  const topic = topicOf(projectPath, key)
  watchReview(topic, projectPath, key)
  return { topic, initial: NEWS }
})
