# Review orchestration: master implementation plan

> **For agentic workers:** this is the master plan. Each repository gets its own
> builder, who writes a task plan for their repo in that repo's
> `docs/superpowers/plans/2026-10-21-review-orchestration-<repo>.md` (TDD,
> superpowers:writing-plans format) and then implements it with
> superpowers:executing-plans. The contracts below are binding across repos:
> do not rename, reshape or extend them without the orchestrator.

**Goal:** accurate, transparent, budgeted code review via `/review-factory` in
Factory, landing in Review, with Checklist states and References' My role.

**Architecture:** Factory is the state machine and conductor protocol (as for
`/factory`); Review holds drafts and sends; Checklist holds the checklist and its
states; the host reads reviewers/roles from the forges; References shows roles.

**Spec:** Jalez/kehikko-review `docs/superpowers/specs/2026-10-21-review-orchestration-design.md`.
Read it in full before planning.

## Global constraints

- Storage only under `<project>/.kehikot/<module>/` via the protocol helpers;
  machine-level only where `dev/storage-boundary.ts` allows. `bun run check:storage`
  in the host scans all registered repos.
- Every person-facing string is plain language, short; never colour alone.
- Agents (MCP) can never send, approve, merge, purge, or change a state/comment
  the person set. Person-only routes are ticketed or PAGE_ONLY.
- No posting without the person except the Factory-only send path (C4), and it
  refuses one-way changes, UI/UX changes, and anything the judge did not rule.
- Commits end with the session's attribution lines; one PR per repo; work in a
  worktree of that repo; never edit main checkouts or installed copies; never
  `pkill`; never touch the real `~/.claude`, `~/.claude.json` or real sessions.

## Contracts

**C1. Checklist states** (kehikko-checklist).
- A tick gains `state: 'passed' | 'failed' | 'na'`; a tick without `state`
  reads as `'passed'` (old data). No tick = unchecked.
- MCP `check_item` gains optional `state` (default `'passed'`); `done:false`
  still removes the tick. A tick whose `by` is the person cannot be changed or
  removed over MCP: refuse with a sentence.
- `checklists` (MCP) prints `[x]` passed, `[!]` failed, `[-]` n/a, `[ ]`
  unchecked, each with by / note, plus counts
  `passed N · failed N · n/a N · unchecked N`.

**C2. Protocol 2.7.0** (kehikko-protocol; the orchestrator merges and tags).
Tracker row gains, all optional:
```ts
reviewers?: { login: string; name?: string; state: 'requested' | 'approved' | 'changes' | 'commented' }[]
authorLogin?: string | null
assigneeLogins?: string[]
myRoles?: ('reviewer-asked' | 'reviewer-done' | 'author' | 'assignee')[]
discussions?: { resolved: number; unresolved: number }
lastPushAt?: string   // ISO 8601
```
Limits in `LIMITS`: `REVIEWERS = 32`.

**C3. Host** (kehikko): fills C2 for GitHub (`reviewRequests`, `latestReviews`,
review threads `isResolved`, last commit `committedDate`/push time) and GitLab
(`reviewers`, approvals, discussions resolvable/resolved, last pipeline/commit
time). "Me" per source from `gh api user` / `glab api user`, cached per host;
`myRoles` computed per row. `read_tracker` shows them. Storage allowlist gains the
Review–Factory key (C4).

**C4. Review ↔ Factory** (kehikko-review).
- Review MCP `add_comment` gains optional
  `meta: { run: string; severity: 'blocking' | 'risk' | 'nice'; evidence: { kind: 'line' | 'test' | 'doc' | 'practice'; ref: string; quote?: string }[]; challenge?: string; ruling: 'required' | 'optional'; reason: string; checklist?: string[] }`.
  The page shows severity, evidence, challenge and ruling with the comment.
- New MCP `propose_review({ project, change, run, summary, verdict, door: 'one-way' | 'two-way', uiux: boolean, pathToSuccess: string[] })`:
  stored beside the person's summary/verdict, never over them; the page lets the
  person take it.
- New MCP `drop_run_comments({ project, change, run })`: drops that run's unsent
  agent comments only.
- Agents can no longer reword or drop a comment with `by: 'person'`.
- `read_change` gains `reviewers` and `approvals`.
- Factory-only send: `POST /api/factory/send { project, change, run }` with
  header `X-Kehikot-Factory-Key: <key>`. The key is 32 random bytes hex, created by
  Review on first start at `~/Library/Application Support/Kehikot/keys/review-factory.key`
  (mode 0600; the path from a helper honouring `KEHIKOT_KEYS_DIR`). It sends only
  the comments of that `run` plus its proposal, and refuses (409 + sentence) when
  the proposal's `door` is `one-way`, `uiux` is true, or the head moved since the
  run's comments were written.
- **Before / after view:** a header View option `shots` lists images found in the
  change's description and comments (markdown and HTML `<img>`), paired by
  "before"/"after" wording near them, shown side by side; opened links never
  executed, only `https:` images from the forge's own hosts.

**C5. Factory** (kehikko-factory): `/review-factory` skill, review state machine,
validation, Reviews board, door classification, decision briefing, per-author
re-review rules, background re-review sessions, settings switches
(`postTwoWay`, `reReviewByItself`, `runTests`, door rules), all per the spec.
Uses C1 (Checklist MCP), C4 (Review MCP + send), C2 fields via `tracker.get`,
Flows `write_flow`, Paper (for the briefing) when present. Review run files
under `.kehikot/factory/reviews/<id>/`. Board columns:
`queued, gathering, planning, reviewing, challenging, judging, diagrams, waiting, sent`.

**C6. References** (kehikko-references): a **My role** column from `myRoles`
("Reviewer (asked) · Author"), and filtering on it inside an existing filter
group (FILTER_GROUPS is full).

## Order and parallelism

- In parallel: **Checklist (C1)**, **Protocol → Host → References (C2, C3, C6)**,
  **Review (C4)**, **Factory (C5)**. Each builds against the contracts; the
  orchestrator merges in the order Checklist, Protocol (tag 2.7.0), Host,
  References, Review, Factory, and re-pins dependents to `#v2.7.0`.
- Factory's end-to-end test runs last, against the merged Review and Checklist.

## Review focus (most likely to bite a person)

1. A re-run deleting the person's comments or summary: tests in Review C4.
2. A one-way or UI/UX change posted without the person: tests on the send path (Review) and the gate (Factory).
3. An agent unticking the person's checklist tick: test in Checklist C1.
4. A point anchored to lines that don't show it: the validation step's tests (Factory).
5. A loop of re-reviews: the 3-round cap and per-author rule tests (Factory).
