# Mode: address review

The maintainer clicked `address_review` on a PR by the maintainer, the bot or Copilot, or on a contributor PR with `takenOver: true`. On any other contributor PR, return `status: "failed"`: pushing there is a take-over, and `take-over.md` uses the steps below for its threads. The action file's `params.decisions` holds one entry per open thread: `{ threadId, decision: "fix" | "dismiss", note }`. Its `text` is an optional note for the whole request. Both are the maintainer's instructions. You fix the threads marked `fix`, reply in every thread, and resolve them.

This mode builds on the `address-review-comments` skill when it is installed. Read it and use its recipes for fetching threads, replying and resolving. The recipes below cover the same steps when it is missing. The board settles that skill's open questions in advance:

- **Which threads**: exactly those in `params.decisions`. A thread that is missing there stays untouched.
- **Verdict overview**: skip it. The maintainer already decided per thread on the board. Do not wait for anyone.
- **Validity**: the decision is his. Still verify a `fix` thread against the code before editing. If the fix turns out wrong or impossible, leave that thread open, skip its reply, and say why in the returned `state`.
- **Push or stage**: push, following `push-to-pr.md`. Its preconditions and rules apply in full.
- **Resolve**: resolve every thread you replied to, the dismissed ones too. The maintainer dismissed them explicitly.

## Steps

1. Check the preconditions in `push-to-pr.md`. When no decision is `fix`, the push checks are not needed, but the PR must be open.
2. Fetch the threads with the `reviewThreads` query from the review skill, adding `comments(first:1){nodes{databaseId}}`. Map each `threadId` to its first comment's `databaseId`, which the reply endpoint needs. A thread that is already resolved or gone needs no reply.
3. Fix every `fix` thread in the worktree, with its `note` as extra guidance. One commit for all of them, with a message like `fix: address review feedback` in the project's format. Push it.
3a. When the item's `autofix.changes` is true, run `format-check.md` against the current head and apply its patch in the same commit as the fixes.
4. Reply in every handled thread under the writing identity (`accounts.md`): `gh api repos/<owner>/<repo>/pulls/<n>/comments/<databaseId>/replies -f body='…'`. Keep replies to one or two sentences, in the style of `voice.md`, without "I":
   - fixed: `Fixed in <short sha>: <what changed>.`
   - dismissed: the short reason. Use the maintainer's `note` when he gave one, otherwise the thread's `note` from the item doc. Example: `Not needed: the value is already validated by the parser.`
   - dismissed `optional` thread without a note: one sentence that says it is optional and was left as is, like `Optional, left as is for this PR.` Resolve it like the others.

The board starts every thread on dismiss except the `valid` ones. A dismissed thread is the maintainer's decision, also when he only kept the default.
5. Resolve each replied thread under the writing identity: `gh api graphql -f query='mutation($id: ID!){ resolveReviewThread(input:{threadId:$id}){ thread{ isResolved } } }' -f id=<threadId>`.
5a. When you pushed, request the next Copilot review on a watched PR with `gary pr-watch review --after <your action id>`, as `push-to-pr.md`, "Review bot round after a push", describes. Without a push, request none.
6. Remove the worktree and return as described in `push-to-pr.md`. Handled threads leave `threads`. `result` is the commit URL, or the number of threads handled when nothing was pushed.

A failure after the push still returns `status: "done"` with what happened in `state`, like `Pushed the fix. Replying to 1 of 3 threads failed: API error 502.` The push cannot be undone, so the item has to show the real state.

The routes of the returned item follow "Routes after a push" in `push-to-pr.md`: routes from before the push are dropped, and `reviewedSha` is the new head.

## Last step

On every exit path, failures and refusals included: release your claims with `gary release <itemId> <kind> --run <run>`, and set the action doc to `done` or `failed`. A doc left `queued` or claimed blocks the item, because such docs do not expire.
