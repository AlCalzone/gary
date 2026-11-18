# Mode: take over

The maintainer clicked `take_over` on a contributor PR that is not taken over yet, or on a PR by the bot or a dependency bot whose CI fails because of its own change. Finishing it ourselves is quicker than another round trip. You get the action file (`params.mode`, optional `params.decisions` with one decision per open thread, optional `text` with instructions), the item doc with the review's findings and threads, and a scratch directory.

## What a take-over never does

Taking over means finishing the code. It never means deciding the PR. You do not merge, approve, close or mark the PR ready, also when the instructions mention a merge. The maintainer has the last word and merges on GitHub himself.

You may set the PR's title when it does not follow the profile's title format, because the title becomes the squash commit message: `gh pr edit <n> --repo <owner>/<repo> --title "<title>"` under the writing identity. Change nothing else on the PR: no labels beyond the autonomous ones, no reviewers, no milestone, no base branch. Say in the returned `state` that you changed the title.

## `mode: "push"`

The normal mode. Continue in the contributor's PR with our commits, pushed under the writing identity:

1. Check the preconditions and set up the worktree as `push-to-pr.md` describes.
2. Apply the review's findings that block a merge, plus the instructions in `text`. Take every fact from the PR thread, the maintainer's comments, the action's `text` or files on the default branch. If a finding needs something only the contributor knows, like a detail of their hardware, leave it and say so in the returned `state`.
3a. When the item's `autofix.changes` is true, run `format-check.md` against the current head and apply its patch in the same commit, so the PR needs no separate format step.
3. When the action carries `params.decisions`, handle the threads exactly as `address-review.md` describes in its steps 2 to 5, including its replies for dismissed and optional threads: fix the threads marked `fix`, push one commit with these fixes and the ones from step 2, reply in every handled thread, give dismissed ones a short reason, resolve them. Without decisions, commit and push as `push-to-pr.md` describes.
4. Return as `push-to-pr.md` describes, with `takenOver: true` on the item. Handled threads leave `threads`. From now on the PR can get `drive` and `address_review` routes. Add a `reply` route with a short note for the maintainer to send, like `I pushed the missing fields from the sibling file, so this is ready to merge.`

## `mode: "replace"`

The exception. The route's `callout` said why pushing to the branch is not possible, usually because the contributor did not allow edits by maintainers.

1. Check that the PR is open and touches no sensitive path.
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

The new PR is a draft. The maintainer marks it ready himself.
