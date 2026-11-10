import { MANIFEST_KIND, PROTOCOL, manifestSchema, type Manifest } from 'kehikot-module-protocol'
import pkg from './package.json'
/* This module's introduction (protocol 2.57.0): slides the host shows in its introduction dialog. Also
   read as a file from the repository, so a person can watch it before the module runs or is installed. */
import intro from './intro.json'

import { PREFERRED_PORT } from './port.ts'
import { serveFrom, skillDeclarations } from './skills.ts'

export { PREFERRED_PORT }

import { ID } from './id.ts'

/** "How to use" (protocol 2.52.0). Each string one line of plain text. */
export const HELP = {
  summary: 'The review of the picked pull or merge request as one document: verdict, summary, points on exact lines, evidence and replies. Only you send it.',
  sections: [
    {
      title: 'What it shows',
      points: [
        'The review of ONE change: the first pull or merge request picked on the kehikko, with a row of buttons when several are picked.',
        'Top to bottom: the verdict and summary, with a review run’s proposal beside them; the points, each on exact lines with the quoted code, its words, severity and evidence; the evidence kept beside the review; and replies, on a change you wrote.',
        'Each point says who wrote it and where it stands: draft, kept, sent or resolved.',
        'Before / after, in the View switch, pairs the pictures posted in the change’s description and comments.',
        'Review draws no diff: press a point’s code reference and Source opens the file there while Diff scrolls to it.',
      ],
    },
    {
      title: 'How to use it',
      points: [
        'Pick a pull or merge request in References, Journeys or any other module.',
        'Press New point…, or point at a line in Source or Diff and ask for a comment there.',
        'Keep an agent’s draft point you agree with, or edit or remove it. Once kept or edited it is yours.',
        'Set the verdict and summary, then press Send review…: it shows what will be posted, to which change and under which login. Post it sends; Not yet goes back.',
        'Mark a sent point resolved once its author dealt with it.',
        'Skills, typed in Claude Code: /review-pass for a careful review, /review-point for one point where you are pointing, /review-reply for replies on your own change.',
      ],
    },
    {
      title: 'What agents can do',
      points: [
        'Read which change is open and where you point (read_focus), the change and its diff (read_change, read_diff), and the review (read_review).',
        'Draft points (add_comment), keep evidence beside them (add_evidence), and propose a verdict and summary (set_verdict, propose_review).',
        'Everything an agent writes is a draft. It cannot change what you wrote or kept, and it cannot send.',
      ],
    },
    {
      title: 'Rules',
      points: [
        'Only you send, only what you wrote or kept, and only after seeing exactly what will be posted. If the review changed in between, the send is refused.',
        'It holds no token: it reads and posts through gh or glab on this computer, under whoever is logged in to them.',
        'A point the tracker will not attach to its line is written into the summary instead, never dropped.',
      ],
    },
  ],
}

export { ID }
/** The module's version: package.json's, the one place it is written. A release is tagged with it. */
export const VERSION: string = pkg.version

/**
 * What this app says about itself when a host asks.
 *
 * ## `trackers:read` and `location:set`
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
 * `location:set` (2.13.0): a point's code reference is a place in the change's code, and pressing
 * it says so to the kehikko (`location.set`, intent `show`), so Source opens the file at that line and
 * Diff scrolls there. Review no longer draws a diff of its own. It also reacts to `location`: when
 * somebody asks for a comment at a place (intent `comment`), the page opens a new point there.
 *
 * `state:keep` (2.51.0): the host keeps one value per container — this module on this kehikko —
 * and hands it back in the greeting, so which of the review and Before / after shows is as it was
 * left after a restart. The draft is not in it: that is in the project. Nor is which of several
 * selected changes is open: that is the selection, the subject the host gives, not a way of looking.
 *
 * - **`selection:set`.** This app REACTS to a selection and never makes one. A point's code
 *   reference is always in the change on the page, which is always one of the selected changes, so
 *   there is nothing to select before pointing.
 *   A module whose job is to answer a question about what is picked has no
 *   business changing what every other container is looking at.
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
  /* The icon a host draws beside the name: a key of the protocol's module icons, never a path
     or URL; the same key Kehikot's official list gives it. */
  icon: 'lucide:message-square-code',
  version: VERSION,
  /* The format of what this module keeps under `.kehikot/`. Raise it only in
     the release that first writes data an older release cannot read. */
  dataVersion: 2,
  summary:
    'The review of the selected pull or merge request as one document: verdict, summary, points on exact lines, evidence and replies. You send it.',
  /* Where a host files this module in its list, most fitting first. */
  tags: ['review', 'code'],
  /**
   * What this module's PRESENCE obliges an agent to do. Composed into every
   * agent's prompt on the canvas, so it is written to somebody who just
   * arrived and has never seen this app.
   */
  guidance:
    'Review is on this canvas: a person reviews a pull or merge request here, as one document, and you can help by drafting. '
    + '`read_focus` says which change is open and where somebody is pointing. `read_change`, then `read_diff`: it prints '
    + 'an old and a new line number beside every line, and those are what you cite. `add_comment` drafts a point on a '
    + 'line (give `commit` only for a line of one commit’s own diff), `add_evidence` keeps a screenshot, log or test output '
    + 'beside it, `set_verdict` proposes a summary and verdict. What the person wrote or kept is theirs: you cannot change '
    + 'it. Everything you write is a DRAFT; only the person sends, from the page. Do not post review comments with '
    + '`gh` or `glab` yourself when a person is reviewing here.',
  /* "How to use" (protocol 2.52.0), and the introduction (protocol 2.57.0). */
  help: HELP,
  intro,
  entry: '/app',
  /* What its content belongs to (protocol 2.29.0): one mode per scope, the default first. */
  modes: [
    { id: 'review', label: 'Review', scope: 'part', scopeSays: 'the review of the one change picked out' },
  ],
  mcp: {
    url: '/mcp',
    transport: 'http',
    about:
      'Draft a review of a pull or merge request: points on exact lines, evidence, a summary, a verdict, replies. A Markdown '
      + 'file in the project; nothing here posts to a tracker.',
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
  reacts: ['selection', 'tracker', 'location'],
  /* Why this module has nothing to narrow by the parts of an epic: it has no list. It shows one
     thing, the change somebody selected, with the review they are writing of it — and that is in
     their hands whatever is picked. */
  partless: 'Shows the review of the one change a person selected, which is always in hand.',
  declares: {
    protocol: `>=${PROTOCOL} <${PROTOCOL + 1}`,
    uses: ['trackers:read', 'location:set', 'address:open', 'state:keep'],
    storage: true,
    prompt: false,
    /* The skills this module offers, for the origin it is on (`skills.ts`). */
    skills: skillDeclarations(),
  },
  health: '/healthz',
})

/** Say the origin this process really serves on, once it is listening: the skills' text and version follow. */
export function servingAt(origin: string): void {
  serveFrom(origin)
  const skills = MANIFEST.declares?.skills
  if (skills) skills.splice(0, skills.length, ...skillDeclarations())
}
