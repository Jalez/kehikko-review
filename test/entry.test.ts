import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/* The page's entry is the protocol's (2.70.0): the client first, for the mailbox, then `mountPage`. */
describe('the entry', () => {
  test('imports the client before anything renders, and mounts through mountPage', () => {
    const entry = readFileSync(join(import.meta.dir, '..', 'src', 'main.tsx'), 'utf8')
    const client = entry.indexOf("import 'kehikot-module-protocol/client'")
    const mount = entry.indexOf("from 'kehikot-module-protocol/client/mount'")
    expect(client).toBeGreaterThan(-1)
    expect(mount).toBeGreaterThan(client)
    expect(entry).toContain("mountPage('root', <App />)")
    expect(entry).not.toContain('createRoot')
  })
})
