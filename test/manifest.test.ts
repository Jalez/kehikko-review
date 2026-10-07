import { describe, expect, test } from 'bun:test'
import { MODULE_ID, manifestSchema, moduleFolder } from 'kehikot-module-protocol'

import { ID, MANIFEST, PREFERRED_PORT } from '../manifest.ts'

describe('the manifest', () => {
  test('is one a host accepts', () => {
    expect(manifestSchema.safeParse(MANIFEST).success).toBe(true)
  })

  test('names this module by an id the protocol accepts, keeping its data under its own folder', () => {
    expect(MODULE_ID.test(ID)).toBe(true)
    expect(MANIFEST.id).toBe(ID)
    expect(moduleFolder(ID)).toBe('review')
  })

  test('declares storage, because this module takes writes on its own origin', () => {
    expect(MANIFEST.declares.storage).toBe(true)
  })

  test('points at doors this module answers', () => {
    expect(MANIFEST.entry).toBe('/app')
    expect(MANIFEST.health).toBe('/healthz')
    expect(MANIFEST.mcp?.url).toBe('/mcp')
  })

  test('asks a host for the tracker reading and nothing else, and says what it reacts to', () => {
    /* Reaching GitHub and GitLab is not a capability: this module's own server
       runs the person's `gh` and `glab`. */
    expect(MANIFEST.declares.uses).toEqual(['trackers:read'])
    expect(MANIFEST.reacts).toEqual(['selection', 'tracker'])
    expect(MANIFEST.modes).toEqual([{ id: 'review', label: 'Review', scope: 'epic' }])
  })

  test('tells an arriving agent that it drafts and a person sends', () => {
    expect(MANIFEST.guidance).toContain('DRAFT')
    expect(MANIFEST.guidance).toContain('only the person sends')
    expect(MANIFEST.mcp?.about).toContain('nothing here posts')
  })

  test('prefers a port on the ten-apart grid', () => {
    expect(Number.isInteger(PREFERRED_PORT)).toBe(true)
    expect(PREFERRED_PORT % 10).toBe(0)
  })
})
