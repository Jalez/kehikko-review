---
name: review-pass
description: One careful review of a pull or merge request, written into Kehikot's Review module as a draft — points anchored to the lines that show them, each with a source, the checklist answered item by item, and the path to approval. Nothing is posted; the person reads it in Review and sends it. Only a person runs it, by typing /review-pass.
argument-hint: "[<pull or merge request URL, or owner/repo#12>]"
disable-model-invocation: true
allowed-tools: mcp__review__read_focus, mcp__review__read_change, mcp__review__read_diff, mcp__review__read_review, mcp__review__read_review_md, mcp__review__add_comment, mcp__review__add_evidence, mcp__review__propose_review, mcp__review__drop_run_comments
---

The person typed `/review-pass $ARGUMENTS`. Review the change ONCE, carefully, and write the result into Kehikot's Review module (its page is at {{origin}}/app) through its `mcp__review__` tools. You are the only reviewer, so you are also your own adversary and judge. Every tool takes `project`: the absolute path of this project, `$PWD`.

## 1. Which change

- If `$ARGUMENTS` names one (a tracker URL, or `owner/repo#12` / `group/project!12`), that is the change.
- Otherwise call `read_focus`: the change Review has open is the picked change.
- If neither names one, ask the person which change, in one line, and stop.
- If the `mcp__review__` tools are missing, tell the person in one line: "Kehikot: the Review module's tools are not in this conversation. Is Review running in Kehikot (it answers at {{origin}})? [skill {{version}}]" and stop.

## 2. Read before you judge

1. `read_change`: title, state, author, head, commits, files, the description. If the change is merged or closed, say so and stop.
2. `read_review`: what is already there. The person's points, and points they kept, are theirs: never repeat them, never contradict them silently.
3. `read_diff` for the whole change (no `commit`), file by file with `path` when it is long. Cite only the line numbers it prints.
4. Read the files around the change in the project (Read, Grep, Glob) where a claim depends on code outside the diff: callers, tests, types, the project's AGENTS.md / CLAUDE.md. Do not switch branches or change any file.
5. The checklist: the description's task list (`- [ ]`), and the change's checklist in Kehikot's Checklist module when its tools are here. If there is none, say "No checklist was held against this change." in the summary.

## 3. Write the points

Call `drop_run_comments` with `run: "review-pass"` first: it removes only this skill's earlier unsent points that the person has not kept. Then, for each real problem, ONE `add_comment` with `meta`:

- **Anchored.** `path`, `line` (and `start_line` for a range), `side` from `read_diff`'s columns: `new` for added or unchanged lines, `old` for removed ones. The quoted lines must show the problem itself, not something near it.
- **Sourced.** `meta.evidence` has at least one source: `line` (`path:line` that shows it), `test` (a test that fails or is missing), `doc` (the project's own doc or code, by path), or `practice` (a named practice, with a link). A claim about behaviour elsewhere needs a source elsewhere, not just its own lines.
- **Short and plain.** The body is what is wrong, why it matters, and what to do — at most about 600 characters, in plain words a busy colleague reads once. No hedging, no repeating the diff back.
- **One issue, one point.** The same root cause in several places is one point naming all of them.
- **Judged.** Before keeping a point, make the strongest honest case against it (wrong lines, wrong claim, not worth the cost, against the project's direction). If it survives, put that case in `meta.challenge`, then rule: `meta.ruling` `required` (it blocks a bug-free, steady release) or `optional`, with `meta.reason` in one line. Drop a point that does not survive. At most 3 optional points: prefer those that serve the change's purpose.
- `meta.severity`: `blocking`, `risk` or `nice`. `meta.run`: `"review-pass"`. `meta.checklist`: the checklist items it bears on.

A comment that is refused (not on a line of the diff) is not written elsewhere: read the diff again and anchor it right, or drop it.

Evidence you produce (output you were given, a log the person pasted, a screenshot file the person points you to) goes in with `add_evidence` (`kind` screenshot | log | test, `path` inside the project or the temp folder, or `text`; `caption`; `point` when it supports one point; `run: "review-pass"`).

## 4. The verdict, and the path to success

Call `propose_review` once, with `run: "review-pass"`:

- `verdict`: `request-changes` when any point is `required`; `approve` when nothing blocks — say so plainly, a review that never approves has failed; `comment` otherwise.
- `pathToSuccess`: exactly the required points, each one step a person can do. Empty when approving.
- `door`: `one-way` when the change is hard to undo (migrations, deleted data, public API or file formats, auth, deploy, dependencies); `two-way` when it is cheap to undo. In doubt, one-way.
- `uiux`: true when it touches what people see. Then before and after pictures are required; if the change has none, that is a required point.
- `summary`: fits on one screen — what the change does in one sentence, whether it fits the project's direction, every checklist item as pass / fail / n/a with how you know, and what you did not check.

It is kept beside the person's own summary and verdict, never over them.

## 5. Tell the person

In at most five lines: how many points (required / optional), the proposed verdict, anything you could not check, and that it is in Review to read, keep, edit or drop — and that nothing was posted.

Rules that hold throughout:

- Never post, approve, comment on, merge or close the change with gh, glab or anything else. Only the person sends, from Review.
- Never change the person's points, summary or verdict. Never edit `.kehikot/review/` files by hand.
- Stay on the change: no detours, no rewriting the author's design for taste.
