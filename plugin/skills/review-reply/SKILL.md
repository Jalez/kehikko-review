---
name: review-reply
description: For a pull or merge request you authored, draft a reply to each review thread you received, and what to change in the code for it, into Kehikot's Review module. Nothing is posted; you read, edit and post each reply yourself from Review. Only a person runs it, by typing /review-reply.
argument-hint: "[<pull or merge request URL, or owner/repo#12>]"
disable-model-invocation: true
allowed-tools: mcp__review__read_focus, mcp__review__read_change, mcp__review__read_diff, mcp__review__read_review, mcp__review__read_threads, mcp__review__draft_reply
---

The person typed `/review-reply $ARGUMENTS`. They authored a change and received review comments on it. Draft ONE reply per thread into Kehikot's Review module (its page is at {{origin}}/app) through its `mcp__review__` tools. Every tool takes `project`: the absolute path of this project, `$PWD`.

1. Which change: `$ARGUMENTS` when it names one, else the change `read_focus` says Review has open. If neither, ask in one line and stop. If the `mcp__review__` tools are missing, say "Kehikot: the Review module's tools are not in this conversation. Is Review running in Kehikot (it answers at {{origin}})? [skill {{version}}]" and stop.
2. `read_change`, then `read_threads`. `read_threads` says whose login the tracker is signed in as; if that is not the change's author, tell the person this skill is for their own changes and stop. Skip threads that are resolved, and threads whose last word is already the author's.
3. For each remaining thread, read what it is about: `read_diff` with `path` for the file it is on, and the code in the project (Read, Grep, Glob). Decide honestly whether the reviewer is right.
4. Call `draft_reply` once per thread, with its `thread` id and:
   - `body`: the reply as it would be posted — short, plain, friendly. Agree and say what will change, or explain with a source (a line, a test, a doc) why not. No promises the code does not keep, no arguing for its own sake.
   - `todo`: what to change in the code for this thread, in a few plain lines naming the files; empty when nothing needs to change.
   `read_review` first: never redraft a thread the person already answered themselves.
5. Tell the person in at most five lines: how many replies, which threads need a code change, and that each reply waits in Review for them to read, edit and post. Nothing was posted.

Never post, resolve, approve or merge anything with gh, glab or anything else, and never change the code yourself in this skill: the person decides. Never edit `.kehikot/review/` files by hand.
