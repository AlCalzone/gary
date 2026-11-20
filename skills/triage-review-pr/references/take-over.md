# Mode: take over

The maintainer clicked `take_over` on a contributor PR that is not taken over yet. Finishing it ourselves is quicker than another round trip. On a PR we already control (by the maintainer, the bot, another bot or Copilot, or with `takenOver: true`), return `status: "failed"`: changes there are a `revise`, see `revise.md`. You get the action file (`params.mode`, optional `params.decisions` with one decision per open thread, optional `text` with instructions), the item doc with the review's findings and threads, and a scratch directory.

A `take_over` route with `params.via: "api"` never reaches you. The server commits its text edits itself after the click, and it is the only take-over a PR with sensitive files can get. When an action for such a PR reaches you anyway, `gary push-check` in the preconditions of `push-to-pr.md` refuses it. A contributor's PR is never ours alone.

## What a take-over never does

Taking over means finishing the code. The limits in `push-to-pr.md`, "What a take-over or a change never does", apply.

## `mode: "push"`

The normal mode. Continue in the contributor's PR with our commits, pushed under the writing identity:

1. Check the preconditions and set up the worktree as `push-to-pr.md` describes.
2. Apply the review's findings that block a merge, plus the instructions in `text`. Take every fact from the PR thread, the maintainer's comments, the action's `text` or files on the default branch. If a finding needs something only the contributor knows, like a detail of their hardware, leave it and say so in the returned `state`.
3a. When the item's `autofix.changes` is true, run `format-check.md` against the current head and apply its patch in the same commit, so the PR needs no separate format step.
3. When the action carries `params.decisions`, handle the threads exactly as `address-review.md` describes in its steps 2 to 5, including its replies for dismissed and optional threads: fix the threads marked `fix`, push one commit with these fixes and the ones from step 2, reply in every handled thread, give dismissed ones a short reason, resolve them. Without decisions, commit and push as `push-to-pr.md` describes.
3b. After the push, request the first Copilot review with `gary pr-watch review --after <your action id>`, as `push-to-pr.md`, "Review bot round after a push", describes. Your take-over doc makes the PR count as taken over before the item records it. Copilot reviews the push, and the drive rounds of `drive.md` address that review.
4. Return as `push-to-pr.md` describes, with `takenOver: true` on the item. Handled threads leave `threads`. From now on the PR can get `drive`, `address_review` and `revise` routes, and never a second `take_over`. The routes follow "Routes after a push" in `push-to-pr.md`: the item offers the decision, usually a `merge` as `me`. A note to the contributor, like `I pushed the missing fields from the sibling file, so this is ready to merge.`, is that route's `text`, never a route of its own.

## `mode: "replace"`

The exception. The route's `callout` said why pushing to the branch is not possible, usually because the contributor did not allow edits by maintainers.

1. Check that `gary push-check --pr <n> --sha <reviewedSha>` exits 0. It refuses a PR that is not open and a contributor's PR that touches a sensitive path.
2. Create a worktree on a new branch from the default branch:
   ```bash
   git -C <checkout> fetch origin <default branch>
   git -C <checkout> worktree add -b triage/replace-pr-<n> <scratch>/replace-pr-<n> origin/<default branch>
   ```
3. Bring over the contributor's changes as text: read their files at `reviewedSha` with `gh api "repos/<owner>/<repo>/contents/<path>?ref=<sha>" -H "Accept: application/vnd.github.raw"` and write them into the worktree. Then apply the findings and the instructions in `text`. Run nothing from the contributor's files. Follow the profile's edit rules from `rules/review.md`.
4. Commit under the writing identity with a message in the project's format. Credit the contributor with a `Co-authored-by: <name> <email>` trailer, taking name and email from their commits (`gh pr view <n> --repo <owner>/<repo> --json commits`).
5. Push the new branch to the repo with the push command from `accounts.md` and `HEAD:refs/heads/triage/replace-pr-<n>`.
6. Open a draft PR under the writing identity. The body has no forced line breaks. It says that it replaces #<n>, credits the contributor, and lists what changed on top of their work.
   ```bash
   gh pr create --repo <owner>/<repo> --draft --base <default branch> --head triage/replace-pr-<n> --title "<title>" --body-file <scratch>/pr-body.md
   ```
7. Remove the worktree. Return `{ status, result, item }` with the new PR's URL as `result`. The item keeps the original PR's number and gets:
   - a `links` entry `{ "label": "Replacement PR", "url": "…" }`,
   - a recommended `close` route as `me`, without `reason`, whose `text` thanks the contributor and links the replacement PR,
   - a `state` that names the replacement PR,
   - `takenOver: true`.

The new PR is a draft. The maintainer marks it ready himself. The replace mode requests no Copilot review.

The routes of the returned item follow "Routes after a push" in `push-to-pr.md`: routes from before the push are dropped, and `reviewedSha` is the new head.

## Last step

On every exit path, failures and refusals included: release your claims with `gary release <itemId> <kind> --run <run>`, and set the action doc to `done` or `failed`. A doc left `queued` or claimed blocks the item, because such docs do not expire.
