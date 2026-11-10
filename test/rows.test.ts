import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { rowsAdvice } from 'kehikot-module-protocol'

import { rowsStates } from '../src/rows.ts'

/* `kehikot.rows.json` is what `kehikot-check-rows` reads in CI. It is written from the real footer
   (`bun run rows`); this holds the file equal to it, and the rule satisfied by every state. */
describe('the rows Review declares', () => {
  test('kehikot.rows.json is what the footer function says (run `bun run rows` after changing it)', () => {
    const file = JSON.parse(readFileSync(join(import.meta.dir, '..', 'kehikot.rows.json'), 'utf8'))
    expect(file).toEqual(JSON.parse(JSON.stringify(rowsStates())))
  })

  test('no advice in any state: the header sets it up, the footer says how it stands', () => {
    for (const state of rowsStates()) expect(rowsAdvice(state.header, state.footer, { state: state.state === true })).toEqual([])
  })
})
