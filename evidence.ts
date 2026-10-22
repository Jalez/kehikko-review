import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute } from 'node:path'

import { within } from 'kehikot-module-protocol'

import { MAX_LOG_BYTES, MAX_PICTURE_BYTES, type ProofExtension, type ProofKind } from './review/shape.ts'

/**
 * What a piece of evidence may be, before it is kept beside a review.
 *
 * - A **screenshot** is a PNG, JPEG, GIF or WebP, judged by its first bytes and never by its name,
 *   at most 10 MB. SVG is not a picture here: it is a document that can run script.
 * - A **log** or **test output** is UTF-8 text with no NUL, at most 1 MB.
 *
 * An agent hands either the file's absolute `path` or, for text, the `text` itself. A path is read
 * only from inside the project or the system's temporary folder: evidence is something a run
 * produced, and this door is not a way to copy any file on the machine into a project.
 */

export type Taken = { ok: true; bytes: Uint8Array; extension: ProofExtension } | { ok: false; error: string }

/** The picture format of these bytes, by their magic number, or null. */
export function pictureType(bytes: Uint8Array): 'png' | 'jpg' | 'gif' | 'webp' | null {
  const starts = (...b: number[]) => b.every((v, i) => bytes[i] === v)
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'png'
  if (starts(0xff, 0xd8, 0xff)) return 'jpg'
  if (starts(0x47, 0x49, 0x46, 0x38)) return 'gif'
  if (starts(0x52, 0x49, 0x46, 0x46) && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'webp'
  return null
}

const MIME: Record<ProofExtension, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  txt: 'text/plain; charset=utf-8',
}

export const mimeOf = (file: string): string => MIME[(file.split('.').pop() ?? 'txt') as ProofExtension] ?? 'application/octet-stream'

/** Text as evidence: UTF-8, no NUL, bounded. */
function asText(bytes: Uint8Array): Taken {
  if (bytes.length > MAX_LOG_BYTES) return { ok: false, error: `A log or test output is at most ${MAX_LOG_BYTES / 1_000_000} MB; that one is ${bytes.length} bytes. Keep the part that shows the point.` }
  if (bytes.includes(0)) return { ok: false, error: 'That is not text: it holds a NUL byte. A screenshot is kind "screenshot".' }
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return { ok: false, error: 'That is not UTF-8 text.' }
  }
  return { ok: true, bytes, extension: 'txt' }
}

/** The folders a path may be read from: the project, and the system's temporary folder. */
function allowedRoots(project: string): string[] {
  const roots = [project, tmpdir(), '/tmp']
  return roots.flatMap((root) => {
    try {
      return [realpathSync(root)]
    } catch {
      return []
    }
  })
}

/** Read evidence from what an agent gave: a path, or text. Nothing is written here. */
export function takeEvidence(project: string, kind: ProofKind, given: { path?: unknown; text?: unknown }): Taken {
  const hasPath = typeof given.path === 'string' && given.path.length > 0
  const hasText = typeof given.text === 'string'
  if (hasPath === hasText) return { ok: false, error: 'Give the evidence as path (an absolute path to the file) or as text, one of the two.' }
  if (hasText) {
    if (kind === 'screenshot') return { ok: false, error: 'A screenshot is a picture: give its file as path.' }
    const text = given.text as string
    if (!text.trim()) return { ok: false, error: 'That text is empty.' }
    return asText(new TextEncoder().encode(text))
  }
  const path = given.path as string
  if (path.length > 4096 || !isAbsolute(path)) return { ok: false, error: 'path is the absolute path of the file.' }
  let real: string
  try {
    real = realpathSync(path)
  } catch {
    return { ok: false, error: `There is no file at ${path.slice(0, 300)}.` }
  }
  if (!allowedRoots(project).some((root) => within(root, real))) {
    return { ok: false, error: `Evidence is read from inside the project or the system’s temporary folder, and ${path.slice(0, 300)} is in neither. Save it into one of them first.` }
  }
  if (!lstatSync(real).isFile()) return { ok: false, error: `${path.slice(0, 300)} is not a plain file.` }
  const size = statSync(real).size
  const max = kind === 'screenshot' ? MAX_PICTURE_BYTES : MAX_LOG_BYTES
  if (size > max) return { ok: false, error: `That file is ${size} bytes; evidence of this kind is at most ${max}.` }
  const bytes = new Uint8Array(readFileSync(real))
  if (kind !== 'screenshot') return asText(bytes)
  const type = pictureType(bytes)
  if (!type) return { ok: false, error: 'A screenshot is a PNG, JPEG, GIF or WebP picture, and that file is none of them.' }
  return { ok: true, bytes, extension: type }
}
