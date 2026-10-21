import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { answer, type Deps } from '../doors.ts'
import { locate, type Target } from '../forge/locate.ts'
import { allowedImage, findImages, shotsOf } from '../review/shots.ts'

import { GH_PULL, GH_URL, GL_URL, fake, githubReads, pathOf } from './fake.ts'

/**
 * The pictures a change's author posted, found in its description and comments, labelled before
 * or after by the words next to them, and allowed only when they are `https:` images on the
 * forge's own hosts. Nothing here fetches an image.
 */
const gh: Target = locate(GH_URL)!
const gl: Target = locate(GL_URL)!

describe('finding images', () => {
  test('markdown and HTML, with their alt text', () => {
    const found = findImages('Look: ![the old page](https://github.com/a.png "title") and <img width="300" alt="New page" src="https://github.com/b.png" />')
    expect(found.map((f) => [f.raw, f.alt])).toEqual([
      ['https://github.com/a.png', 'the old page'],
      ['https://github.com/b.png', 'New page'],
    ])
  })

  test('a link that is not an image is not one', () => {
    expect(findImages('[before](https://github.com/a.png) <a href="https://github.com/b.png">after</a>')).toEqual([])
  })
})

describe('which host an image may come from', () => {
  test('GitHub: https on github.com and its content hosts', () => {
    for (const url of [
      'https://github.com/user-attachments/assets/1234',
      'https://user-images.githubusercontent.com/1/2.png',
      'https://private-user-images.githubusercontent.com/1/2.png?jwt=x',
      'https://raw.githubusercontent.com/o/r/main/x.png',
    ]) {
      expect(allowedImage(url, gh)).toEqual({ ok: true, url })
    }
  })

  test('GitLab: its own host, and an upload path made absolute under the project', () => {
    expect(allowedImage('/uploads/abc/shot.png', gl)).toEqual({ ok: true, url: 'https://gitlab.example/g/sub/p/uploads/abc/shot.png' })
    expect(allowedImage('https://gitlab.example/-/project/1/uploads/abc/x.png', gl).ok).toBe(true)
    expect(allowedImage('https://gitlab.com/x.png', gl).ok).toBe(false)
  })

  test('everything else is refused with a reason, and never made into a request', () => {
    const refused: [string, Target, string][] = [
      ['http://github.com/a.png', gh, 'https'],
      ['javascript:alert(1)', gh, 'https'],
      ['data:image/png;base64,AAAA', gh, 'https'],
      ['https://evil.example/a.png', gh, 'evil.example'],
      ['https://github.com.evil.example/a.png', gh, 'github.com.evil.example'],
      ['https://user:pass@github.com/a.png', gh, 'login'],
      ['https://github.com:8443/a.png', gh, 'port'],
      ['//evil.example/a.png', gh, 'evil.example'],
      ['/relative.png', gh, 'https'],
      ['https://gitlab.example/x.png', gh, 'gitlab.example'],
      [`https://github.com/${'x'.repeat(2100)}`, gh, 'long'],
    ]
    for (const [url, target, word] of refused) {
      const got = allowedImage(url, target)
      expect(got.ok).toBe(false)
      if (!got.ok) expect(got.why).toContain(word)
    }
  })
})

describe('before and after', () => {
  const A = 'https://github.com/a.png'
  const B = 'https://github.com/b.png'
  const C = 'https://github.com/c.png'

  test('by alt text', () => {
    const got = shotsOf(gh, [{ where: 'the description', text: `![Before](${A}) ![After](${B})` }])
    expect(got.pairs.map((p) => [p.before.url, p.after.url])).toEqual([[A, B]])
    expect(got.single).toEqual([])
  })

  test('by the words just before them', () => {
    const got = shotsOf(gh, [{ where: 'the description', text: `Before:\n\n![](${A})\n\nAfter:\n\n![](${B})` }])
    expect(got.pairs.map((p) => [p.before.url, p.after.url])).toEqual([[A, B]])
  })

  test('by a table’s header row, markdown or HTML', () => {
    const md = `| Before | After |\n| --- | --- |\n| ![](${A}) | ![](${B}) |`
    expect(shotsOf(gh, [{ where: 'd', text: md }]).pairs.map((p) => [p.before.url, p.after.url])).toEqual([[A, B]])
    const html = `<table><tr><th>After</th><th>Before</th></tr><tr><td><img src="${B}"></td><td><img src="${A}"></td></tr></table>`
    expect(shotsOf(gh, [{ where: 'd', text: html }]).pairs.map((p) => [p.before.url, p.after.url])).toEqual([[A, B]])
  })

  test('across the description and a comment, in order; what has no partner is shown alone, and what is refused is said', () => {
    const got = shotsOf(gh, [
      { where: 'the description', text: `Before ![](${A})` },
      { where: 'a comment by ada', text: `After ![](${B}) and something else ![](${C}) ![x](https://evil.example/x.png)` },
    ])
    expect(got.pairs).toHaveLength(1)
    expect(got.pairs[0]!.after.where).toBe('a comment by ada')
    expect(got.single.map((s) => s.url)).toEqual([C])
    expect(got.refused).toHaveLength(1)
    expect(got.refused[0]!.why).toContain('evil.example')
    expect(got.refused[0]!.where).toBe('a comment by ada')
  })

  test('bounded', () => {
    const many = Array.from({ length: 200 }, (_, i) => `![](https://github.com/${i}.png)`).join(' ')
    const got = shotsOf(gh, [{ where: 'd', text: many }])
    expect(got.single.length + got.pairs.length * 2 + got.refused.length).toBeLessThanOrEqual(60)
    expect(got.more).toBe(true)
  })
})

describe('/api/shots', () => {
  const home = mkdtempSync(join(tmpdir(), 'kehikko-review-shots-'))
  afterAll(() => rmSync(home, { recursive: true, force: true }))

  test('reads the description and the conversation from the forge', async () => {
    const runner = fake((run) => {
      if (pathOf(run) === 'repos/o/r/pulls/46' && !run.args.includes('Accept: application/vnd.github.diff')) return JSON.stringify({ ...JSON.parse(GH_PULL), body: 'Before ![](https://github.com/a.png)' })
      if (pathOf(run) === 'repos/o/r/issues/46/comments?per_page=100') return JSON.stringify([{ user: { login: 'ada' }, body: 'After ![](https://github.com/b.png)' }])
      return githubReads(run)
    })
    const deps: Deps = { run: runner.run, now: () => 'now', id: () => 'c' }
    const reply = await answer('GET', '/api/shots', new URLSearchParams({ url: GH_URL }), null, null, deps)
    expect(reply?.status).toBe(200)
    const shots = (reply?.body as { shots: ReturnType<typeof shotsOf> }).shots
    expect(shots.pairs[0]).toMatchObject({ before: { url: 'https://github.com/a.png', where: 'the description' }, after: { url: 'https://github.com/b.png', where: 'a comment by ada' } })
  })

  test('a conversation that cannot be read still leaves the description', async () => {
    const runner = fake((run) => (pathOf(run).startsWith('repos/o/r/issues/') ? undefined : githubReads(run)))
    const deps: Deps = { run: runner.run, now: () => 'now', id: () => 'c' }
    const reply = await answer('GET', '/api/shots', new URLSearchParams({ url: GH_URL }), null, null, deps)
    expect(reply?.status).toBe(200)
    expect((reply?.body as { unread?: string }).unread).toContain('comments could not be read')
  })
})
