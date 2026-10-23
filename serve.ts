#!/usr/bin/env bun
import { run } from 'kehikot-module-protocol/run'

import { BUILD, MANIFEST, TICKET, answer, ours } from './doors.ts'
import { factoryBefore, startFactory } from './factory/door.ts'
import { ID, PREFERRED_PORT, servingAt } from './manifest.ts'

/**
 * This module over its BUILT page (`bun run build`), on the same doors and the
 * same port. `run.sh` starts this when `dist/` carries a stamp of the commit
 * checked out, and Vite otherwise.
 *
 * Nothing this module says is decided here. The doors are `answer` in
 * `doors.ts`, mounted by the protocol's `run` exactly as `doors()` mounts them
 * on Vite, with the same `ours` (the skills' SKILL.md files too). Factory's
 * send is `factoryBefore` in `factory/door.ts`, asked before the doors here as
 * `factoryDoor()` asks it on Vite: one function on both servers, so the two
 * cannot disagree about who may send a review. A build that is not this
 * checkout's is never served: `run` answers the page with a 503 saying which
 * commit each is, and the command to run.
 */
startFactory()

const running = await run({
  id: ID,
  prefer: PREFERRED_PORT,
  dir: import.meta.dirname,
  manifest: MANIFEST,
  answer,
  build: BUILD,
  ticket: TICKET,
  before: factoryBefore(),
  ours,
})

/* The skills name the origin they are on: the port actually bound, as `listening()` does on Vite. */
servingAt(running.origin)
