import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

import { DATA_FILE, kehikotDir, moduleDir, moduleFile, within } from 'kehikot-module-protocol'

import type { Target } from './forge/locate.ts'
import { ID } from './manifest.ts'
import { emptyDraft, readDraft, type Changed } from './review/draft.ts'
import { keyOf } from './review/key.ts'
import { readReview, sameReview, writeReview } from './review/md.ts'
import { PROOF_FILE, changeOf, targetOf, type Draft } from './review/shape.ts'

/**
 * Reviews, kept inside the project they were written in, one per change:
 *
 *   <project>/.kehikot/review/<key>.md     the review: summary, points, evidence, replies, sends
 *   <project>/.kehikot/review/<key>/       its evidence files (screenshots, logs, test output)
 *
 * The Markdown file is the source of truth (`review/md.ts` writes it and reads it back strictly).
 *
 * One file per change rather than one file of everything, because a review is written by two hands
 * at once — a person on the page and an agent over MCP — and two reviews of two changes should never
 * be able to lose each other's writes by sharing a file.
 *
 * ## The JSON drafts from before 1.1.0
 *
 * A `<key>.json` with no `<key>.md` beside it is moved over the first time it is read: read as
 * before, written as Markdown, read back, and compared. Only when the two say exactly the same is
 * the JSON renamed to `<key>.json.bak` (kept, for whoever wants to check; nothing reads it again).
 * If they differ, no Markdown is left behind and the JSON stays where it was.
 *
 * The folder and the join are the protocol's (`moduleDir`, `moduleFile`), so every module agrees on
 * where data lives. There is no default project: with no projectPath every read is refused and so is
 * every write, because a guessed folder is one where work is written and never seen again.
 *
 * Both sides are realpath'd before the containment check, so a `.kehikot` that is a symlink out of
 * the project is refused rather than followed.
 */

export type Result<T> = { ok: true; value: T } | { ok: false; error: string }

const NO_PROJECT =
  'Nothing has said which project this is, so there is nowhere to keep a review. Open a project in the host, '
  + 'or send projectPath.'

/** How many reviews one project's listing reads. A folder with more than this was not written by this app alone. */
const MAX_DRAFTS = 200

/** A review file is small; past this it is not one this app wrote, and it is not parsed. */
const MAX_FILE_BYTES = 4_000_000

interface Files {
  root: string
  key: string
  /** The review: `<key>.md`. */
  md: string
  /** The JSON draft of before 1.1.0: `<key>.json`. */
  json: string
  /** Its evidence folder: `<key>/`. */
  folder: string
}

/** The review for one change, or a fresh empty one when nothing has been written yet. */
export function readDraftFor(projectPath: string | null | undefined, target: Target): Result<Draft> {
  const files = filesFor(projectPath, keyOf(target), false)
  if (!files.ok) return files
  const { md, json } = files.value
  if (!existsSync(md)) {
    if (existsSync(json)) return migrate(files.value, target)
    return { ok: true, value: emptyDraft(changeOf(target)) }
  }
  const parsed = parseFile(md)
  if (!parsed.ok) return { ok: false, error: `${md} is not a review this app can read (${parsed.error}). Nothing was changed; fix or remove the file.` }
  /* The file is trusted about its points and never about its address. `readReview` has already
     re-derived `change` from the file's own URL; if that is not the change that was asked about, the
     file is in the wrong place, and using it would post one change's comments on another. */
  if (keyOf(targetOf(parsed.value.change)) !== keyOf(target)) {
    return { ok: false, error: `${md} holds a review of a different change than its name says. Nothing was changed; fix or remove the file.` }
  }
  return parsed
}

/**
 * Read a review, change it, and write it back — in one synchronous step.
 *
 * Synchronous on purpose. The page and an agent write to the same review, and this server is one
 * thread: with no `await` between the read and the rename, no second write can land in the middle,
 * so neither hand can overwrite what the other just added. Anything slow (fetching a diff to check
 * an anchor, posting to a tracker) happens BEFORE or AFTER a call to this, never inside.
 *
 * A change that is refused writes nothing. Evidence files a change names in `gone` are deleted once
 * the review that no longer names them is on disk.
 */
export function changeDraft(
  projectPath: string | null | undefined,
  target: Target,
  change: (draft: Draft) => Changed & { gone?: string[] },
): Result<Draft> {
  const was = readDraftFor(projectPath, target)
  if (!was.ok) return was
  const next = change(was.value)
  if (!next.ok) return next
  const files = filesFor(projectPath, keyOf(target), true)
  if (!files.ok) return files
  writeAtomically(files.value.md, writeReview(next.draft, files.value.key))
  for (const file of next.gone ?? []) forgetProofFile(files.value, file)
  return { ok: true, value: next.draft }
}

/** The review's Markdown as it is on disk (null when nothing has been written), for an agent that wants it whole. */
export function reviewText(projectPath: string | null | undefined, target: Target): Result<{ file: string; text: string | null }> {
  const read = readDraftFor(projectPath, target)
  if (!read.ok) return read
  const files = filesFor(projectPath, keyOf(target), false)
  if (!files.ok) return files
  return { ok: true, value: { file: files.value.md, text: existsSync(files.value.md) ? readFileSync(files.value.md, 'utf8') : null } }
}

/** Every review in the project, for an agent asking what there is. Unreadable files are skipped, not fatal. */
export function listDrafts(projectPath: string | null | undefined): Result<Draft[]> {
  const root = projectRoot(projectPath)
  if (!root.ok) return root
  const dir = moduleDir(root.value, ID)!
  const escaped = escapesAny(root.value, [kehikotDir(root.value)!, dir])
  if (escaped) return { ok: false, error: escaped }
  if (!existsSync(dir)) return { ok: true, value: [] }
  const keys = new Set<string>()
  for (const name of readdirSync(dir).sort()) {
    const key = /^(.+)\.(md|json)$/.exec(name)?.[1]
    /* Only names this app could have written: a stray file in the folder is not a reason to fail a listing. */
    if (key && DATA_FILE.test(key)) keys.add(key)
  }
  const drafts: Draft[] = []
  for (const key of keys) {
    if (drafts.length >= MAX_DRAFTS) break
    const files = filesFor(root.value, key, false)
    if (!files.ok) continue
    let read: Result<Draft>
    if (existsSync(files.value.md)) {
      if (escapes(root.value, files.value.md)) continue
      read = parseFile(files.value.md)
    } else {
      const old = parseJson(files.value.json)
      if (!old) continue
      read = migrate(files.value, targetOf(old.change))
    }
    if (read.ok && keyOf(targetOf(read.value.change)) === key) drafts.push(read.value)
  }
  return { ok: true, value: drafts }
}

/* ------------------------------------------------------------------ *
 * Evidence files
 * ------------------------------------------------------------------ */

/**
 * Write one evidence file into the review's folder, under the name this module made
 * (`e-<12 hex>.<ext>`). The review itself is changed afterwards, by `changeDraft`; if that is
 * refused, `forgetProof` takes the file away again.
 */
export function keepProofFile(projectPath: string | null | undefined, target: Target, file: string, bytes: Uint8Array): Result<string> {
  if (!PROOF_FILE.test(file)) return { ok: false, error: 'not a name this app gives evidence' }
  const files = filesFor(projectPath, keyOf(target), true)
  if (!files.ok) return files
  const folder = files.value.folder
  if (existsSync(folder)) {
    const out = escapes(files.value.root, folder)
    if (out) return { ok: false, error: out }
  }
  mkdirSync(folder, { recursive: true })
  const after = escapes(files.value.root, folder)
  if (after) return { ok: false, error: after }
  const path = join(folder, file)
  if (existsSync(path)) return { ok: false, error: `${file} is already there.` }
  writeAtomically(path, bytes)
  return { ok: true, value: file }
}

export function forgetProof(projectPath: string | null | undefined, target: Target, file: string): void {
  const files = filesFor(projectPath, keyOf(target), false)
  if (files.ok) forgetProofFile(files.value, file)
}

/** An evidence file's bytes, read from inside the review's folder and nowhere else. */
export function readProofFile(projectPath: string | null | undefined, target: Target, file: string): Result<Uint8Array> {
  if (!PROOF_FILE.test(file)) return { ok: false, error: 'not a name this app gives evidence' }
  const files = filesFor(projectPath, keyOf(target), false)
  if (!files.ok) return files
  const path = join(files.value.folder, file)
  if (!existsSync(path)) return { ok: false, error: `The file of that evidence, ${file}, is not in ${files.value.folder} any more.` }
  const escaped = escapes(files.value.root, path)
  if (escaped) return { ok: false, error: escaped }
  if (!lstatSync(path).isFile()) return { ok: false, error: `${file} is not a plain file.` }
  return { ok: true, value: new Uint8Array(readFileSync(path)) }
}

function forgetProofFile(files: Files, file: string): void {
  if (!PROOF_FILE.test(file)) return
  const path = join(files.folder, file)
  if (!existsSync(path) || escapes(files.root, path) || !lstatSync(path).isFile()) return
  rmSync(path, { force: true })
}

/* ------------------------------------------------------------------ *
 * Inside
 * ------------------------------------------------------------------ */

/** Written to a temporary file and renamed, so a crash never leaves half a file where a whole one was. */
function writeAtomically(path: string, data: string | Uint8Array): void {
  const temporary = `${path}.${process.pid}.tmp`
  writeFileSync(temporary, data)
  renameSync(temporary, path)
}

/** A JSON draft moved into Markdown, verified, and only then set aside as `<key>.json.bak`. */
function migrate(files: Files, target: Target): Result<Draft> {
  const old = parseJson(files.json)
  if (!old) return { ok: false, error: `${files.json} is not a draft this app can read. Nothing was changed; fix or remove the file.` }
  if (keyOf(targetOf(old.change)) !== keyOf(target)) {
    return { ok: false, error: `${files.json} holds a draft for a different change than its name says. Nothing was changed; fix or remove the file.` }
  }
  const text = writeReview(old, files.key)
  const back = readReview(text)
  if (!back.ok || !sameReview(back.draft, old)) {
    return {
      ok: false,
      error: `${files.json} could not be moved into a review file without changing what it says${back.ok ? '' : ` (${back.error})`}. It was left as it is.`,
    }
  }
  writeAtomically(files.md, text)
  /* Read back from disk too: what is on disk is what the next read sees. */
  const onDisk = parseFile(files.md)
  if (!onDisk.ok || !sameReview(onDisk.value, old)) {
    rmSync(files.md, { force: true })
    return { ok: false, error: `${files.json} could not be moved into a review file: what was written did not read back the same. It was left as it is.` }
  }
  renameSync(files.json, `${files.json}.bak`)
  return onDisk
}

function parseJson(file: string): Draft | null {
  try {
    if (statSync(file).size > MAX_FILE_BYTES) return null
    return readDraft(JSON.parse(readFileSync(file, 'utf8')))
  } catch {
    return null
  }
}

function parseFile(file: string): Result<Draft> {
  try {
    if (statSync(file).size > MAX_FILE_BYTES) return { ok: false, error: 'it is larger than any review this app writes' }
    const read = readReview(readFileSync(file, 'utf8'))
    return read.ok ? { ok: true, value: read.draft } : read
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/** A review's paths, checked to resolve inside the project. `make` creates the module's folder first. */
function filesFor(projectPath: string | null | undefined, key: string, make: boolean): Result<Files> {
  const root = projectRoot(projectPath)
  if (!root.ok) return root

  const dir = moduleDir(root.value, ID)!
  const levels = [kehikotDir(root.value)!, dir]
  /* Checked before making anything, so a folder that escapes is never written into, and again
     after, for what mkdir just made. */
  const escaped = escapesAny(root.value, levels)
  if (escaped) return { ok: false, error: escaped }
  if (make) {
    mkdirSync(dir, { recursive: true })
    const after = escapesAny(root.value, levels)
    if (after) return { ok: false, error: after }
  }
  /* `moduleFile` checks the name; the review and its folder are spelled from what it returns. */
  const json = moduleFile(root.value, ID, key)!
  const base = json.slice(0, -'.json'.length)
  const files: Files = { root: root.value, key, md: `${base}.md`, json, folder: base }
  for (const path of [files.md, files.json]) {
    if (existsSync(path)) {
      const out = escapes(root.value, path)
      if (out) return { ok: false, error: out }
    }
  }
  return { ok: true, value: files }
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
