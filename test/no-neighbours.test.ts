import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

/**
 * Modules never name each other: Review provides the `review.drafts` service, and whoever uses it is
 * found by the host, not named here. This scans the module's own code, manifest, tool descriptions,
 * page strings and README for another module's id, its data folder, the private send this module
 * once kept for one consumer, and that consumer's name. Tests, notes, docs, the changelog and the
 * skills' text (plugin/skills) are not scanned.
 */
const ROOT = join(import.meta.dir, '..')
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'test', 'notes', 'docs', 'plugin'])
const SCANNED = /\.(ts|tsx|json|md|sh|css|html)$/
const SKIP_FILES = new Set(['bun.lock', 'CHANGELOG.md'])

function files(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name) || SKIP_FILES.has(name) || name.startsWith('.')) continue
    const path = join(dir, name)
    if (statSync(path).isDirectory()) out.push(...files(path))
    else if (SCANNED.test(name)) out.push(path)
  }
  return out
}

const NEIGHBOURS = ['paper', 'checklist', 'factory', 'flows', 'references', 'journeys', 'screenplay', 'history', 'source', 'diff', 'claude', 'codex', 'queue', 'notes', 'slides']

const FORBIDDEN: [RegExp, string][] = [
  [new RegExp(`\\b(?:kehikot|roadmap)\\.(?:${NEIGHBOURS.join('|')})\\b`, 'i'), 'another module’s id'],
  [new RegExp(`\\.kehikot/(?:${NEIGHBOURS.join('|')})\\b`, 'i'), 'another module’s data folder'],
  [new RegExp(`KEHIKOT_DIR\\}/(?:${NEIGHBOURS.join('|')})\\b`), 'another module’s data folder'],
  [/factory/i, 'the name of a module that uses the review.drafts service'],
  [/Factory-Key|KEHIKOT_KEYS_DIR|review-factory\.key|\/api\/factory/i, 'the private send key this module once kept'],
]

describe('Review names no other module', () => {
  const scanned = files(ROOT)

  test('scans the module’s code', () => {
    expect(scanned.some((file) => file.endsWith('manifest.ts'))).toBe(true)
    expect(scanned.some((file) => file.endsWith('send/door.ts'))).toBe(true)
  })

  test('outside tests, notes, docs and the skills’ text', () => {
    const hits: string[] = []
    for (const file of scanned) {
      const lines = readFileSync(file, 'utf8').split('\n')
      lines.forEach((line, at) => {
        for (const [pattern, what] of FORBIDDEN) if (pattern.test(line)) hits.push(`${relative(ROOT, file)}:${at + 1}: ${what}: ${line.trim().slice(0, 120)}`)
      })
    }
    expect(hits).toEqual([])
  })
})
