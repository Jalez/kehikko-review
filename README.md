# Review

Review the selected pull or merge request: comment on exact lines of the whole
change or of one commit, then send it all as one review with a verdict.

An app: its own page, its own port, its own store. A Kehikot host may frame it,
and then it knows which change is selected.

```
./run.sh                 # or: PORT=8000 ./run.sh
bun run register         # tell a host on this machine where it answers
bun test && bun run typecheck
```

## What it is

One container. Something else on the canvas — References, Journeys, anything —
selects a pull request or merge request; this shows its diff, with every line a
place a comment can go, and a panel holding the review being written. A person
writes comments on the page. An agent can write them too, over MCP. **Only the
person sends**, and only after reading exactly what will be posted — except a
review run Factory sends for a two-way change that touches nothing people see,
through a door of its own (see "Factory's send").

It holds no token. Everything it reads and everything it posts goes through
`gh` or `glab` on this machine, run from this app's own server with no shell,
because those two programs already own the login. A review is posted under the
name of whoever is logged in to them, which is the point.

## Which change

A selection is refs and nothing else — `['gh#46']`, `['!3105']`. A ref does not
say whether it is an issue or a change, which repository it is in, or where its
page is. So the page asks the host `tracker.get { refs, detail: 'detail' }`
(capability `trackers:read`) and reads each ref's `kind`, `url`, title and
state from the row that comes back. A first answer is often "not read yet"; the
page asks again when `context.tracker.at` moves, and gives up — in words — once
a read has landed without the ref.

Review works on **one change at a time**: the first selected ref that is a
change, with a row of buttons when several are. Every other state has its own
sentence: nothing framing the page, nothing selected, an issue selected, a ref
the tracker has never heard of, a host that will not answer.

The head commit is **not** taken from the host's reading. That is a snapshot,
and the head is what a comment is anchored to and what an approval approves; so
this app asks the forge itself, and asks again just before sending. The head in
the host's reading is used only as a hint that somebody pushed.

## How anchoring works

A line number only means something inside one particular diff. The same file
has different numbers in the diff of the whole change and in the diff of each
commit. So every comment records the **frame** it was written in:

| view | the diff | `commit` is |
| --- | --- | --- |
| `all` | base..head, everything the change does | the **head the change had** when the comment was written |
| `commit` | parent..commit, what one commit did | **that commit** (its first parent is recorded beside it) |

plus the file, the **side** (`new` or `old`: which column of line numbers), the
line, and optionally the first line of a range.

**The server checks every anchor when the comment is written**, whether it came
from the page or from an agent. It fetches the diff of exactly that view,
parses it, and requires every line of the range to be in it, on that side, in
one hunk. A comment that does not point at real lines is refused with the
reason — no such file in this diff, line not in the diff (and "it is on the
other side" when it is), range crosses hunks. What is stored carries the text
of the lines as `quote`.

Three consequences worth knowing:

- A range that is entirely unchanged context is recorded on the **new** side
  whichever gutter was pressed. The lines are identical, and a tracker can place
  a new-side comment where it often cannot place an old-side one. An old-side
  anchor is therefore always about something that was removed.
- A comment is **never moved**. If the change is pushed to, a whole-change
  comment written against the old head keeps its commit; it is no longer drawn
  on today's lines (they are other lines), and the review panel marks it as
  written against an older commit. It is sent against the commit it was written
  on.
- A whole-change comment aimed at a head the change has already moved past is
  refused when it is written, not re-aimed.

On the page: press a line number to comment on that line; shift-press another
number in the same column of the same file to cover a range.

## The draft

One JSON file per change, inside the project:
`<project>/.kehikot/review/<key>.json`. The key is a readable slug of the
repository plus eight hex characters of a hash over the exact forge, host,
repository and number — the slug is for a person looking in the folder, the
hash is what stops `a.b/c` and `a-b/c` from sharing a file.

The page re-reads the draft when the window regains focus and every twenty
seconds, so a comment an agent adds appears without a reload. Bounds: 10,000
characters a comment, 20,000 the summary, 200 unsent comments, 200 lines a
range.

## What sending does

**Send review…** first shows what will be posted — how many comments (and how
many an agent drafted), to which change on which tracker, under which login,
with which verdict — and posts on a second press. The request carries the
comment ids, verdict and summary that were shown, and the server sends exactly
those or nothing: if the draft changed in between, it refuses.

Only unsent comments are sent. Each is stamped `sent` in the draft the moment
its request succeeds, so a send that stops half way leaves the draft saying
truthfully what is on the tracker, and pressing Send again sends only the rest.
A failure that is not a placement refusal **stops** the send; the verdict is
never posted after the comments explaining it failed.

A comment the tracker will not attach to its line is not lost. It is **folded**:
written into the review's summary as text, with its file, line, commit and the
quoted source, and marked `folded` so the page says where it went.

### GitHub

`POST repos/{repo}/pulls/{n}/reviews`, with `{ commit_id, event, body, comments:
[{ path, line, side, start_line?, start_side?, body }] }`.

A review has one `commit_id`, so comments are grouped by the commit they
address. Groups for commits other than the head go first, each as a `COMMENT`
review; the final review is at the head and carries the verdict
(`APPROVE` / `REQUEST_CHANGES` / `COMMENT`), the summary, and the head's own
comments.

Where a comment goes:

| written in | side | sent as |
| --- | --- | --- |
| whole change at head H | new / old | `commit_id: H`, `RIGHT` / `LEFT` |
| commit C | new | `commit_id: C`, `RIGHT` — line L of the file at C |
| commit C | old, C's parent P is a commit of the pull request | `commit_id: P`, `RIGHT` — the line C removed exists in P |
| commit C | old, P is the merge base (C is the first commit) | `commit_id: C`, `LEFT` |

GitHub accepts a line only if it is inside **its** diff for that `commit_id`,
which is merge-base..commit, not the commit's own diff. Most lines a commit
touched are in both; some are not (a commit that restores a line to what the
base had; a removed line the base already had). GitHub answers 422 for the
whole review, and that group is folded into the final review's body. If the
final review is itself refused with comments in it, it is tried once more with
those comments folded; if it is refused again the reason is something else
(GitHub does not let anybody approve their own pull request) and is reported in
GitHub's words.

GitHub requires a summary with a request for changes; the page says so before
anything is posted.

### GitLab

No batch: one `POST projects/{id}/merge_requests/{n}/discussions` per comment,
with `position: { position_type: 'text', base_sha, start_sha, head_sha,
old_path, new_path, new_line and/or old_line }`.

- A whole-change comment uses the merge request's `diff_refs` — or, when it was
  written against an older head, the three commits of that diff version
  (`…/versions`), and is folded if GitLab no longer lists it.
- A commit-view comment uses `(parent, parent, commit)` and `commit_id`.
- An added line sends `new_line`, a removed line `old_line`, an unchanged line
  both.
- A multi-line comment is anchored at its **last** line; `line_range` wants a
  line code per end. The quote still shows the whole range.

Then the summary as a note (`…/notes`), with anything folded. Then, for
*approve*, `POST …/approve` with the head sha, so GitLab refuses if somebody
pushed in between.

**Request changes** sets no reviewer state on GitLab: the summary note is
prefixed "**Changes requested.**" and the result says GitLab was not asked to
set a state. The summary is cleared from the draft the moment it is posted, so
that if the approval after it fails, a second press does not post it twice.

## For agents: the MCP door

`/mcp`, with `list_reviews`, `read_review`, `read_change`, `read_diff`,
`add_comment`, `reword_comment`, `drop_comment`, `set_verdict`,
`propose_review`, `drop_run_comments`. Each takes the absolute `project`
(`projectPath`, its name before, is still read) and the change — its tracker
URL, or for a change that already has a draft, `owner/repo#12` /
`group/project!12`.

`read_diff` prints the old and the new line number beside every line, because a
unified diff does not contain line numbers and counting them from a hunk header
is where a model goes wrong. `add_comment` takes the numbers it prints: leave
`commit` out for a line of the whole change, give it for a line of that
commit's own diff. Comments are marked as written by an agent.

`read_change` also says who reviews the change and who approved it —
`Reviewers: cy (asked), ada (approved), bo (changes requested)` and
`Approvals: 1 — ada` (on GitLab with how many are required and still needed) —
read from the forge itself: GitHub's `requested_reviewers` and the latest
decision per login from `…/pulls/{n}/reviews`; GitLab's `reviewers` and
`…/merge_requests/{n}/approvals`. When that read fails, the rest of the change
is still printed, with the reason.

**What is the person's stays the person's.** An agent cannot reword or drop a
comment the person wrote, and `set_verdict` cannot replace a summary or a
verdict the person set (the draft records who set each; a summary in a draft
from before that is read as the person's). An agent may change its own.

### Review runs (Factory's `/review-factory`)

- `add_comment` takes an optional `meta` for a point a run wrote:
  `{ run, severity: 'blocking'|'risk'|'nice', evidence: [{ kind: 'line'|'test'|'doc'|'practice', ref, quote? }] (at least one), challenge?, ruling: 'required'|'optional', reason, checklist? }`.
  It is checked before anything is read, kept with the head the forge named
  when the comment was written, shown beside the comment on the page and in
  `read_review`, and never posted.
- `propose_review({ run, summary, verdict, door: 'one-way'|'two-way', uiux, pathToSuccess })`
  keeps a run's summary and verdict **beside** the person's, never over them.
  A newer run's proposal replaces an older one. A request for changes needs at
  least one step in `pathToSuccess`, which the page shows (and a send posts)
  as "To get this approved:" and a numbered list. On the page the person can
  press **Use this summary** (it asks first when their box has words) or
  **Use this verdict**.
- `drop_run_comments({ run })`, before a re-run: drops that run's **unsent
  agent** comments and nothing else — not the person's comments, not a sent
  one, not another run's, not the summary or the verdict.

**There is no tool that sends.** Nothing an agent does through this door
reaches a tracker. The page's send wants a ticket only the page holds, and
Factory's send (below) wants a key no agent is given.

## Factory's send

The one send that is not the person's: Factory posting a review run, for a
change the person said may be reviewed without them.

```
POST /api/factory/send           { project, change, run }
X-Kehikot-Factory-Key: <the key>
```

- **The key** is 32 random bytes as hex in `review-factory.key`, in
  `KEHIKOT_KEYS_DIR` or `~/Library/Application Support/Kehikot/keys/` (the XDG
  data dir off macOS). Review makes it on its first start, mode 0600 in a
  folder made 0700; a file others can read is closed to them before use, and a
  link, a folder or another user's file is refused. It is compared in constant
  time and printed nowhere.
- **Who reaches it.** Without the header it is not a route: the request goes on
  to the page's doors, which answer 404 (they refuse every `/api/factory/*`,
  ticket or not). With it, a browser — another origin, or this app's own page —
  is refused (403); only a program (no `Origin`, no `Sec-Fetch-Site`) gets as
  far as the key. It is answered by its own middleware (`factory/door.ts`),
  placed before the protocol's doors because it needs a header they do not
  pass on.
- **What it sends.** That run's unsent comments and its proposal's summary
  (with "To get this approved:") and verdict. Never the person's comments,
  summary or verdict, which stay in the draft as they were. The proposal is
  marked sent, and the send is filed in the draft's history as Factory's.
- **What it refuses**, with a sentence and nothing posted: no key file (503); a
  wrong key (403); a body without project, change and run (400); a run with no
  proposal, another run's proposal, or one already sent (409); a **one-way**
  change (409); a change that touches **what people see** (409); required
  points under any verdict but a request for changes (409); a change that is
  not open (409); a change whose **head moved** after the run read it — any of
  its comments or its proposal (409); a send of the same change already under
  way, through either door (409).

## Before / after

The View switch has **Before / after**: the pictures posted in the change's
description and comments (markdown `![…](…)` and HTML `<img>`), labelled by
the words next to them — the alt text, "before"/"after" just before the image,
or a header row naming both (`| Before | After |`, `<th>`) — and paired, before
beside after. What has no partner is shown alone.

Only `https:` images on the forge's own hosts are shown: github.com and
`*.githubusercontent.com`, or the GitLab host the change is on (with its
`/uploads/…` paths made absolute under the project). Anything else —
`http:`, `data:`, `javascript:`, another host, an address with a login or a
port — is not loaded and not linked; it is said in words, with its host and
why. The page checks every address again before it makes an image of it, loads
it with no referrer, and its "open" link only opens it in a new tab. A private
repository's pictures need the person signed in to the forge in this browser;
when one does not load, the view says so.

## Limits

- New comments only. It does not show other people's comments or existing
  threads, and cannot reply to one.
- The first 100 commits of a change. More are flagged, not listed, and a
  comment cannot be written in the view of a commit that is not listed.
- A diff over 8 MB is cut off and says so; on GitLab a single commit touching
  more than 100 files is read for its first 100.
- GitHub Enterprise is not addressed: `locate` reads `github.com` URLs and any
  GitLab host. Self-hosted GitLab works through `glab`'s own login for that
  host.
- Binary files, pure renames and files with no printed lines have no line to
  comment on; say it in the summary.
- "Request changes" on GitLab is words, not a state. Suggestions, image
  comments and file-level comments are not written.
- The diff cache is keyed by change, view and commit, in memory. A push landing
  between this app reading the head and reading the diff can file the new diff
  under the old head until the process restarts.
- The module registers nothing by itself: `bun run register` is a person's
  decision.
- Reviewer states on GitLab are "asked" or "approved": its REST answer does not
  say "changes requested".
- The Before / after view reads the first 100 comments, lists at most 60
  pictures, and pairs by words; an image no words label is shown unpaired.

## How it is tested

`bun test` runs every function that talks to a tracker against a runner that
starts nothing (`test/fake.ts`): the command lines are asserted as arrays, and
the send path as the exact JSON it would post. Factory's send is tested refusal
by refusal with nothing posted, and the key lives in a scratch folder
(`KEHIKOT_KEYS_DIR`, set by `test/setup.ts`). **No review, comment, approval
or note was posted to a real tracker to build or test this.** The read
endpoints were run against real public changes.

## Layout

```
forge/locate.ts     a tracker URL -> { forge, repo, number, host }, whitelisted
forge/run.ts        the Runner: gh/glab, argv array, no shell, body on stdin
forge/read.ts       describe, commits, diff (cached), GitLab commit JSON -> patch
review/shape.ts     what a draft is, and its bounds
review/anchor.ts    the anchoring rule, pure
review/draft.ts     what may happen to a draft, pure
review/key.ts       the file name a change's draft is kept under
review/send.ts      the plan (pure) and the executor
review/print.ts     a diff and a draft as text for an agent
review/shots.ts     the Before / after pictures: found, labelled, allowed, paired (pure)
factory/key.ts      the Review–Factory key
factory/door.ts     Factory's send: its rules and its middleware
store.ts            <project>/.kehikot/review/<key>.json
doors.ts            /api for the page, /mcp for agents
src/live/           what the selected refs are, from the host's tracker reading
src/diff/           the unified-diff parser, and how much is drawn at first
src/view/           the diff with targets, comments, the review panel
```
