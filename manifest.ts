import { MANIFEST_KIND, PROTOCOL, manifestSchema, type Manifest } from 'kehikot-module-protocol'

export const ID = 'kehikot.review'
export const VERSION = '0.1.0'

/**
 * Where this module would like to answer. Said once, here, and read by
 * `vite.config.ts` and `register.ts`. Modules on this machine sit ten apart
 * from 7820 up, so a drift up from one never lands on a neighbour's number;
 * 7960 is History's and 7970–7990 are taken, so this is the next free ten.
 *
 * A PREFERENCE and not a promise: if something holds it, `serves()` moves to
 * the next free port and rewrites the registration to match.
 */
export const PREFERRED_PORT = 8000

/**
 * What this app says about itself when a host asks.
 *
 * ## `trackers:read`, and only that
 *
 * A selection is refs and nothing else — `['gh#46']`, `['!3105']`. A ref does
 * not say whether it is an issue or a change (GitHub numbers both in one
 * sequence), which repository it is in, or where its page is. The host's
 * shared tracker reading says all three, and `tracker.get` is how a module
 * asks it. Without the capability this page holds a string it cannot turn into
 * an address, and has nothing to review.
 *
 * It is asked with `detail: 'detail'`, the same question Diff asks, so the two
 * modules share one read at the tracker instead of making two; and the head
 * commit in that detail is used as a HINT that the change moved — never as the
 * head a comment is anchored to, which this app reads from the forge itself
 * (see `forge/read.ts` for why a snapshot is not good enough for an approval).
 *
 * Deliberately absent:
 *
 * - **Any capability for reaching GitHub or GitLab.** There is none and there
 *   should be none. The tracker CLIs on this machine hold the person's login;
 *   this app's own server runs them. A host is not involved, and a review is
 *   posted under the name of whoever is logged in to `gh` or `glab` — which is
 *   the point.
 * - **`trackers:refresh`.** That spends the person's rate limit on the whole
 *   project to learn what this app learns for one change by asking the forge
 *   directly.
 * - **`live:read`.** Diff declares it for the kind and URL of a ref. The
 *   tracker reading carries both, for every ref the project names and not only
 *   those of an epic with an imported state file, so there is nothing left for
 *   `live.get` to add here.
 * - **`selection:set`.** This app REACTS to a selection and never makes one.
 *   A module whose job is to answer a question about what is picked has no
 *   business changing what every other container is looking at.
 * - **`state:keep`.** What is worth keeping is the draft, and that is in the
 *   project, not in a host's memory of a frame.
 * - **`stage:report`.** A review is an opinion about a change. Where the work
 *   stands is for whoever is doing it to say.
 *
 * A declaration is not a request and is not answered; the host refuses
 * whatever it likes at every call. So the page is built to be refused, and
 * says so in a sentence when it is (see `src/app.tsx`).
 *
 * ## `prompt: false`
 *
 * Declaring a prompt makes a host offer a box, and offering a box is a promise
 * that what is typed in it changes something. Nothing here would read it: the
 * diff is what the tracker printed and the comments are what somebody wrote.
 * The place to tell an agent how to review is the agent, and what the agent
 * writes arrives through the MCP door as drafts a person can see.
 *
 * ## `storage: true`, and here it is not optional
 *
 * A host frames a module on an opaque origin unless it declares storage. An
 * opaque page's calls to its OWN server are cross-origin, so the server would
 * have to answer with a permissive CORS header — and this server has two doors
 * no stranger's page may open. `/api/diff` spends this machine's tracker login
 * on request, exactly as Diff's does. And `/api/send` POSTS UNDER IT: with a
 * readable `/app`, any website in the browser could lift the write ticket and
 * submit an approval in the person's name.
 *
 * Declaring storage gives the page a real origin, so its calls are ordinary
 * same-origin requests, no CORS header is sent to anybody, and `/app` — and
 * the ticket printed in it — is unreadable from anywhere else. It also happens
 * to be true: this module keeps drafts.
 *
 * The honest caveat is Diff's: this shuts the BROWSER's door, not the socket.
 * Anything already running as this user can find the ticket by fetching `/app`
 * itself. What the ticket separates is "this app's own page pressed Send" from
 * "another page in this browser did", and that door is shut.
 *
 * ## The MCP door has no way to send
 *
 * Not "is asked not to": there is no tool. An agent can read a change, read a
 * diff, and write, reword and drop DRAFT comments and propose a verdict. The
 * only thing that posts is `/api/send`, which wants the page's ticket, and the
 * page puts a confirmation in front of it. A review is a statement made in
 * somebody's name to their colleagues, and the one who makes it is the one who
 * presses.
 */
export const MANIFEST: Manifest = manifestSchema.parse({
  kind: MANIFEST_KIND,
  /* Parsed rather than shipped as a bare object: the cheapest way to learn
     this file says something no host will accept is to fail when it is
     imported. */
  protocol: PROTOCOL,
  id: ID,
  name: 'Review',
  version: VERSION,
  /* The format of what this module keeps under `.kehikot/`. Raise it only in
     the release that first writes data an older release cannot read. */
  dataVersion: 1,
  summary:
    'Review the selected pull or merge request: comment on exact lines of the whole change or of one commit, then send it all as one review with a verdict.',
  /* Where a host files this module in its list, most fitting first. */
  tags: ['review', 'code'],
  /**
   * What this module's PRESENCE obliges an agent to do. Composed into every
   * agent's prompt on the canvas, so it is written to somebody who just
   * arrived and has never seen this app.
   */
  guidance:
    'Review is on this canvas: a person reviews a pull or merge request here, and you can help by drafting. '
    + 'Call `read_change` with the project path and the change’s URL to see its commits, then `read_diff` for the '
    + 'lines; the diff prints an old and a new line number beside every line, and those are what you cite. '
    + 'Use `add_comment` to put a draft comment on a line — give `commit` when you mean a line of one commit’s own '
    + 'diff, leave it out for the whole change — and `set_verdict` to propose a summary and a verdict. '
    + 'Everything you write is a DRAFT in the project, marked as written by an agent. Nothing you do here is '
    + 'posted to GitHub or GitLab: only the person sends a review, from the page, after reading it. So write '
    + 'comments you would stand behind if they were sent as they are, and do not post review comments with '
    + '`gh` or `glab` yourself when a person is reviewing here.',
  entry: '/app',
  modes: [{ id: 'review', label: 'Review', scope: 'epic' }],
  mcp: {
    url: '/mcp',
    transport: 'http',
    about:
      'Read a pull or merge request commit by commit and draft a review of it: comments on exact lines, a summary, a '
      + 'proposed verdict. Drafts stay in the project; nothing here posts to a tracker.',
  },
  extensions: { emits: [], consumes: [] },
  /**
   * `selection`: the selected refs are the whole of what decides which change
   * this page shows. `tracker`: the first answer to `tracker.get` is usually
   * "not read yet", and the reading moving is what says to ask again — and,
   * later, what says the change may have a new head. See `src/live/changes.ts`.
   *
   * A description, not a request: the context arrives whether or not this line
   * exists.
   */
  reacts: ['selection', 'tracker'],
  /* Why this module has nothing to narrow by the parts of an epic. */
  partless: 'Holds a review of the pull request a person selected; narrowing would hide their own selection or a draft in progress.',
  declares: {
    protocol: `>=${PROTOCOL} <${PROTOCOL + 1}`,
    uses: ['trackers:read'],
    storage: true,
    prompt: false,
  },
  health: '/healthz',
})
