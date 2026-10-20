# Review orchestration: accurate code review, out of the box

Date: 2026-10-21. Status: design, awaiting the person's approval of the whole document.

## Why

The person reviews merge and pull requests (their own team's and others') inside
Kehikot, and wants a review that is **accurate first**: right about the code,
right about the lines it points at, and short enough that people read it. They
also want it **transparent**: what was checked, what wasn't, who decided what and
why, and what it cost.

The worst reviews they have received, from people and from AI, did these things,
and this design exists to make them impossible or visible:

- pointed at the wrong lines while explaining something else;
- made claims with no source and did not prove them;
- were long, repetitive, and not in plain language (everyone is juggling many
  things, so nothing is as obvious as the reviewer thinks);
- did not follow the checklist they were given, to the letter, and were not
  transparent about what they did;
- burned tokens on detours, went in circles, and kept finding faults instead of
  serving the actual priority: a bug-free but **steady** release of real
  improvements that fit the existing vision.

## What it is

**Review orchestration lives in Factory, as the `/review-factory` skill**, and
is only offered on a kehikko that has the Factory module. The Review module
(today: read a change's diff, comment on exact lines, the person sends one review
through their own `gh`/`glab`) stays the place where the result lands as a draft
and where the person reads, edits and sends it. Without Factory, Review works as
today (manual review, agents may draft comments over MCP).

The same flow serves two uses:

- **Reviewing a change someone asked you to review**: the panel drafts; you read
  every point, keep, edit or drop it, and send.
- **Reviewing your own or your team's work before asking others**: same, and you
  may choose not to send at all and just act on it.

## Goals

1. Every posted point is **anchored** to lines that actually show the problem,
   **proven** with at least one source, and **plain**: what is wrong, why it
   matters, what to do.
2. The change's **checklist is followed to the letter**: every item gets pass,
   fail or not-applicable with a "how I know" note, visible in the Checklist
   module. If the change has no checklist, the panel **proposes one**, the person
   accepts or edits it, and it is created in Checklist and held against the change.
3. The review **judges fit with the vision**: the epic the change belongs to.
4. **Complete transparency**: a "How this review was made" record per review,
   with each agent's input, output, the judge's ruling on every point with its
   reason, checklist answers, the budget, and what was spent.
5. **Bounded cost**: a budget sized to the change, stated up front, and never
   exceeded silently.
6. References shows **my role** on every MR/PR/issue, so the person quickly finds
   the ones where they are the reviewer.
7. When Flows is present, **design problems and their solutions can be drawn**
   (sequence diagrams and structure graphs) and linked from the point.

## Non-goals

- No merging. Posting without the person only as described in "One-way and
  two-way changes" below.
- No review without a forge change: reviewing your own work first means opening
  a (draft) PR/MR (the person decided). `/review-factory` refuses anything else,
  in plain words.
- Not reviewing papers or non-code documents.
- No UML class/ER diagrams in v1 (Flows draws sequences and box-and-arrow graphs
  only). Recorded as a follow-up in Flows.
- No "mentioned in a comment" role in References (the person called it noise).

## Anti-goals (a failure even if it "works")

- A point whose quoted lines do not show what the point says.
- A claim with no source.
- The same issue raised twice, or a review longer than people will read.
- A checklist item silently skipped.
- Spending most of the budget on nice-to-haves, or looping between agents.
- A review that never approves: when nothing blocks, it must say so plainly.

## The flow

The person types **`/review-factory`** in a Claude Code conversation (optionally
`/review-factory <ref>`; default: the change selected on the canvas). The name
avoids Claude Code's own built-in review command. It is a **Factory** skill:
Factory declares and serves it, and refuses (in plain words) when the
conversation's kehikko has no Factory container. As with `/factory`, the
conversation becomes the **conductor**: Factory is the state machine and the only
writer of state, and hands the conversation one step
at a time with literal subagent prompts and a command to report back. The skill
is offered through the Skills window and kept installed by Settings
(`declares.skills`, served with the module's origin filled in, the way
kehikko-claude #23 does). `disable-model-invocation: true`.

Steps:

1. **Gather (no agent).** The module assembles the input packet:
   - the change: diff, commits, description, linked issues (it already reads these);
   - the **vision**: the change's epic (the epic that holds the change's ref) — its
     title, lede and body, its parts, and from Journeys the goal, how-we'll-know,
     appetite, rabbit holes and no-gos, when present. A change in no epic is
     reviewed without a vision section, and the review says so;
   - the **checklist(s)** held against the change in Checklist, with current ticks;
   - the **budget** (below).
2. **Plan (1 agent).** Picks **two angles** for this change from the situation
   (e.g. correctness, security, data-migration, performance, API compatibility,
   accessibility, tests, maintainability), each with a one-paragraph brief that
   names the best practices that apply *to this change* with sources. Splits the
   checklist items between the two reviewers. If no checklist exists, proposes
   one (≤ 15 items, each one checkable fact) and **stops for the person** to
   accept/edit it; accepted items are created in Checklist and held against the
   change. The person can change angles before reviewing starts.
3. **Review (2 agents, parallel).** Each reviewer works its angle and its
   checklist items. Output, in a fixed, parsed shape:
   - points, each: anchor (path, side, line or range, commit), the quoted lines,
     claim (≤ 2 sentences), why it matters, suggestion, severity
     (`blocking` | `risk` | `nice`), evidence (≥ 1: a line, a test or reproduction,
     project doc/code, or a named practice with a link), checklist items it bears on;
   - each assigned checklist item: `pass` | `fail` | `n/a` + how I know;
   - verdict `APPROVE` | `CHANGES`.
4. **Validate (no agent).** The module rejects, before any agent sees them,
   points that fail mechanical rules, and says why in the record:
   - anchor not in that diff (Review's existing check), or quote not matching the lines;
   - no evidence, or only the point's own lines as evidence for a claim about
     behaviour elsewhere;
   - over the length cap (claim + why + suggestion ≤ ~600 characters);
   - checklist item answered without a note.
   Near-duplicate points (same root cause) are merged into one listing all places.
5. **Challenge (1 agent).** One adversarial agent reads every surviving point
   from both reviewers and, per point, either concedes or makes the strongest
   honest case against it (wrong lines, wrong claim, not worth the cost, against
   the epic's direction), with evidence. One round only.
6. **Judge (1 agent).** Reads points, challenges, the vision and the checklist
   answers, and rules each point: `required` (blocking a bug-free release),
   `optional`, or `rejected`, with a one-line reason. Caps optional points at 3,
   preferring those that serve the epic. States vision fit in one sentence. Sets
   the verdict (approve / comment / request changes) and writes the summary
   (fits on one screen). Its ruling is final.
7. **Draft (no agent).** Required and kept optional points become Review draft
   comments (`by: 'agent'`) with their evidence links; the summary and verdict are
   proposed beside the person's (never over them); checklist answers are set in
   Checklist (passed / failed / not applicable) as the agent's, with their notes.
   Diagrams requested by the judge are drawn by one extra agent (see Decisions).
8. **Person.** The Review page shows the draft as today plus, per agent point, its
   severity, evidence, the challenge and the judge's reason. The person keeps,
   edits or drops each, and sends with the existing send. Nothing is posted
   before this.

Agent count per review: planner 1 + reviewers 2 + adversary 1 + judge 1 = 5,
plus 1 only when the judge asks for a diagram. No retries of a step except on a malformed answer (once).

## Budget and cost

- Sized from the change (files and lines changed), shown before the run starts
  and editable by the person: caps on points per reviewer (e.g. 8), on files read
  beyond the diff, and a soft token budget.
- Spent tokens are read from the conductor session's Claude Code transcript (the
  Orchestrator module already reads these) and shown in the record per step.
- When a cap is hit, the step stops and the review states what it did not get to.

## The board

Factory's container gets a second board, **Reviews**, beside its build jobs
(a View switch). One card per change under review; columns are the steps:

Queued → Gathering → Planning → Reviewing → Challenging → Judging → Diagrams →
Waiting for you → Sent

- Planning holds a card while a proposed checklist waits for the person.
- Diagrams is shown only when Flows is present and the judge asked for one.
- A card shows checklist progress ("7 of 12 checked · 1 failed"); opening it
  lists each item with pass/fail/n-a and its note, and the record so far.
- Cards move live as steps report, like the build board.
- **It touches nothing else:** the build board, Factory's stage-to-column
  mapping, and the tracker's board columns are left alone; a review never moves
  the change on the GitHub/GitLab board.
- "Waiting for you" opens the change in Review, where the draft is.

## Transparency record

Per review, under `<project>/.kehikot/factory/reviews/<id>/`: the input
packet summary, each step's prompt and raw output, validation rejections with
reasons, challenges, the judge's rulings, checklist answers, budget and spend.
Factory's card and the Review page both show it as "How this review was made",
in plain text (Review reads it from Factory's door). Nothing
is hidden from the person; the record is never posted to the forge.

## Flows (when present)

The judge may request a diagram for a point about structure or interaction:
- a **sequence** diagram (native in Flows) for "this call order is wrong / here is
  the fixed order";
- a **graph** for "these modules depend the wrong way / here is the fix";
each drawn as two flows or two stages ("now" and "proposed"), written with Flows'
`write_flow` into the change's epic, and linked from the point. Without Flows,
the point is text only. Class/ER diagrams: later, in Flows.

## References: "My role"

- **Protocol** (minor bump): tracker rows gain people as logins with roles,
  e.g. `reviewers?: { login, name?, state: 'requested'|'approved'|'changes'|'commented' }[]`,
  `authorLogin?`, `assigneeLogins?`, and the host adds per row
  `myRoles?: ('reviewer-asked'|'reviewer-done'|'author'|'assignee')[]`.
- **Host:** reads GitHub `reviewRequests` + `latestReviews` and GitLab `reviewers`
  + approvals; knows "me" per source from `gh api user` / `glab api user`, cached.
- **References:** a **My role** column ("Reviewer (asked) · Author") and a way to
  filter on it. All four filter groups are in use, so it is an option inside an
  existing group or a facet, not a fifth group (builder decides which reads best).

## Fixes folded in

- Review today lets an agent reword or drop the *person's* unsent comments; it
  must not.
- `read_change` gains reviewers and approvals.

## Panel machinery

Factory already has angle planning, prompts, parsers and judge rules in
`review/`, free of Factory imports. `/review-factory` reuses them inside Factory,
parameterised for this shape (two reviewers, one adversary over all points, one
judge). No extraction into the protocol is needed.

## One-way and two-way changes (the person's distinction)

Every run first classifies the change, with its reasons, as:

- **one-way**: hard or impossible to undo — database migrations, deleting data,
  public API or file-format changes, auth and permissions, deploy and
  infrastructure, dependency or licence changes, anything shipped to users that
  cannot be recalled;
- **two-way**: cheap to undo.

When in doubt it is one-way. The person can pin project rules ("anything under
`migrations/` is one-way", "label `two-way` means two-way"), stored in Factory's
project settings; the planner applies them before its own judgement.

**UI/UX changes always need the person**, whatever their door: the AI often gets
them wrong. An MR that touches what people see must include **before and after
pictures**; missing ones are a required point whose path to success names the
screens to capture. Review gains a **Before / after** view that pulls the images
from the MR's description and comments and shows them side by side next to the
diff. (The Browser module can take screenshots; nothing displays an MR's
pictures yet.)

**Two-way, no UI/UX:** with the project switch "Post two-way reviews by myself"
(off by default), the review is posted without the person. *Designer's call:* it
may also **approve** when the judge rules no required points. The person sees
everything afterwards on the Reviews board and in the record.

**One-way:** nothing is posted until the person has understood it. Besides the
points, the run writes a **decision briefing**: every important decision the
change makes, the alternatives, why this one; the risks and what cannot be
undone; and what the person should check in the functionality themselves. Not
every line. With Paper present it is a paper in the change's epic; otherwise a
document in the record. Flows diagrams illustrate it where they help. The
ordinary bad practices are still caught by the reviewers, so the person can focus
on the functionality.

How posting works without the page: Review gains a send path that only Factory
can use (a per-install secret in Review's machine-level module folder, readable
only by the user, presented by Factory), refused for one-way or UI/UX changes and
for anything with required points unless the verdict is "changes requested". The
builder hardens it; agents' MCP access never gains send.

## A path to success, always

- Every review that does not approve ends with **"To get this approved:"** — a
  short numbered list of exactly the required points. Doing those gets it approved.
- **No moving goalposts:** a re-review judges only what changed since the last
  review and whether the listed points were met. New points only about new code.
- The only exception is **closing**: a "close this MR" verdict needs the two
  reviewers, the challenger and the judge to agree unanimously, and says why and
  what to do instead.

## When to review again (per person)

Teams and people differ in how they say "ready for another look". Factory keeps
**re-review rules per author** (per project; "use for all projects" optional),
each a plain sentence the person gave plus its parsed form, e.g.

- "when they re-request review" (GitHub/GitLab re-request);
- "run a re-review 2 hours after the last push, if there are new commits";
- "when they comment 'ready'", "when the label `ready-for-review` is added";
- "only when I ask".

The first time a change from an author with no rule needs a re-review, Factory
**asks the person** — an Inbox item and on the card: "We haven't reviewed
<author>'s work before. What's the signal that they're ready for another review?"
with a recommended answer (the project's default rule) to accept with one press,
or a sentence to type. The project default starts as "when they re-request
review, or 2 hours after the last push with new commits and every point answered".

Re-reviews then run without the person: Factory starts a background Claude Code
session for it (project switch "Re-review by myself", off by default), capped at
3 rounds per MR so it cannot loop. Kehikot's tracker reading gains what these
signals need: review requests (above), resolved/unresolved discussion counts, and
the time of the last push.

## Running code

Reviewers **read** by default: the diff, and files at the pinned head in the
run's own checkout. A per-project switch in Factory's settings, off by default,
"Reviewers may run this project's tests", lets them run **only the project's own
test command** (as named in its AGENTS.md / CLAUDE.md) in that separate
checkout, and cite the result as evidence. Nothing else is executed. (The person
decided.)

## Checklist gains a failed state

Checklist items become **passed, failed, not applicable, or unchecked**, each with
its note and who set it, so Checklist itself shows what failed (the person
decided). Agents never change a state the person set.

## Order of work (each its own PR, merged in order)

0. Checklist: the failed and not-applicable states (MCP `check_item` gains a
   `state`; the page shows them; old ticks read as passed).
1. Protocol: row people/roles (minor bump). Tag.
2. Host: reviewers, "me", `myRoles`, resolved/unresolved discussion counts,
   last-push time.
3. References: My role column and filter.
4. Review: the Before / after view; the Factory-only send path; draft comments carry agent point metadata (severity, evidence,
   challenge, ruling) and show it; the agent-comment fix; `read_change` gains
   reviewers/approvals; a link to Factory's record.
5. Factory: `/review-factory` skill, review state machine, validation, the
   Reviews board, writing into Review's draft (Review's MCP tools) and Checklist
   (Checklist's MCP tools), Flows diagrams, the
   "may run tests" switch, door classification and project rules, the decision
   briefing (Paper when present), "post two-way reviews by myself", per-author
   re-review rules with the first-time question, background re-review sessions.

## Left to the builder

Exact prompt wording (our own; plain language rules above are binding), caps'
default numbers, how near-duplicates are detected, the page layout of the record,
and which filter group "My role" joins.

## Decisions after the builder check

Settled by the conversation (recorded here so nothing is guessed):

- **Command name:** `/review-factory`, a Factory skill (see "The flow").
- **Shared machinery:** none moves to the protocol. `/review-factory` reuses
  Factory's `review/` inside Factory with its own structured point shape
  (anchor, quote, evidence, severity, checklist links) and one adversary over all
  points. Factory's build-job reviews are unchanged.
- **Where the person makes choices:** as with `/factory`, in the conversation
  (`/review-factory angles …`, `/review-factory checklist accept|edit`,
  `/review-factory budget …`) and from the card on the Reviews board. The run
  waits in Planning until answered.

The builder's calls, made by the designer (the person may overrule):

- **Code to read:** each run checks out the change's head into its own worktree
  (Factory already does worktrees), so reviewers can read files beyond the diff at
  the exact head reviewed. The person's project folder is never switched.
- **Existing draft content:** a run never overwrites the person's summary,
  verdict or comments. Its summary and verdict are proposed beside the person's,
  and the person picks. A re-run replaces the previous run's *unsent agent*
  comments (tagged with the run id), and nothing else.
- **A push during a run:** the run reviews one pinned head. If the change moved on
  before Draft, the run stops at "Waiting for you" with "the change moved on;
  re-run to review the new commits", and the record is kept. Nothing is anchored
  to a head the run did not read.
- **Checklist states:** agents never change a state the person set; a
  disagreement is written as a note on the review card and the record.
- **Diagrams:** the judge only *requests* a diagram, in one line (kind, the point,
  "now" vs "proposed"). A sixth agent runs only then and writes the flows with
  `write_flow` into the change's epic. A change in no epic gets no diagram, and
  the point says so. The fixed count is therefore 5, plus 1 only when a diagram
  is requested.
- **Validation scope:** the mechanical rules apply to the panel's points. Comments
  any agent adds through Review's existing `add_comment` keep today's anchor
  check and stay marked `by: agent`; Goal 1 is about the panel's review.
