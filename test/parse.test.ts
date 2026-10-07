import { describe, expect, test } from 'bun:test'

import { parseDiff, totals } from '../src/diff/parse.ts'

const PATCH = `diff --git a/src/one.ts b/src/one.ts
index 1111111..2222222 100644
--- a/src/one.ts
+++ b/src/one.ts
@@ -10,4 +10,5 @@ export const thing = 1
 context before
-was this
+is this
+and this too
 context after
diff --git a/src/gone.ts b/src/gone.ts
deleted file mode 100644
index 3333333..0000000
--- a/src/gone.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-first
-second
diff --git a/logo.png b/logo.png
index 4444444..5555555 100644
Binary files a/logo.png and b/logo.png differ
diff --git a/src/new.ts b/src/new.ts
new file mode 100644
index 0000000..6666666
--- /dev/null
+++ b/src/new.ts
@@ -0,0 +1,1 @@
+hello
`

describe('parseDiff', () => {
  test('every file in the patch becomes exactly one file out of it', () => {
    /* The promise the whole module rests on: a file that is not drawn looks
       exactly like a file that was never changed. */
    const files = parseDiff(PATCH)
    expect(files.map((f) => f.path)).toEqual(['src/one.ts', 'src/gone.ts', 'logo.png', 'src/new.ts'])
  })

  test('line numbers are counted from the hunk header, per side', () => {
    const [one] = parseDiff(PATCH)
    const lines = one!.hunks[0]!.lines
    expect(lines.map((l) => [l.kind, l.old, l.new])).toEqual([
      ['context', 10, 10],
      ['del', 11, null],
      ['add', null, 11],
      ['add', null, 12],
      ['context', 12, 13],
    ])
  })

  test('a deleted file is named on the side it exists on', () => {
    const gone = parseDiff(PATCH)[1]!
    expect(gone.path).toBe('src/gone.ts')
    expect(gone.status).toBe('removed')
    expect(gone.removed).toBe(2)
    expect(gone.added).toBe(0)
  })

  test('a binary file has no lines and still has an entry', () => {
    const logo = parseDiff(PATCH)[2]!
    expect(logo.binary).toBe(true)
    expect(logo.hunks).toEqual([])
    expect(logo.path).toBe('logo.png')
  })

  test('a new file is marked as one', () => {
    const made = parseDiff(PATCH)[3]!
    expect(made.status).toBe('added')
    expect(made.added).toBe(1)
  })

  test('totals sum every file', () => {
    expect(totals(parseDiff(PATCH))).toEqual({ files: 4, added: 3, removed: 3, lines: 8 })
  })

  test('a rename with no content change is still a file', () => {
    const files = parseDiff(`diff --git a/old.ts b/new.ts
similarity index 100%
rename from old.ts
rename to new.ts
`)
    expect(files).toHaveLength(1)
    expect(files[0]!.status).toBe('renamed')
    expect(files[0]!.path).toBe('new.ts')
    expect(files[0]!.from).toBe('old.ts')
  })

  test('git’s no-newline remark is kept and is nobody’s line', () => {
    const files = parseDiff(`diff --git a/a.txt b/a.txt
--- a/a.txt
+++ b/a.txt
@@ -1 +1 @@
-one
\\ No newline at end of file
+two
`)
    const kinds = files[0]!.hunks[0]!.lines.map((l) => l.kind)
    expect(kinds).toEqual(['del', 'note', 'add'])
    const note = files[0]!.hunks[0]!.lines[1]!
    expect(note.old).toBeNull()
    expect(note.new).toBeNull()
  })

  test('an empty context line does not end the hunk', () => {
    /* Producers that strip trailing whitespace write '' where git writes ' '.
       Treating that as the end of the hunk would lose every line after it. */
    const files = parseDiff(`diff --git a/a.txt b/a.txt
--- a/a.txt
+++ b/a.txt
@@ -1,3 +1,3 @@
 one

-two
+three
`)
    expect(files[0]!.hunks[0]!.lines).toHaveLength(4)
    expect(files[0]!.removed).toBe(1)
  })

  test('a hunk header it cannot read numbers nothing rather than numbering wrongly', () => {
    const files = parseDiff(`diff --git a/a.txt b/a.txt
--- a/a.txt
+++ b/a.txt
@@ what @@
+added
`)
    const line = files[0]!.hunks[0]!.lines[0]!
    expect(line.kind).toBe('add')
    expect(line.new).toBeNull()
  })

  test('something that is not a diff is an empty list rather than a throw', () => {
    expect(parseDiff('')).toEqual([])
    expect(parseDiff('gh: could not find that pull request')).toEqual([])
  })

  test('carriage returns from a Windows checkout do not become content', () => {
    const files = parseDiff('diff --git a/a.txt b/a.txt\r\n--- a/a.txt\r\n+++ b/a.txt\r\n@@ -1 +1 @@\r\n+one\r\n')
    expect(files[0]!.path).toBe('a.txt')
    expect(files[0]!.hunks[0]!.lines[0]!.text).toBe('one')
  })
})
