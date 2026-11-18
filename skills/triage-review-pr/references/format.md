# Mode: format

The maintainer clicked `format` on a PR. You apply exactly the autofix result to the PR's branch as one commit, and nothing else.

`format` is not a take-over. It sets no `takenOver`, and it unlocks neither `drive` nor `address_review`. It is the one exception in the rule "Who may push to a PR" in `<core>/skills/triage-routine/references/item-doc.md`, because it changes only what the project's own tools would change.

## Steps

1. Check the preconditions in `push-to-pr.md`. The server does not check them for `format`. Refuse with `status: "failed"` when the PR is no longer open or its head moved since `reviewedSha`.
2. Run the check in `format-check.md` again, against the current head, and keep the patch.
3. Refuse when the patch touches a file the PR did not change, or when it is empty.
4. Set up the PR worktree as `push-to-pr.md` describes and apply the patch: `git -C <worktree> -c core.hooksPath=/dev/null apply --index <scratch>/format.patch`. If it does not apply cleanly, refuse. Never resolve conflicts.
5. Commit under the writing identity with the profile's commit message, default `chore: format and fix lint`. Push as `push-to-pr.md` describes.
6. Return as `push-to-pr.md` describes. The item gets `autofix` with `changes: false`, the new `reviewedSha`, the commit in `links`, and the `format` route removed. Everything else on the item stays as it was, including its other routes. Without other findings, the recommended route becomes `merge` as `me`, or a `review` approval when the PR lacks one.

The commit runs CI again. When CI was red only because of the lint job, it should turn green.

The routes of the returned item follow "Routes after a push" in `push-to-pr.md`: routes from before the push are dropped, and `reviewedSha` is the new head.

## Last step

On every exit path, failures and refusals included: release your claims with `gary release <itemId> <kind> --run <run>`, and set the action doc to `done` or `failed`. A doc left `queued` or claimed blocks the item, because such docs do not expire.
