import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/**
 * The key Factory presents to send a run's review (contract C4).
 *
 * 32 random bytes as hex, in `review-factory.key` in the machine's Kehikot keys folder —
 * `KEHIKOT_KEYS_DIR` when set — made by Review on its first start, mode 0600 in a folder made 0700.
 * Factory, running as the same user, reads it and sends it in `X-Kehikot-Factory-Key`. Nothing
 * else here ever prints it: not the page, not `/healthz`, not the MCP door.
 *
 * What it separates: a program this person runs that may read their files (Factory) from a page
 * in their browser, which cannot, and from another user on the machine. It is not a defence
 * against a program already running as this user, which could also read the person's `gh` login.
 */

export const KEY_FILE = 'review-factory.key'
/** As node hands a header over: lower case. */
export const KEY_HEADER = 'x-kehikot-factory-key'

const KEY = /^[0-9a-f]{64}$/

/** The keys folder: `KEHIKOT_KEYS_DIR`, else `~/Library/Application Support/Kehikot/keys` (the XDG data dir off macOS). */
export function keysDir(env: Record<string, string | undefined> = process.env): string {
  const said = env.KEHIKOT_KEYS_DIR?.trim()
  if (said) return said
  const home = env.HOME || homedir()
  if (process.platform === 'darwin') return join(home, 'Library', 'Application Support', 'Kehikot', 'keys')
  return join(env.XDG_DATA_HOME || join(home, '.local', 'share'), 'kehikot', 'keys')
}

export const keyFile = (env: Record<string, string | undefined> = process.env): string => join(keysDir(env), KEY_FILE)

export type KeyRead = { ok: true; key: string; file: string } | { ok: false; error: string; why: 'missing' | 'unsafe' | 'malformed' }

/**
 * The key in the file, without making one. A file others can read is closed to them first; a
 * symlink, a folder or a file another user owns is refused rather than followed or trusted.
 */
export function loadKey(file: string = keyFile()): KeyRead {
  let stat
  try {
    stat = lstatSync(file)
  } catch {
    return { ok: false, why: 'missing', error: `There is no key at ${file} yet: Review makes it when it starts.` }
  }
  if (!stat.isFile()) return { ok: false, why: 'unsafe', error: `${file} is not a plain file (a link or a folder), so it is not used as the key.` }
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    return { ok: false, why: 'unsafe', error: `${file} belongs to another user, so it is not used as the key.` }
  }
  if (stat.mode & 0o077) chmodSync(file, 0o600)
  let text: string
  try {
    text = readFileSync(file, 'utf8').trim()
  } catch (e) {
    return { ok: false, why: 'unsafe', error: `${file} could not be read: ${e instanceof Error ? e.message : String(e)}` }
  }
  if (!KEY.test(text)) return { ok: false, why: 'malformed', error: `${file} does not hold a key this app made.` }
  return { ok: true, key: text, file }
}

/** On start: the key, made when there is none (or the file holds something that is not one). */
export function ensureKey(file: string = keyFile()): KeyRead {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const had = loadKey(file)
  if (had.ok || had.why === 'unsafe') return had
  /* Written beside it and renamed over, so a reader never sees half a key; 0600 from the first byte. */
  const temporary = `${file}.${process.pid}.tmp`
  writeFileSync(temporary, `${randomBytes(32).toString('hex')}\n`, { mode: 0o600, flag: 'w' })
  chmodSync(temporary, 0o600)
  renameSync(temporary, file)
  return loadKey(file)
}

/**
 * Whether a presented key is the key. Constant-time: both are hashed to the same length first, so
 * neither a matching prefix nor the length shows in how long the answer takes.
 */
export function sameKey(carried: string | null | undefined, key: string): boolean {
  if (typeof carried !== 'string' || !carried || !key) return false
  const digest = (text: string) => createHash('sha256').update(text).digest()
  return timingSafeEqual(digest(carried), digest(key))
}
