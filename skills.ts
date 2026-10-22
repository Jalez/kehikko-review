import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { skillPath, skillTextIssue, type ModuleSkill } from 'kehikot-module-protocol'
import { originFor, preferred } from 'kehikot-module-protocol/serve'

import { PREFERRED_PORT } from './port.ts'

/**
 * The Claude Code skills this module offers (protocol 2.5.0, `declares.skills`): `/review-pass`,
 * `/review-point` and `/review-reply`. Review provides what a proper review needs: the document, the
 * tools that write it, and the instructions that write it well.
 *
 * Each is ONE file, `plugin/skills/<name>/SKILL.md`, which is a template: where it says `{{origin}}`
 * this module writes the origin it is really serving on (`serveFrom`, from the port Vite ended up
 * bound to), and where it says `{{version}}` the skill's version — the first twelve hex digits of the
 * sha256 of the text with the origin filled in and `{{version}}` unfilled, so a changed template or a
 * moved port makes an installed copy "outdated" and the host's sync brings it level. The same scheme
 * as Factory's and the Claude module's skills. The person installs them from Kehikot's Skills window;
 * this module installs nothing.
 *
 * Each works through this module's own MCP door (`mcp__review__…`), and its `allowed-tools` names
 * exactly the tools it calls and nothing else: no shell, no `gh`, no `glab`, no file writes. Reading
 * the project's files (Read, Grep, Glob) needs no permission in Claude Code. None of them can send:
 * there is no tool for it.
 *
 * ## needs (protocol 2.12.0): none
 *
 * None of the three needs another module on the kehikko. Source and Diff are where a person follows a
 * point's code reference, and Checklist is where a change's checklist may be held — all welcome, none
 * required: the skills read the change, its diff and the files through Review and the project itself,
 * and say so when a checklist is not there to answer. So none is kehikko-bound, and each is offered
 * wherever Review is installed.
 */

export const PLUGIN_DIR = join(import.meta.dirname, 'plugin')
export const ORIGIN_SLOT = '{{origin}}'
export const VERSION_SLOT = '{{version}}'

export const OFFERED = [
  {
    name: 'review-pass',
    summary:
      'Type /review-pass on a pull or merge request: one careful review into Review — anchored, sourced, short points, the checklist answered, the path to approval.',
  },
  {
    name: 'review-point',
    summary: 'Type /review-point where you are pointing in the code: one well-sourced point at that line, in Review for you to keep, edit or drop.',
  },
  {
    name: 'review-reply',
    summary: 'Type /review-reply on your own pull or merge request: a reply to each review thread you received, and what to change. You post them.',
  },
] as const satisfies readonly { name: string; summary: string; needs?: readonly string[] }[]

const LOOPBACK_ORIGIN = /^http:\/\/127\.0\.0\.1:\d{1,5}$/

let served = originFor(preferred(PREFERRED_PORT))

/** Say the origin this process is really on (`http://127.0.0.1:<port>`). Refuses anything else. */
export function serveFrom(origin: string): void {
  if (!LOOPBACK_ORIGIN.test(origin)) throw new Error(`not a loopback origin: ${JSON.stringify(origin)}`)
  served = origin
}

export const servedOrigin = (): string => served

export function skillTemplate(name: string): string | null {
  if (!OFFERED.some((one) => one.name === name)) return null
  return readFileSync(join(PLUGIN_DIR, 'skills', name, 'SKILL.md'), 'utf8')
}

const sha12 = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 12)

/** A template filled in for one origin: the text as served, and its version. */
export function fill(template: string, origin: string): { text: string; version: string } {
  const placed = template.replaceAll(ORIGIN_SLOT, origin)
  const version = sha12(placed)
  return { text: placed.replaceAll(VERSION_SLOT, version), version }
}

export function skillText(name: string, origin = served): string | null {
  const template = skillTemplate(name)
  return template === null ? null : fill(template, origin).text
}

export function skillDeclarations(origin = served): ModuleSkill[] {
  return OFFERED.map((one) => ({
    name: one.name,
    summary: one.summary,
    version: fill(skillTemplate(one.name)!, origin).version,
    ...('needs' in one ? { needs: [...(one as { needs: readonly string[] }).needs] } : {}),
  }))
}

/** The skill a path asks for, or null for a path that is not one of ours (or text that would not pass). */
export function skillAt(path: string): { name: string; text: string } | null {
  for (const one of OFFERED) {
    if (skillPath(one.name) !== path) continue
    const text = skillText(one.name)
    if (text === null || skillTextIssue(text, one.name)) return null
    return { name: one.name, text }
  }
  return null
}

export const isSkillPath = (path: string): boolean => OFFERED.some((one) => skillPath(one.name) === path)
