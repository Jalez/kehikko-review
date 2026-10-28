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

  test('asks a host for the tracker reading, for pointing at code and for opening links, and nothing else, and says what it reacts to', () => {
    /* Reaching GitHub and GitLab is not a capability: this module's own server
       runs the person's `gh` and `glab`. `location:set` is a point's code reference;
       `address:open` hands a link to the canvas (protocol 2.16.0). */
    expect(MANIFEST.declares.uses).toEqual(['trackers:read', 'location:set', 'address:open'])
    expect(MANIFEST.reacts).toEqual(['selection', 'tracker', 'location'])
    expect(MANIFEST.dataVersion).toBe(2)
    expect(MANIFEST.modes).toEqual([{ id: 'review', label: 'Review', scope: 'part', scopeSays: 'the review of the one change picked out' }])
  })

  test('tells an arriving agent that it drafts and a person sends', () => {
    expect(MANIFEST.guidance).toContain('DRAFT')
    expect(MANIFEST.guidance).toContain('only the person sends')
    expect(MANIFEST.mcp?.about).toContain('nothing here posts')
  })

  test('declares its three skills, none of them bound to another module', () => {
    expect(MANIFEST.declares.skills?.map((one) => one.name)).toEqual(['review-pass', 'review-point', 'review-reply'])
    for (const skill of MANIFEST.declares.skills ?? []) expect(skill.needs).toBeUndefined()
  })

  test('prefers a port on the ten-apart grid', () => {
    expect(Number.isInteger(PREFERRED_PORT)).toBe(true)
    expect(PREFERRED_PORT % 10).toBe(0)
  })
})
