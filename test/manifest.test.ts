import { describe, expect, test } from 'bun:test'
import { HELP_LIMITS, MODULE_FOLDERS, MODULE_ID, REVIEW_DRAFTS, SERVICES, helpOf, manifestSchema, moduleDir, moduleFolder } from 'kehikot-module-protocol'
import { basename } from 'node:path'

import { REAL, answer } from '../doors.ts'
import { SEND_PATH } from '../send/door.ts'

import { HELP, ID, MANIFEST, PREFERRED_PORT } from '../manifest.ts'

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

  test('asks a host for the tracker reading, for pointing at code and for opening links, keeps its view, and nothing else, and says what it reacts to', () => {
    /* Reaching GitHub and GitLab is not a capability: this module's own server
       runs the person's `gh` and `glab`. `location:set` is a point's code reference;
       `address:open` hands a link to the canvas (protocol 2.16.0); `state:keep` keeps the view per container (2.51.0). */
    expect(MANIFEST.declares.uses).toEqual(['trackers:read', 'location:set', 'address:open', 'state:keep'])
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

describe('How to use (protocol 2.52.0)', () => {
  test('is declared, within the protocol’s bounds, and read back whole as plain one-line text', () => {
    const help = helpOf(MANIFEST)
    expect(help).toEqual(HELP)
    expect(HELP.summary.length).toBeLessThanOrEqual(HELP_LIMITS.SUMMARY)
    expect(HELP.sections.length).toBeLessThanOrEqual(HELP_LIMITS.SECTIONS)
    for (const section of HELP.sections) {
      expect(section.title.length).toBeLessThanOrEqual(HELP_LIMITS.TITLE)
      expect(section.points.length).toBeLessThanOrEqual(HELP_LIMITS.POINTS)
      for (const point of section.points) {
        expect(point.length).toBeLessThanOrEqual(HELP_LIMITS.POINT)
        expect(point).not.toMatch(/[<>]|https?:|\]\(/)
      }
    }
  })

  test('says what it shows, how to use it and what agents can do', () => {
    expect(HELP.sections.map((section) => section.title)).toEqual(expect.arrayContaining(['What it shows', 'How to use it', 'What agents can do']))
  })
})

describe('the module.folders service (protocol 2.85.0)', () => {
  test('declares the folder the store writes, authored and not derived', () => {
    const parsed = SERVICES[MODULE_FOLDERS].schema.safeParse(MANIFEST.services?.[MODULE_FOLDERS])
    expect(parsed.success).toBe(true)
    expect(parsed.data?.folders.map((one) => [one.folder, one.derived])).toEqual([[basename(moduleDir('/p', ID) ?? ''), false]])
  })
})

describe('the review.drafts service (protocol 2.83.0)', () => {
  const descriptor = MANIFEST.services?.[REVIEW_DRAFTS]

  test('is declared, and parses with the protocol’s schema for it', () => {
    /* A descriptor that does not parse makes the manifest drop the whole field, so its absence is the failure. */
    expect(descriptor).toBeDefined()
    expect(SERVICES[REVIEW_DRAFTS].schema.safeParse(descriptor).success).toBe(true)
    expect(descriptor).toEqual({
      name: 'Review',
      tools: { comment: 'add_comment', propose: 'propose_review', drop: 'drop_run_comments' },
      send: SEND_PATH,
    })
  })

  test('names only tools this module’s MCP door lists', async () => {
    const reply = await answer('POST', '/mcp', new URLSearchParams(), { jsonrpc: '2.0', id: 1, method: 'tools/list' }, null, REAL)
    const listed = ((reply?.body as { result?: { tools?: { name: string }[] } }).result?.tools ?? []).map((tool) => tool.name)
    expect(listed.length).toBeGreaterThan(0)
    const parsed = SERVICES[REVIEW_DRAFTS].schema.parse(descriptor)
    for (const tool of Object.values(parsed.tools)) expect(listed).toContain(tool)
  })
})
