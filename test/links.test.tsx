import { afterEach, describe, expect, test } from 'bun:test'
import { cleanup, fireEvent, render } from '@testing-library/react'
import type { AddressOpenResult } from 'kehikot-module-protocol'

import { handLink, handsLink, stillFollow } from '../src/lib/links.ts'
import { OpenAddressContext, OutLink } from '../src/view/out-link.tsx'

/**
 * A link out of Review, handed to the canvas (`address.open`, protocol 2.16.0)
 * when the host answers it; a new tab otherwise.
 */

afterEach(cleanup)

const answer = (outcome: AddressOpenResult['outcome']): AddressOpenResult => ({ outcome, why: '' })
const open = () => Promise.resolve(answer('shown'))

describe('handsLink', () => {
  test('only with a host that takes addresses, and only an address the protocol takes', () => {
    expect(handsLink('https://github.com/o/r/pull/46', open)).toBe(true)
    expect(handsLink('https://github.com/o/r/pull/46', null)).toBe(false)
    for (const url of ['javascript:alert(1)', 'data:text/html,x', 'http://example.com', 'https://u:p@github.com', '', null]) {
      expect(handsLink(url, open)).toBe(false)
    }
  })
})

describe('after handing it over', () => {
  test('shown or offered: nothing more is opened', async () => {
    for (const outcome of ['shown', 'offered'] as const) {
      expect(stillFollow(answer(outcome))).toBe(false)
      const opened: string[] = []
      await handLink('https://example.com', () => Promise.resolve(answer(outcome)), (url) => void opened.push(url))
      expect(opened).toEqual([])
    }
  })
  test('declined or unanswered: the old new tab', async () => {
    for (const given of [answer('declined'), null]) {
      const opened: string[] = []
      await handLink('https://example.com', () => Promise.resolve(given), (url) => void opened.push(url))
      expect(opened).toEqual(['https://example.com'])
    }
  })
})

describe('OutLink', () => {
  test('inside a host that takes addresses, a press hands the address over and is not followed', () => {
    const asked: string[] = []
    const { getByText } = render(
      <OpenAddressContext.Provider value={(url) => (asked.push(url), Promise.resolve(answer('offered')))}>
        <OutLink href="https://example.com/source">a source</OutLink>
      </OpenAddressContext.Provider>,
    )
    expect(fireEvent.click(getByText('a source'))).toBe(false)
    expect(asked).toEqual(['https://example.com/source'])
  })

  test('a link the protocol would not take is followed as a link, and not handed over', () => {
    const asked: string[] = []
    const { getByText } = render(
      <OpenAddressContext.Provider value={(url) => (asked.push(url), Promise.resolve(answer('shown')))}>
        <OutLink href="http://example.com/plain">plain</OutLink>
      </OpenAddressContext.Provider>,
    )
    expect(fireEvent.click(getByText('plain'))).toBe(true)
    expect(asked).toEqual([])
  })

  test('without one, an ordinary new-tab link with noopener and noreferrer', () => {
    const { getByText } = render(<OutLink href="https://example.com">out</OutLink>)
    const link = getByText('out') as HTMLAnchorElement
    expect(link.target).toBe('_blank')
    expect(link.rel).toBe('noopener noreferrer')
    expect(fireEvent.click(link)).toBe(true)
  })
})
