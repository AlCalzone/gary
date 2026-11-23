# Mode: revise

The maintainer clicked `revise` (the "Change" card) on a PR we already control: a PR by the maintainer, by the bot, by another bot or Copilot, or a contributor PR with `takenOver: true`. On any other contributor PR, return `status: "failed"`: the first push there is a take-over, see `take-over.md`. You get the action file with the instructions in `text`, the item doc with the review's findings and threads, and a scratch directory. The action has no params.

`text` is the change he wants. The agent proposed it on the card and he may have edited it, so follow it as he sent it. An empty `text` is a failed request.

The limits in `push-to-pr.md`, "What a take-over or a change never does", apply.

A `revise` route with `params.via: "api"` never reaches you. The server commits its text edits itself after the click. It is the only change a PR with sensitive files can get, unless the PR is ours alone. A PR that is ours alone gets the normal revise. `gary push-check` in the preconditions of `push-to-pr.md` decides whether it still is.

## Steps

1. Check the preconditions and set up the worktree as `push-to-pr.md` describes.
2. Make the change `text` asks for, and nothing else. Take every fact from the PR thread, the maintainer's comments, `text` or files on the default branch. When a part of the instructions cannot be done, like a file that does not exist, leave that part and say so in the returned `state`.
3. When the item's `autofix.changes` is true, run `format-check.md` against the current head and apply its patch in the same commit, so the PR needs no separate format step.
4. Commit and push to the PR branch as `push-to-pr.md` describes. A revise always pushes to the PR's own branch. It never opens a replacement PR. When the push is not possible, return `status: "failed"` with the reason.
4a. On a watched PR, when the profile lists a review bot, request its next review with `gary pr-watch review --after <your action id>`, as `push-to-pr.md`, "Review bot round after a push", describes. A PR by the bot or with `takenOver: true` is watched. A PR by the maintainer is not.
5. Return as `push-to-pr.md` describes. Do not set `takenOver`: the item keeps the value it had.

## Open review threads

A revise carries no thread decisions. Leave every open thread as it is: no reply, no resolve. The threads stay in `threads` with their verdicts, and the returned routes offer `address_review` or `drive` for them where the rules allow it. The one exception is a thread that your change made pointless, like a comment on a file the instructions told you to delete. Keep it in `threads` and say in its `note` that the change covers it, so he can dismiss it in the next `address_review`.

## Last step

On every exit path, failures and refusals included: release your claims with `gary release <itemId> <kind> --run <run>`, and set the action doc to `done` or `failed`. A doc left `queued` or claimed blocks the item, because such docs do not expire.
