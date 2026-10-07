import { spawn } from 'node:child_process'

/**
 * Running `gh` or `glab`, and nothing else, with no shell.
 *
 * ## Why a subprocess and not an API call
 *
 * This app holds no token and must not. The person running it is already logged
 * in to `gh` and, where there is a GitLab, to `glab`; those two programs own the
 * credential, refresh it, and know about enterprise hosts, SSO and proxies. It
 * matters more here than in Diff, which only reads: a review is posted UNDER
 * SOMEBODY'S NAME, and the only honest way for it to carry that name is for the
 * program that holds their login to be the one that sends it.
 *
 * ## The argument list is an array, and a body never rides in it
 *
 * `spawn(cmd, [args], { shell: false })`. A repository path, a number and a sha
 * come out of a URL a tracker wrote; each is whitelisted where it is read
 * (`locate.ts`, `SHA` in `read.ts`), and the array is what makes that a second
 * line of defence instead of the only one. There is no parser between here and
 * `execve`.
 *
 * A comment's text is the one thing here a stranger writes at length, so it is
 * never an argument at all. It goes to the CLI on STDIN as JSON
 * (`--input -`): an argument can be mistaken for a flag and a `-f body=@file`
 * can be made to read a file, and a byte on stdin can be neither.
 *
 * ## A Runner is a value, so nothing has to be spawned to test anything
 *
 * Every function that reads or posts takes a `Runner`. The real one is `run`
 * below; the tests hand in a function that records the argv it was given and
 * answers from a fixture. That is also the guarantee that building this module
 * never posted a review anywhere: the send path has only ever been driven by a
 * fake.
 */

/** The only two programs this module will start. A type, so a third is a compile error. */
export type Cli = 'gh' | 'glab'

export interface Run {
  cmd: Cli
  args: string[]
  /** Written to the child's stdin and then closed. Absent means stdin is not opened at all. */
  stdin?: string
  /** Added over this process's environment for the one call. `GITLAB_HOST` is the only use. */
  env?: Record<string, string>
  timeoutMs?: number
  /** Past this many bytes of stdout the child is killed and what arrived is returned, marked. */
  maxBytes?: number
}

export type Ran =
  | { ok: true; text: string; truncated: boolean }
  | {
      ok: false
      /** A sentence for a person: the CLI's own words where it said any. */
      error: string
      /**
       * The HTTP status the CLI reported, when it reported one.
       *
       * Both `gh api` and `glab api` end their stderr with `(HTTP 422)`. It is
       * read out because one decision turns on it — whether a rejected comment
       * is a comment the tracker would not PLACE (fold it into the summary) or
       * a send that failed (stop, and say so). See `review/send.ts`.
       */
      status: number | null
      /** What the CLI printed on stdout before failing: the API's JSON error body, usually. */
      text: string
    }

export type Runner = (run: Run) => Promise<Ran>

/** How long either CLI gets before this gives up on it. */
export const RUN_TIMEOUT_MS = 25_000

/**
 * How much of one answer is read into memory by default.
 *
 * Eight megabytes is far past any diff a person is going to review and far
 * short of what would trouble this process. What it stops is a change that
 * regenerates a lockfile or vendors a dependency tree.
 */
export const MAX_BYTES = 8_000_000

/** The status out of `gh: Validation Failed (HTTP 422)`. Pure, so the fake runner's errors can be built the same way. */
export function statusOf(stderr: string): number | null {
  const m = /\(HTTP (\d{3})\)/.exec(stderr)
  return m ? Number(m[1]) : null
}

/**
 * The sentence for a failed call.
 *
 * The CLI's stderr first, because "gh auth login" is worth more to the person
 * reading than any paraphrase. Then the API's own `message` out of the JSON
 * body when there is one, because for a rejected review that is where the
 * tracker says WHY ("Can not approve your own pull request") and stderr only
 * says "Validation Failed". Bounded: this is a sentence, not a document.
 */
export function failureText(cmd: string, stderr: string, stdout: string, code: number | null): string {
  const said = stderr.trim()
  let detail = ''
  try {
    const parsed: unknown = JSON.parse(stdout)
    if (parsed && typeof parsed === 'object') {
      const body = parsed as { message?: unknown; errors?: unknown; error?: unknown }
      const parts: string[] = []
      if (typeof body.message === 'string') parts.push(body.message)
      else if (body.message !== undefined) parts.push(JSON.stringify(body.message))
      if (typeof body.error === 'string') parts.push(body.error)
      if (Array.isArray(body.errors)) {
        for (const one of body.errors.slice(0, 5)) parts.push(typeof one === 'string' ? one : JSON.stringify(one))
      }
      detail = parts.join(' — ')
    }
  } catch {
    /* Not JSON: stderr is all there is. */
  }
  const whole = detail && !said.includes(detail) ? (said ? `${said} ${detail}` : detail) : said
  return whole.slice(0, 700) || `${cmd} exited ${code} without saying why.`
}

/**
 * Run one CLI and hand back what it printed.
 *
 * Never throws. A missing binary, an expired login, a repository that is not
 * there, a timeout: each comes back as `{ ok: false }` with a sentence.
 *
 * Not retried. A read that failed is a sentence beside a "try again"; a POST
 * that failed must never be repeated by a loop that cannot know whether the
 * first one landed.
 */
export const run: Runner = ({ cmd, args, stdin, env = {}, timeoutMs = RUN_TIMEOUT_MS, maxBytes = MAX_BYTES }) =>
  new Promise((resolve) => {
    let child
    try {
      child = spawn(cmd, args, {
        /* Said out loud, because it is the whole argument of this file and a
           default is not a statement. */
        shell: false,
        env: { ...process.env, ...env },
        stdio: [stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      })
    } catch (e) {
      resolve({ ok: false, status: null, text: '', error: `${cmd} could not be started: ${e instanceof Error ? e.message : String(e)}` })
      return
    }

    const out: Buffer[] = []
    let size = 0
    let truncated = false
    let err = ''
    let done = false

    const finish = (result: Ran) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(result)
    }

    /* Killed rather than waited on: `spawn` does not time out on its own, and a
       CLI stuck on a network that is not there would hold the request with no
       sentence saying why. */
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish({ ok: false, status: null, text: '', error: `${cmd} did not answer within ${Math.round(timeoutMs / 1000)} seconds.` })
    }, timeoutMs)

    if (stdin !== undefined && child.stdin) {
      /* A child that exits before reading (a bad flag, no login) closes the pipe
         under the write; without a listener that EPIPE is an unhandled error
         that takes the whole server down over one failed call. */
      child.stdin.on('error', () => {})
      child.stdin.end(stdin)
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      if (truncated) return
      size += chunk.length
      out.push(chunk)
      if (size > maxBytes) {
        /* Kept up to the cap rather than thrown away: the first eight megabytes
           and a sentence is something, an error is nothing. */
        truncated = true
        child.kill('SIGKILL')
      }
    })
    /* Bounded and much smaller: this is a sentence for a person. */
    child.stderr?.on('data', (chunk: Buffer) => {
      if (err.length < 4000) err += chunk.toString('utf8')
    })

    child.on('error', (e: Error) => {
      finish({
        ok: false,
        status: null,
        text: '',
        error:
          (e as NodeJS.ErrnoException).code === 'ENOENT'
            ? `\`${cmd}\` is not installed on this machine, or is not on this server's PATH. It is what holds the login, so nothing here can read or post without it.`
            : `${cmd} could not be run: ${e.message}`,
      })
    })

    child.on('close', (code) => {
      const text = Buffer.concat(out).toString('utf8')
      /* A kill for truncation exits non-zero and is not a failure: we asked. */
      if (truncated) return finish({ ok: true, text, truncated: true })
      if (code === 0) return finish({ ok: true, text, truncated: false })
      finish({ ok: false, status: statusOf(err), text: text.slice(0, 20_000), error: failureText(cmd, err, text, code) })
    })
  })
