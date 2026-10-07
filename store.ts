import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { isAbsolute } from 'node:path'

import { DATA_FILE, kehikotDir, moduleDir, moduleFile, within } from 'kehikot-module-protocol'

import type { Target } from './forge/locate.ts'
import { ID } from './manifest.ts'
import { emptyDraft, readDraft, type Changed } from './review/draft.ts'
import { keyOf } from './review/key.ts'
import { changeOf, targetOf, type Draft } from './review/shape.ts'

/**
 * Draft reviews, kept inside the project they were written in:
 * `<projectPath>/.kehikot/review/<key>.json`, one file per change.
 *
 * One file per change rather than one file of everything, because a draft is
 * written by two hands at once — a person on the page and an agent over MCP —
 * and two reviews of two changes should never be able to lose each other's
 * writes by sharing a file.
 *
 * The folder and the join are the protocol's (`moduleFile`), so every module
 * agrees on where data lives. There is no default project: with no projectPath
 * every read is refused and so is every write, because a guessed folder is one
 * where work is written and never seen again.
 *
 * Both sides are realpath'd before the containment check, so a `.kehikot` that
 * is a symlink out of the project is refused rather than followed.
 */

export type Result<T> = { ok: true; value: T } | { ok: false; error: string }

const NO_PROJECT =
  'Nothing has said which project this is, so there is nowhere to keep a draft. Open a project in the host, '
  + 'or send projectPath.'

/** How many drafts one project's listing reads. A folder with more than this was not written by this app alone. */
const MAX_DRAFTS = 200

/** A draft file is small; past this it is not one this app wrote, and it is not parsed. */
const MAX_FILE_BYTES = 4_000_000

/** The draft for one change, or a fresh empty one when nothing has been written yet. */
export function readDraftFor(projectPath: string | null | undefined, target: Target): Result<Draft> {
  const file = fileFor(projectPath, keyOf(target), false)
  if (!file.ok) return file
  if (!existsSync(file.value)) return { ok: true, value: emptyDraft(changeOf(target)) }
  const parsed = parseFile(file.value)
  if (!parsed) {
    return { ok: false, error: `${file.value} is not a draft this app can read. Nothing was changed; fix or remove the file.` }
  }
  /* The file is trusted about its comments and never about its address.
     `readDraft` has already re-derived `change` from the file's own URL; if
     that is not the change that was asked about, the file is in the wrong
     place, and using it would post one change's comments on another. */
  if (keyOf(targetOf(parsed.change)) !== keyOf(target)) {
    return { ok: false, error: `${file.value} holds a draft for a different change than its name says. Nothing was changed; fix or remove the file.` }
  }
  return { ok: true, value: parsed }
}

/**
 * Read a draft, change it, and write it back — in one synchronous step.
 *
 * Synchronous on purpose. The page and an agent write to the same draft, and
 * this server is one thread: with no `await` between the read and the rename,
 * no second write can land in the middle, so neither hand can overwrite what
 * the other just added. Anything slow (fetching a diff to check an anchor,
 * posting to a tracker) happens BEFORE or AFTER a call to this, never inside.
 *
 * A change that is refused writes nothing.
 */
export function changeDraft(projectPath: string | null | undefined, target: Target, change: (draft: Draft) => Changed): Result<Draft> {
  const was = readDraftFor(projectPath, target)
  if (!was.ok) return was
  const next = change(was.value)
  if (!next.ok) return next
  const file = fileFor(projectPath, keyOf(target), true)
  if (!file.ok) return file
  /* Written to a temporary file and renamed, so a crash never leaves half a
     draft where a whole one was. */
  const temporary = `${file.value}.${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify(next.draft, null, 2)}\n`)
  renameSync(temporary, file.value)
  return { ok: true, value: next.draft }
}

/** Every draft in the project, for an agent asking what there is. Unreadable files are skipped, not fatal. */
export function listDrafts(projectPath: string | null | undefined): Result<Draft[]> {
  const root = projectRoot(projectPath)
  if (!root.ok) return root
  const dir = moduleDir(root.value, ID)!
  const escaped = escapesAny(root.value, [kehikotDir(root.value)!, dir])
  if (escaped) return { ok: false, error: escaped }
  if (!existsSync(dir)) return { ok: true, value: [] }
  const drafts: Draft[] = []
  for (const name of readdirSync(dir).sort()) {
    if (drafts.length >= MAX_DRAFTS) break
    if (!name.endsWith('.json')) continue
    const key = name.slice(0, -'.json'.length)
    /* Only names this app could have written. `moduleFile` throws on anything
       else, and a stray file in the folder is not a reason to fail a listing. */
    if (!DATA_FILE.test(key)) continue
    const file = moduleFile(root.value, ID, key)!
    if (escapes(root.value, file)) continue
    const parsed = parseFile(file)
    if (parsed && keyOf(targetOf(parsed.change)) === key) drafts.push(parsed)
  }
  return { ok: true, value: drafts }
}

function parseFile(file: string): Draft | null {
  try {
    if (statSync(file).size > MAX_FILE_BYTES) return null
    return readDraft(JSON.parse(readFileSync(file, 'utf8')))
  } catch {
    return null
  }
}

/** The data file's path, checked to resolve inside the project. `make` creates the folder first. */
function fileFor(projectPath: string | null | undefined, key: string, make: boolean): Result<string> {
  const root = projectRoot(projectPath)
  if (!root.ok) return root

  const dir = moduleDir(root.value, ID)!
  const levels = [kehikotDir(root.value)!, dir]
  /* Checked before making anything, so a folder that escapes is never written
     into, and again after, for what mkdir just made. */
  const escaped = escapesAny(root.value, levels)
  if (escaped) return { ok: false, error: escaped }
  if (make) {
    mkdirSync(dir, { recursive: true })
    const after = escapesAny(root.value, levels)
    if (after) return { ok: false, error: after }
  }
  const file = moduleFile(root.value, ID, key)!
  if (existsSync(file)) {
    const escaped = escapes(root.value, file)
    if (escaped) return { ok: false, error: escaped }
  }
  return { ok: true, value: file }
}

function projectRoot(projectPath: string | null | undefined): Result<string> {
  const raw = typeof projectPath === 'string' ? projectPath.trim() : ''
  if (!raw) return { ok: false, error: NO_PROJECT }
  if (!isAbsolute(raw)) return { ok: false, error: `"${raw.slice(0, 300)}" is not an absolute path.` }
  try {
    const real = realpathSync(raw)
    if (!statSync(real).isDirectory()) return { ok: false, error: `"${raw.slice(0, 300)}" is not a folder.` }
    return { ok: true, value: real }
  } catch {
    return { ok: false, error: `there is no folder at "${raw.slice(0, 300)}" on this machine.` }
  }
}

function escapesAny(root: string, paths: string[]): string | null {
  for (const path of paths) {
    if (!existsSync(path)) continue
    const escaped = escapes(root, path)
    if (escaped) return escaped
  }
  return null
}

function escapes(root: string, child: string): string | null {
  let real: string
  try {
    real = realpathSync(child)
  } catch {
    return `${child} could not be resolved, so nothing is read or written through it.`
  }
  return within(root, real) ? null : `${child} resolves to ${real}, outside the project. Refused rather than followed.`
}
