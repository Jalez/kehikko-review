import { afterEach, describe, expect, test } from 'bun:test'
import { cleanup, render } from '@testing-library/react'
import { FIND_MARK_ATTRIBUTE, pageFind } from 'kehikot-module-protocol/client'

import type { Comment } from '../review/shape.ts'
import { PointCard } from '../src/view/comment.tsx'

/**
 * Find (protocol 2.69.0). A review's points are plain DOM, so the host's find bar is answered by the
 * protocol client's own search of the page with no code here. Words still being typed are in text
 * boxes, which the client's search leaves alone. This holds that the search marks, counts, moves
 * and clears on the points this page renders. Marked with `<mark>` here (the test document has no
 * `CSS.highlights`), which also proves the marks come back out of React's DOM without a trace.
 */

afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
})

const point = (id: string, line: number, body: string): Comment => ({
  id,
  view: 'all',
  commit: 'a'.repeat(40),
  path: 'src/store.ts',
  side: 'new',
  line,
  quote: 'const cache = new Map()',
  body,
  by: 'person',
  at: '2026-08-31T09:00:00Z',
})

const ignore = () => Promise.resolve()
const card = (comment: Comment) => (
  <PointCard comment={comment} onLocate={() => {}} onReword={ignore} onDrop={ignore} onKeep={ignore} onResolve={ignore} />
)

function points() {
  return render(
    <div>
      {card(point('p1', 12, 'This cache is never cleared, so a long session grows without bound.'))}
      {card(point('p2', 40, 'Clear the cache when the project changes.'))}
    </div>,
  ).container
}

const marks = (root: Element) => [...root.querySelectorAll(`mark[${FIND_MARK_ATTRIBUTE}]`)]
const words = { caseSensitive: false, wholeWord: true }

describe('find in the review', () => {
  test('marks and counts the matches in the points, and moves between them', () => {
    const root = points()
    const search = pageFind(() => {}, { root, visible: () => true, highlights: false })
    const { total, current } = search.run('cache', words, 'first')
    /* Both points say it, and both quote the line they are on. */
    expect(total).toBeGreaterThanOrEqual(2)
    expect(current).toBe(1)
    expect(marks(root)).toHaveLength(total)
    expect(marks(root).every((mark) => mark.textContent?.toLowerCase() === 'cache')).toBe(true)
    expect(search.run('cache', words, 'next')).toEqual({ total, current: 2 })
    expect(search.run('cache', words, 'prev')).toEqual({ total, current: 1 })
    expect(search.run('cache', words, 'prev')).toEqual({ total, current: total })
    expect(root.querySelectorAll('[data-current]')).toHaveLength(1)
    search.close()
  })

  test('close clears every mark and leaves the points as React drew them', () => {
    const root = points()
    const before = root.innerHTML
    const search = pageFind(() => {}, { root, visible: () => true, highlights: false })
    search.run('cache', words, 'first')
    search.close()
    expect(marks(root)).toHaveLength(0)
    expect(root.innerHTML).toBe(before)
  })
})
