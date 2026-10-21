import { afterAll, describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { KEY_FILE, ensureKey, keyFile, keysDir, loadKey, sameKey } from '../factory/key.ts'

/**
 * The key Factory presents to send a run's review: 32 random bytes as hex, in a file only this
 * user can read, created by Review on its first start. Every test here works in a scratch folder.
 */
const home = mkdtempSync(join(tmpdir(), 'kehikko-review-keys-'))
afterAll(() => rmSync(home, { recursive: true, force: true }))
let n = 0
const fresh = () => join(home, `k${(n += 1)}`, KEY_FILE)
const mode = (path: string) => statSync(path).mode & 0o777

describe('where the key lives', () => {
  test('KEHIKOT_KEYS_DIR when set; the machine directory otherwise', () => {
    expect(keysDir({ KEHIKOT_KEYS_DIR: '/x/keys' })).toBe('/x/keys')
    expect(keyFile({ KEHIKOT_KEYS_DIR: '/x/keys' })).toBe('/x/keys/review-factory.key')
    const machine = keysDir({ HOME: '/Users/someone' })
    expect(machine.endsWith(process.platform === 'darwin' ? 'Library/Application Support/Kehikot/keys' : 'kehikot/keys')).toBe(true)
    /* The tests themselves never point at the real one. */
    expect(keysDir()).toBe(process.env.KEHIKOT_KEYS_DIR!)
    expect(keysDir().startsWith(tmpdir()) || keysDir().startsWith('/private')).toBe(true)
  })
})

describe('making it and reading it', () => {
  test('first start makes 64 hex characters, readable only by this user, in a folder only this user can enter', () => {
    const file = fresh()
    const made = ensureKey(file)
    if (!made.ok) throw new Error(made.error)
    expect(made.key).toMatch(/^[0-9a-f]{64}$/)
    expect(mode(file)).toBe(0o600)
    expect(mode(join(file, '..'))).toBe(0o700)
    /* The second start finds the same key. */
    const again = ensureKey(file)
    expect(again.ok && again.key).toBe(made.key)
    expect(loadKey(file)).toEqual(made)
  })

  test('reading never makes one: no file is a refusal', () => {
    const got = loadKey(fresh())
    expect(got.ok).toBe(false)
    if (!got.ok) expect(got.error).toContain('no key')
  })

  test('a key file others could read is closed to them before it is used', () => {
    const file = fresh()
    const made = ensureKey(file)
    chmodSync(file, 0o644)
    expect(loadKey(file)).toEqual(made)
    expect(mode(file)).toBe(0o600)
  })

  test('a symlink is refused, not followed; junk in the file is replaced on start and refused on read', () => {
    const target = fresh()
    ensureKey(target)
    const file = fresh()
    ensureKey(file)
    rmSync(file)
    symlinkSync(target, file)
    for (const got of [loadKey(file), ensureKey(file)]) {
      expect(got.ok).toBe(false)
      if (!got.ok) expect(got.error).toContain('not a plain file')
    }
    const junk = fresh()
    ensureKey(junk)
    writeFileSync(junk, 'not a key\n')
    expect(loadKey(junk).ok).toBe(false)
    const replaced = ensureKey(junk)
    expect(replaced.ok && replaced.key).toMatch(/^[0-9a-f]{64}$/)
    expect(mode(junk)).toBe(0o600)
  })
})

describe('comparing a presented key', () => {
  const key = 'a'.repeat(64)
  test('only the exact key matches', () => {
    expect(sameKey(key, key)).toBe(true)
    for (const other of [null, undefined, '', 'a', 'a'.repeat(63), 'a'.repeat(65), 'b'.repeat(64), key.toUpperCase(), ` ${key}`]) {
      expect(sameKey(other, key)).toBe(false)
    }
    /* No key on this side matches nothing, not even an empty one presented. */
    expect(sameKey('', '')).toBe(false)
  })
})
