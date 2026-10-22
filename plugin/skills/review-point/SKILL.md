---
name: review-point
description: Write ONE well-sourced review point at the place in a pull or merge request's code where the person is pointing (from Kehikot's Source or Diff, or given as path:line), into Kehikot's Review module as a draft for them to keep, edit or drop. Nothing is posted. Only a person runs it, by typing /review-point.
argument-hint: "[path:line or path:first-last] [what the point is about]"
disable-model-invocation: true
allowed-tools: mcp__review__read_focus, mcp__review__read_diff, mcp__review__read_review, mcp__review__add_comment
---

The person typed `/review-point $ARGUMENTS`. Write exactly ONE point into Kehikot's Review module (its page is at {{origin}}/app) through its `mcp__review__` tools. Every tool takes `project`: the absolute path of this project, `$PWD`.

1. Call `read_focus`. It names the change Review has open and, when somebody pointed, the place: path, line (or lines), side. If `$ARGUMENTS` starts with `path:line` or `path:first-last`, that place wins over the focus. If there is no change, or no place, ask the person in one line and stop. If the `mcp__review__` tools are missing, say "Kehikot: the Review module's tools are not in this conversation. Is Review running in Kehikot (it answers at {{origin}})? [skill {{version}}]" and stop.
2. Call `read_diff` for the whole change with `path` set to that file, and find the line in the column of its side. Read the code around it in the project (Read, Grep, Glob) as far as the point needs. Call `read_review`: if the point is already made, say so and stop.
3. Decide what is wrong there — or, if nothing is, say so in one line and stop. The rest of `$ARGUMENTS` is what the person wants the point to be about.
4. Call `add_comment` once, with no `commit` (a line of the whole change), the `path`, `line` (the LAST line; `start_line` for a range) and `side`, and:
   - a body of at most about 600 characters: what is wrong, why it matters, what to do, in plain words;
   - `meta`: `run: "review-point"`, `severity` (blocking | risk | nice), at least one `evidence` source (`line` path:line, `test`, `doc`, or `practice` with a link) — a claim about code elsewhere cites that code — `challenge` (the strongest honest case against the point), `ruling` (required | optional) and a one-line `reason`.
   If it is refused because the line is not in the diff, tell the person why in one line; do not anchor it somewhere else.
5. Tell the person in two lines what the point says, and that it is a draft in Review: nothing was posted.

Never post anything with gh or glab, never change the person's points, and never edit `.kehikot/review/` files by hand.
