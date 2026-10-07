import { createHash } from 'node:crypto'

import type { Target } from '../forge/locate.ts'

/**
 * The file name a change's draft is kept under.
 *
 * It has to satisfy the protocol's `DATA_FILE` — lowercase letters, digits and
 * dashes, at most 64 characters — and it is built from a repository path,
 * which satisfies none of that: `Group/Sub.Project` has capitals, a slash and
 * a dot. So the readable part is a LOSSY slug, and lossy means collisions:
 * `a.b/c` and `a-b/c` are different repositories that slug to the same word.
 *
 * Hence the hash. Eight hex characters of SHA-256 over the exact forge, host,
 * repository and number go on the end, so two changes share a file only if
 * they are the same change. The slug is there for a person looking in the
 * folder; the hash is there for correctness; neither is trusted to do the
 * other's job.
 */
export function keyOf(target: Target): string {
  const exact = `${target.forge}|${(target.host ?? '').toLowerCase()}|${target.repo}|${target.number}`
  const hash = createHash('sha256').update(exact).digest('hex').slice(0, 8)
  const slug = target.repo
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 38)
    .replace(/-+$/, '')
  return `${target.forge === 'github' ? 'gh' : 'gl'}-${slug || 'repo'}-${target.number}-${hash}`
}
