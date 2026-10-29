# Review

The review of the selected pull or merge request, as one document: a verdict
and a summary, points on exact lines with their evidence, the screenshots, logs
and test output collected for them, and replies to the comments you received —
sent once, by you. With the review skills `/review-pass`, `/review-point` and
`/review-reply`, and the MCP tools they use.

An app: its own page, its own port, its own store. A Kehikot host may frame it,
and then it knows which change is selected.

```
./run.sh                 # or: PORT=8000 ./run.sh
bun run register         # tell a host on this machine where it answers
bun test && bun run typecheck
```

## What it is

One container. Something else on the canvas — References, Journeys, anything —
selects a pull request or merge request; this shows **the review of it**, read
top to bottom:

1. **Verdict and summary**, with a review run's proposal beside them and its
   "To get this approved:".
2. **Points**, each a card: its code reference (`src/app.ts:40-42@f982d895`),
   who wrote it and where it stands (draft, kept, sent, resolved), the quoted
   code, its words, severity, evidence, the challenge and the ruling, the
   screenshots and logs attached to it, and Edit, Keep and Remove.
3. **Evidence**: screenshots, run logs and test output kept beside the review.
4. **Replies**, on a change you authored: one per thread you received.
5. **Send**, in two presses.

Review draws no diff. **Source** shows the file at the change's head, and
**Diff** shows the old and the new — at the place a point names (see "Source
and Diff"). The server still checks every point against the change's real diff
when it is written.

A person writes points on the page. An agent can write them too, over MCP, and
Review provides the skills that make it write them well (see "The review
skills"). **Only the person sends**, only what they kept, and only after reading
exactly what will be posted — except a review run Factory sends for a two-way
change that touches nothing people see, through a door of its own (see
"Factory's send").

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
  whichever side it was asked on. The lines are identical, and a tracker can place
  a new-side comment where it often cannot place an old-side one. An old-side
  anchor is therefore always about something that was removed.
- A comment is **never moved**. If the change is pushed to, a whole-change
  comment written against the old head keeps its commit and its code reference,
  and its card says it was written against an older commit. It is sent against the commit it was written
  on.
- A whole-change comment aimed at a head the change has already moved past is
  refused when it is written, not re-aimed.

On the page a point is written at a place: the one somebody asked for a comment
at in Source or Diff ("New point at src/app.ts:42"), or a file and lines typed
after **New point…**. Either way it is a line of the whole change at its head.

## The review file

One Markdown file per change, inside the project:
`<project>/.kehikot/review/<key>.md`, with its evidence in
`<project>/.kehikot/review/<key>/`. The key is a readable slug of the repository
plus eight hex characters of a hash over the exact forge, host, repository and
number — the slug is for a person looking in the folder, the hash is what stops
`a.b/c` and `a-b/c` from sharing a file.

It is the source of truth, written to be read and to diff well in git, and read
back by a strict reader (`review/md.ts`): writing a review and reading it back
gives the same review, and writing that again gives the same bytes. A file the
reader did not write is refused with the line it stopped at, and nothing is
written over it.

````markdown
---
review: 1
change: https://github.com/o/r/pull/46
head: f982d895148c2dd49f71ccbaa31ee0d829e8ae8f
verdict: request-changes
verdict-by: person
door: two-way
uiux: no
status: draft
---

# Review of o/r#46

## Summary

```text summary
One thing blocks this; the rest reads well.
```

### Proposed by run review-pass

- Verdict: request-changes
- Head: f982d895148c2dd49f71ccbaa31ee0d829e8ae8f
- At: 2026-10-22T10:00:00.000Z

```text proposal
The parser drops the last line.
```

To get this approved:

1. Keep the last line in src/parse.ts:40-42.

## Points

### c-1a2b3c4d5e6f

- Code: src/parse.ts:40-42@f982d895148c2dd49f71ccbaa31ee0d829e8ae8f
- Side: new
- Diff: whole change
- By: agent
- At: 2026-10-22T10:00:00.000Z
- State: kept
- Kept: 2026-10-22T10:05:00.000Z
- Severity: blocking
- Ruling: required
- Reason: Every file without a final newline loses a line.
- Run: review-pass
- Read at: f982d895148c2dd49f71ccbaa31ee0d829e8ae8f
- Evidence: test test/parse.test.ts:12
- Challenge: Files without a final newline are rare. They are not: the fixtures have three.

```text quote
  const lines = text.split('\n').slice(0, -1)
```

```text body
This drops the last line when the file has no final newline. Keep it: …
```

## Evidence

### e-0123456789ab

- Kind: test
- Caption: bun test, before the fix
- File: e-0123456789ab.txt
- Size: 812 bytes
- Point: c-1a2b3c4d5e6f
- By: agent
- At: 2026-10-22T10:01:00.000Z

[e-0123456789ab.txt](gh-o-r-46-f11bf733/e-0123456789ab.txt)

## Replies

None.

## Sent

None.
````

- **Values** are `- Key: value` lines in a fixed order. A value that is not one
  plain line (a newline, a backslash, a quote first, a space at an end, nothing)
  is written as a JSON string, so nothing is guessed on the way back.
- **Words** — a point's text, the quoted code, a summary, a reply — are fenced
  blocks whose fence is longer than any run of backticks inside, so whatever the
  words say they cannot close their own block.
- **The code reference** is link-like: `path:line@commit`, or
  `path:first-last@commit`.
- **State** is `draft`, `kept`, `sent` or `resolved`, and agrees with the lines
  under it (`Kept:`, `Sent:`, `Resolved:`), or the file is refused.

The page re-reads the review when this app's server says it changed (every
write — the page's, an agent's, Factory's send — and a hand edit of the file,
over one held stream that is closed while the page is hidden) and when the
window regains focus, so a point an agent adds appears at once, without a
reload. It never re-reads on a clock. Bounds: 10,000
characters a point, 20,000 the summary, 200 unsent points, 200 lines a range,
60 pieces of evidence (a screenshot at most 10 MB, a log 1 MB).

**The JSON drafts of 1.0.0** are moved over the first time they are read: read
as before, written as Markdown, read back and compared; only when the two say
exactly the same is `<key>.json` renamed to `<key>.json.bak`, which nothing reads
again and which can be deleted once you are satisfied. If they differ, nothing is
written and the JSON stays as it was.

## Source and Diff

A point's code reference is a place in the change's code (protocol 2.13.0,
`location:set`). Pressing it calls `location.set` with intent `show` — the change
as the canvas selection spells it (`gh#46`), the file, the first and last line,
the side, and the commit the lines are counted at (the head for a new-side line
of the whole change; none for a removed line, which counts on the base) — and
Source opens the file there while Diff scrolls to it. The change on the page is
always one of the selected changes, so there is nothing to select first; a press
the host did not take says why, on the card.

The other way round, Review reacts to `context.location`: when somebody asks for
a comment at a place in the change on the page (intent `comment`), it opens
"New point at path:line" with that place, once per ask (`at` is new on every
ask), never for its own pointing. The page also tells its own server what it has
open and where somebody points, in memory, for an agent's `read_focus`.

## The review skills

Review provides the skills a proper review needs (`declares.skills`, served at
`/kehikot/skills/<name>.md` with this module's origin filled in, installed from
Kehikot's Skills window). Each is `disable-model-invocation: true` — only a person
runs it, by typing it — and its `allowed-tools` names exactly the Review tools it
calls: no shell, no `gh`, no `glab`, no file writes. None of them can send.

| skill | what it does | may call |
| --- | --- | --- |
| `/review-pass [ref]` | One careful single-agent review of the picked change, by the rules of `/review-factory`: anchored, sourced, short, plain; one issue one point; its own strongest challenge and ruling on each; every checklist item answered; the path to success; approves when nothing blocks. Writes points (`run: review-pass`), evidence and a proposal. | `read_focus`, `read_change`, `read_diff`, `read_review`, `read_review_md`, `add_comment`, `add_evidence`, `propose_review`, `drop_run_comments` |
| `/review-point [path:line] [about]` | ONE well-sourced point at the place somebody is pointing (from `read_focus`) or the one given. | `read_focus`, `read_diff`, `read_review`, `add_comment` |
| `/review-reply [ref]` | For a change you authored: a reply per thread you received, and what to change. You post them from the page. | `read_focus`, `read_change`, `read_diff`, `read_review`, `read_threads`, `draft_reply` |

**`needs`: none.** None of the three needs another module on the kehikko:
Source and Diff are where a person follows a code reference, and Checklist is
where a checklist may be held — welcome, not required. So none is kehikko-bound,
and each is offered wherever Review is installed.

## What sending does

**Send review…** first shows what will be posted — how many points (and how
many of them an agent drafted and you kept), how many agent points you have not
kept and that stay behind, to which change on which tracker, under which login,
with which verdict — and posts on a second press. The request carries the
point ids, verdict and summary that were shown, and the server sends exactly
those or nothing: if the review changed in between, it refuses.

**Only what the person decided is sent**: their own points, and an agent's that
they kept (pressed **Keep**, or edited its words). The server refuses any other
id. A kept point is the person's from then on: no agent may reword or drop it,
and a re-run does not replace it.

Only unsent points are sent. A sent point can be marked **resolved** (and opened
again) once its author dealt with it. Each is stamped `sent` in the draft the moment
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
`propose_review`, `drop_run_comments`, and since 1.1.0 `add_evidence`,
`read_review_md`, `read_focus`, `read_threads` and `draft_reply`. Each takes the absolute `project`
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
comment the person wrote or a point the person kept, and `set_verdict` cannot replace a summary or a
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
  agent** comments the person has not kept, with the evidence an agent collected
  for that run or attached to them, and nothing else — not the person's comments
  or evidence, not a kept or sent one, not another run's, not the summary or the
  verdict.

### Evidence, focus, the file, and replies

- `add_evidence({ project, change, kind: 'screenshot'|'log'|'test', path | text, caption, point?, run? })`
  copies a screenshot (PNG, JPEG, GIF or WebP by its bytes, at most 10 MB) or a
  log or test output (UTF-8 text, at most 1 MB) into the review's folder under a
  name this module makes (`e-<12 hex>.<ext>`), and lists it in the Evidence
  section, on its point when it names one. A `path` is read only from inside the
  project or the system's temporary folder. The page shows a screenshot small on
  its point and full size when pressed, and a log as text; the files are served
  as a picture or plain text, `nosniff`, never as a page.
- `read_review_md` prints the review file itself.
- `read_focus({ project })`: the change the page has open and where somebody is
  pointing in it, with the `add_comment` arguments for that place.
- `read_threads` reads the review comments a change received, as threads
  (GitHub: each review comment's thread, and the conversation; GitLab: each
  discussion), and says who the tracker is signed in as and who wrote the change.
- `draft_reply({ thread, body, todo? })` keeps one reply per thread in the
  review's Replies, never over the person's. The person reads, edits and posts
  each from the page (**Post reply…**, then **Post it**): the reply goes to its
  thread under their login, exactly as shown, or nothing is posted.

**There is no tool that sends.** Nothing an agent does through this door
reaches a tracker, a reply included. The page's send wants a ticket only the page holds, and
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

- It does not show other people's review comments on the page; on a change you
  authored, `read_threads` reads them for `/review-reply`, and replies are posted
  one at a time. GitHub's REST answer does not say whether a thread is resolved.
- The first 100 commits of a change, and the first 100 review comments,
  discussions and conversation comments. An agent can still write a point in
  one commit's own diff (`add_comment` with `commit`); the page writes points on
  the whole change.
- The page's focus (`read_focus`) is in memory: after a restart it is empty until
  the page reports again.
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

The review file is tested as a round trip (write, read, the same review, the
same bytes) and against the files the strict reader must refuse; the move from
JSON, evidence kept and refused, whose words are whose, the new tools and the
replies' send are tested through the doors; the page is rendered against a plain
host, pointing (`location.set`) and "comment here" included. The skills were run
in the real `claude`, with a scratch home and config, a stand-in model API and
this module's own doors: each may call its own Review tools without a prompt,
and is refused another Review tool, a shell command that writes, or `gh`.

## Layout

```
forge/locate.ts     a tracker URL -> { forge, repo, number, host }, whitelisted
forge/run.ts        the Runner: gh/glab, argv array, no shell, body on stdin
forge/read.ts       describe, commits, diff (cached), GitLab commit JSON -> patch
review/shape.ts     what a review is, and its bounds
review/md.ts        the review as Markdown: the writer and the strict reader
review/anchor.ts    the anchoring rule, pure
review/draft.ts     what may happen to a review, pure (and the 1.0.0 JSON reader)
review/key.ts       the file name a change's review is kept under
review/send.ts      the plan (pure) and the executor
review/print.ts     a diff and a draft as text for an agent
review/shots.ts     the Before / after pictures: found, labelled, allowed, paired (pure)
factory/key.ts      the Review–Factory key
factory/door.ts     Factory's send: its rules and its middleware
forge/threads.ts    the review comments a change received, and posting a reply
store.ts            <project>/.kehikot/review/<key>.md and <key>/, and the move from JSON
evidence.ts         what may be kept as evidence, and from where
focus.ts            what the page has open and where somebody points, for read_focus
skills.ts           the skills, served with the origin filled in (plugin/skills/*/SKILL.md)
doors.ts            /api for the page, /mcp for agents, the skills' text
src/live/           what the selected refs are, from the host's tracker reading
src/diff/           the unified-diff parser the server checks points with
src/view/           the review document, its points, evidence and replies
```
