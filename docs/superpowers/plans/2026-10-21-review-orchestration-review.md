# Review orchestration — the Review side (C4): task plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans.
> Steps use checkbox (`- [ ]`) syntax. Every task is test-first: write the
> failing test, see it fail, write the code, see it pass, commit.

**Goal:** Review holds what an agent review run drafts (comments with point
metadata, a proposed summary and verdict beside the person's), lets Factory —
and only Factory — send a run's review when the change is two-way and not
UI/UX, and shows a change's before/after pictures.

**Architecture:** the draft file gains `meta` on comments, a `proposal`, and
who last set the summary and verdict. The rules stay pure in `review/draft.ts`;
the doors call them. The Factory-only send is a separate node middleware
(`factory/door.ts`) placed before the protocol's `doors()`, because it needs a
request header `answer` is not given; `answer` itself refuses every
`/api/factory/*` path. Images are found by a pure `review/shots.ts`.

**Spec:** `docs/superpowers/specs/2026-10-21-review-orchestration-design.md`.
**Contract:** C4 in `docs/superpowers/plans/2026-10-21-review-orchestration.md`.
Binding; names and shapes below are the contract's.

**Tech:** Bun, TypeScript, React 19, Vite, `kehikot-module-protocol` (pinned
`#v2.7.0` for `TrackerReviewer`).

---

## Files

| File | Change |
| --- | --- |
| `review/shape.ts` | `Meta`, `Evidence`, `Proposal`, `Comment.meta`, `Draft.proposal`, `Draft.summaryBy`, `Draft.verdictBy`; bounds |
| `review/draft.ts` | read the new fields; `metaOf`, `proposalOf`, `proposeReview`, `takeProposal`, `dropRunComments`, `proposalBody`; `rewordComment`/`dropComment`/`setVerdict` take who is acting |
| `review/print.ts` | prints meta and the proposal for an agent |
| `review/shots.ts` (new) | images in markdown/HTML, before/after labels, pairs, the host rule |
| `forge/read.ts` | `Described.description`, `requested`; reviews/approvals/comments commands and readers |
| `factory/key.ts` (new) | `keysDir`, `keyFile`, `ensureKey`, `loadKey`, `sameKey` |
| `factory/door.ts` (new) | `factorySend` (the rules), `factoryHandler` (the middleware), `factoryDoor` (the Vite plugin) |
| `doors.ts` | MCP `add_comment` `meta`, `propose_review`, `drop_run_comments`; `read_change` reviewers/approvals; `/api/proposal/take`, `/api/shots`; `deliver` shared by both sends; `/api/factory/*` is 404 here |
| `vite.config.ts` | `factoryDoor()` before `doors()` |
| `src/header.ts` | `shots` option on the `showing` switch |
| `src/wire/api.ts` | `takeProposal`, `shots` |
| `src/view/comment.tsx` | the point's severity, ruling, reason, evidence, challenge |
| `src/view/review-panel.tsx` | the proposal box: "Use this summary", "Use this verdict", the path to success |
| `src/view/shots.tsx` (new) | the Before / after view |
| `src/view/change-review.tsx` | `shots` view |
| `test/setup.ts` | `KEHIKOT_KEYS_DIR` to scratch |
| tests | `test/draft-runs.test.ts`, `test/people.test.ts`, `test/runs.test.ts`, `test/key.test.ts`, `test/factory.test.ts`, `test/shots.test.ts`, updates to `doors`, `read`, `send`, `store`, `render` tests |
| `README.md` | the new tools, the Factory send, the key, the view |

## Contract signatures (final)

```ts
// MCP
add_comment({ project, change, commit?, path, line, start_line?, side?, body,
  meta?: { run: string; severity: 'blocking' | 'risk' | 'nice';
           evidence: { kind: 'line' | 'test' | 'doc' | 'practice'; ref: string; quote?: string }[];
           challenge?: string; ruling: 'required' | 'optional'; reason: string; checklist?: string[] } })
propose_review({ project, change, run, summary, verdict: 'comment' | 'approve' | 'request-changes',
  door: 'one-way' | 'two-way', uiux: boolean, pathToSuccess: string[] })
drop_run_comments({ project, change, run })
read_change(...)   // + "Reviewers:" and "Approvals:" lines, read with gh/glab

// HTTP, Factory only
POST /api/factory/send  { project, change, run }   header X-Kehikot-Factory-Key: <64 hex>
```

## Tasks

### Task 1 — the draft holds runs (pure)
- [x] Tests (`test/draft-runs.test.ts`): `metaOf` accepts the contract shape and
  refuses: unknown severity/ruling/evidence kind, no evidence, bad run id, over-long
  strings. `readDraft` keeps `meta`, `proposal`, `summaryBy`, `verdictBy` and drops junk.
  `proposeReview` never changes `summary`/`verdict`; a second run's proposal replaces
  the first; request-changes needs a path to success. `takeProposal('summary')` puts
  summary + "To get this approved:" list into the person's summary; refuses a stale run.
  `dropRunComments` drops only unsent agent comments of that run — never the person's,
  never sent ones, never another run's. `rewordComment`/`dropComment` with `'agent'`
  refuse a person's comment. `setVerdict` by `'agent'` refuses to replace a summary or
  verdict the person set.
- [x] Implement in `review/shape.ts`, `review/draft.ts`. Commit.

### Task 2 — the forge: reviewers, approvals, description, comments
- [x] Tests (`test/people.test.ts`): argv of `reviewsCommand`, `approvalsCommand`,
  `notesCommand`; `readPeople` for GitHub (requested + latest decisive review per
  login, author excluded, re-requested wins) and GitLab (reviewers + approvals);
  `readDescribed` carries `description`; `readNotes` bounds.
- [x] Implement in `forge/read.ts`. Commit.

### Task 3 — MCP: meta, propose_review, drop_run_comments, read_change, the person's comments
- [x] Tests (`test/runs.test.ts`, tool list in `test/doors.test.ts`): tool list (8 + 2, still nothing that sends);
  `add_comment` with `meta` is stored with the head it was read at and printed by
  `read_review`; bad `meta` refused before anything is written; `propose_review` stores
  beside and never over the person's summary/verdict; **a re-run** (`drop_run_comments`
  + new comments + new proposal) leaves the person's comments, summary and verdict
  byte-identical; agents cannot reword or drop the person's comment; `read_change`
  prints reviewers and approvals on both forges.
- [x] Implement in `doors.ts`, `review/print.ts`. Commit.

### Task 4 — the key
- [x] Tests (`test/key.test.ts`): created 0600 in a 0700 folder under
  `KEHIKOT_KEYS_DIR`, 64 hex; second call returns the same key; a group/other
  readable file is tightened to 0600; a symlink is refused; junk content is
  replaced; `sameKey` is true only for the exact key and false for empty, prefix,
  longer, other.
- [x] Implement `factory/key.ts`; `test/setup.ts` points `KEHIKOT_KEYS_DIR` at scratch. Commit.

### Task 5 — the Factory-only send
- [x] Tests (`test/factory.test.ts`), every refusal and nothing posted for each:
  no header → not this route (`answer` → 404, handler → next); a page or another
  origin (`Origin`/`Sec-Fetch-Site`) → 403; GET → 405; no key file → 503; wrong key
  → 403; bad body (no project, no change, bad run) → 400; no proposal / another run's
  → 409; already sent → 409; **one-way → 409**; **UI/UX → 409**; required points
  with a verdict other than request-changes → 409; change not open → 409; **head
  moved since the run's comments or proposal → 409**; a send already under way → 409.
  Success: only that run's comments and the proposal's body/verdict are posted (the
  person's comments and summary are not), comments stamped, proposal marked sent, the
  person's summary and verdict untouched, history entry written. The handler reads the
  header and body from a node-style request.
- [x] Implement `factory/door.ts`, `deliver` in `doors.ts`, `vite.config.ts`. Commit.

### Task 6 — images (pure) and `/api/shots`
- [x] Tests (`test/shots.test.ts`): markdown and `<img>` found with alt; labels from
  alt, the words just before, a table header column; pairs before→after in order;
  only `https:` on the forge's hosts (github.com, *.githubusercontent.com; the GitLab
  host, with `/uploads/…` made absolute under the project); `http:`, `data:`,
  `javascript:`, other hosts and credentials-in-URL refused with a reason; bounds.
  `/api/shots` reads description + comments through the fake runner.
- [x] Implement `review/shots.ts`, `forge/read.ts` notes, `doors.ts`. Commit.

### Task 7 — the page
- [x] Tests (`test/render.test.tsx`): a point's severity/ruling/reason/evidence/
  challenge are shown as words; the proposal box shows the path to success and door;
  "Use this summary" (two presses when the person has words) and "Use this verdict"
  call the API; the `showing` switch has "Before / after"; pressing it shows pairs side
  by side, refused images as text with no link, and never an `<img>` with a non-https src.
- [x] Implement `src/…`. Commit.

### Task 8 — README, typecheck, all tests, PR
- [x] README: tools, the Factory send and its refusals, the key, the view.
- [x] `bun run typecheck && bun test`. Open the PR (ready, not merged).
