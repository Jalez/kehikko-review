import { describe, expect, test } from 'bun:test'

import { anchor } from '../review/anchor.ts'
import { MAX_RANGE } from '../review/shape.ts'
import { parseDiff } from '../src/diff/parse.ts'

import { PATCH } from './fake.ts'

/**
 * The rule that decides whether a comment points at real lines.
 *
 * Every refusal is asserted by its words, because the words are what an agent
 * reads to correct itself: "not in the diff" and "on the other side" send it
 * to different fixes.
 */
const files = parseDiff(PATCH)
const at = (want: Parameters<typeof anchor>[1]) => anchor(files, want, 'the diff of commit abc1234')

describe('anchor', () => {
  test('an added line is anchored on the new side, with its text as the quote', () => {
    const got = at({ path: 'src/one.ts', side: 'new', line: 11 })
    expect(got).toEqual({ ok: true, anchor: { path: 'src/one.ts', side: 'new', line: 11, quote: 'is this' } })
  })

  test('a removed line is anchored on the old side', () => {
    const got = at({ path: 'src/one.ts', side: 'old', line: 11 })
    expect(got).toEqual({ ok: true, anchor: { path: 'src/one.ts', side: 'old', line: 11, quote: 'was this' } })
  })

  test('a context line carries its number on the other side, which GitLab needs', () => {
    /* `context after` is old 12, new 13. */
    const got = at({ path: 'src/one.ts', side: 'new', line: 13 })
    expect(got).toEqual({ ok: true, anchor: { path: 'src/one.ts', side: 'new', line: 13, otherLine: 12, quote: 'context after' } })
  })

  test('a context line pressed on the old gutter is recorded on the new side, where a tracker can place it', () => {
    const got = at({ path: 'src/one.ts', side: 'old', line: 12 })
    expect(got).toEqual({ ok: true, anchor: { path: 'src/one.ts', side: 'new', line: 13, otherLine: 12, quote: 'context after' } })
  })

  test('a range on the new side quotes every line of it and names both ends', () => {
    const got = at({ path: 'src/one.ts', side: 'new', line: 13, startLine: 11 })
    expect(got).toEqual({
      ok: true,
      anchor: { path: 'src/one.ts', side: 'new', line: 13, startLine: 11, otherLine: 12, quote: 'is this\nand this too\ncontext after' },
    })
  })

  test('an old-side range skips the added lines interleaved in it', () => {
    /* old 10..12 is: context before, was this, context after. The two added
       lines sit between them on screen and are not part of the old file. */
    const got = at({ path: 'src/one.ts', side: 'old', line: 12, startLine: 10 })
    expect(got.ok && got.anchor.quote).toBe('context before\nwas this\ncontext after')
    expect(got.ok && got.anchor.side).toBe('old')
  })

  test('a start equal to the line is a single line, not a range', () => {
    const got = at({ path: 'src/one.ts', side: 'new', line: 11, startLine: 11 })
    expect(got.ok && got.anchor.startLine).toBeUndefined()
  })

  test('a deleted file is commented on by the only path it has, on the old side', () => {
    const got = at({ path: 'src/gone.ts', side: 'old', line: 2 })
    expect(got).toEqual({ ok: true, anchor: { path: 'src/gone.ts', side: 'old', line: 2, quote: 'second' } })
  })

  test('a file that is not in this diff is refused, naming the diff', () => {
    const got = at({ path: 'src/elsewhere.ts', side: 'new', line: 1 })
    expect(got.ok).toBe(false)
    expect(!got.ok && got.error).toContain('There is no file "src/elsewhere.ts" in the diff of commit abc1234')
  })

  test('a line the diff does not show is refused', () => {
    const got = at({ path: 'src/one.ts', side: 'new', line: 25 })
    expect(!got.ok && got.error).toContain('Line 25 on the new side of "src/one.ts" is not in the diff of commit abc1234')
  })

  test('a line that exists only on the other side is refused with the correction', () => {
    /* New 12 is an added line; there is an old 12 too, so that is not the test.
       New 14 exists (context after is new 13, nothing at 14); use old 13,
       which does not exist while new 13 does. */
    const got = at({ path: 'src/one.ts', side: 'old', line: 13 })
    expect(!got.ok && got.error).toContain('There is a line 13 on the new side; say side: "new" if that is the one.')
  })

  test('a range that crosses from one hunk into the next is refused', () => {
    const got = at({ path: 'src/one.ts', side: 'new', line: 41, startLine: 13 })
    expect(!got.ok && got.error).toContain('cross from one hunk into another')
  })

  test('a range that runs upwards, or is absurdly long, is refused before the diff is consulted', () => {
    expect(at({ path: 'src/one.ts', side: 'new', line: 10, startLine: 13 }).ok).toBe(false)
    const long = at({ path: 'src/one.ts', side: 'new', line: MAX_RANGE + 50, startLine: 1 })
    expect(!long.ok && long.error).toContain(`at most ${MAX_RANGE} lines`)
  })

  test('a binary file has no line to comment on', () => {
    const got = at({ path: 'logo.png', side: 'new', line: 1 })
    expect(!got.ok && got.error).toContain('is binary')
  })

  test('numbers that are not line numbers are refused rather than rounded', () => {
    for (const line of [0, -1, 1.5, Number.NaN, '11' as unknown as number]) {
      expect(at({ path: 'src/one.ts', side: 'new', line }).ok).toBe(false)
    }
    expect(at({ path: 'src/one.ts', side: 'sideways' as never, line: 11 }).ok).toBe(false)
  })

  test('a path that names a property of every object is just a file that is not there', () => {
    expect(at({ path: 'constructor', side: 'new', line: 1 }).ok).toBe(false)
    expect(at({ path: '__proto__', side: 'new', line: 1 }).ok).toBe(false)
  })

  test('a renamed file may be named by its old path, and the anchor records both', () => {
    const renamed = parseDiff(`diff --git a/was.ts b/now.ts
rename from was.ts
rename to now.ts
--- a/was.ts
+++ b/now.ts
@@ -1,2 +1,2 @@
 keep
-old
+new
`)
    const got = anchor(renamed, { path: 'was.ts', side: 'old', line: 2 })
    expect(got).toEqual({ ok: true, anchor: { path: 'now.ts', oldPath: 'was.ts', side: 'old', line: 2, quote: 'old' } })
  })
})
