# Fix mode: repro test, fix, draft PR

The routine starts fix mode for an item whose triage returned a `follow_up` route with `as: "agent"`, or when the maintainer clicked one. That item is usually an issue, sometimes a PR whose finding suggested a separate fix. You get the item doc, the snapshot entry, the route's `text` with the plan, and `params.finding` when the request named one. The goal is a draft PR that the maintainer can review: a test that fails on the default branch, the smallest fix that makes it pass, and a description he can check in a minute.

The profile's `rules/issues.md` holds the project's commands and conventions: how to set up a worktree, how to write and run the repro test, which checks to run before pushing, the commit message format. Read it before you start.

Opening the draft PR is one of the few things the routine may do without a click. It needs a writing identity that may push (`<core>/skills/triage-routine/references/accounts.md`). Without one, stop and return the item unchanged with the reason in `state`. The limits are strict:

- Work only in a new worktree on a new branch from `origin/<default branch>`.
- Push only that branch. Never push to the default branch or to any existing branch, and never to a contributor's fork.
- Open the PR as a draft. Never mark it ready, request reviewers, comment on the issue or merge.

## 0. Claim

Claim the item with `gary claim <itemId> fix --run <run>`, plus `--request <action doc id>` when a clicked `start_fix` started you, and release it with `gary release <itemId> fix --run <run>` when you are done, also on failure. Exit code 3 means another run holds it: stop and return the item unchanged.

For an autonomous fix, read the queue right before you start and again right before you open the PR. When a `start_fix` request for this item is queued or claimed, the item is the maintainer's: stop without opening a PR, release the claim, and return the item unchanged. A fix he started with instructions follows those instructions exactly. An autonomous fix uses your own approach, unless the route's `text` gives one.

## 0a. Fix state

Run `gary fixes --json` for the item right before you create the branch, and again right before `gh pr create`. A `working` state held by another run, or a `draft` or `open` state, means stop: release the claim and return the item unchanged. This is on top of the claim.

## 1. Worktree

```bash
git -C <checkout> fetch origin <default branch>
git -C <checkout> worktree add -b triage/issue-<n> <worktree> origin/<default branch>
```

`<worktree>` is `<state>/worktrees/triage-issue-<n>`, unless the profile names another place. Then run the project's setup command from the profile in the worktree.

Subagent shells reset the working directory between calls. Prefix every later command with `cd <worktree> &&`, or use `git -C <worktree>`. A command that runs in `<checkout>` by mistake changes it.

For a discussion, use `triage/disc-<n>` and `triage-disc-<n>`. For a fix that a PR's finding suggested, use `triage/pr-<n>-followup` and `triage-pr-<n>-followup`, and reference the PR in the body instead of `Fixes`. If the branch or the directory exists, a previous attempt is there. Read its state and continue from it, or stop and say so in `state`.

## 2. Repro test

Write the test the way the profile describes. It asserts the correct behavior, the one the reporter expected and the specification requires.

The test must fail, and for the reported reason. A failure from an import error, a typo or a timeout in the harness proves nothing. Read the failure output and check that the assertion about the bug is the one failing.

If you cannot make the bug happen in a test, stop here. Remove the worktree and the branch. Return the item doc with the `follow_up` route removed and a `state` that says plainly why, like `No repro in a test: the parser handles the reported input correctly, so the problem likely happens in the caller.` Move the item to `hardware` when the reason is hardware or environment behavior.

## 3. Fix

Make the smallest change that fixes the cause, following the project's instruction files. Then run the checks the profile lists before pushing. At least: the repro test passes, and the tests near the change still pass.

If the fix does not work within reason, keep the worktree for the maintainer. Do not push. Return the doc in `almost` with `state` naming the test file path in the worktree and what you tried. Remove the `follow_up` route, so the routine does not retry the same attempt every hour.

## 4. Commit and push

Commit under the writing identity from `accounts.md`, with a message in the project's format. Push the branch with the push command from `accounts.md` and `HEAD:refs/heads/triage/issue-<n>`.

## 5. Draft PR

Write the body to `<scratch>/pr-body.md`, with no forced line breaks inside paragraphs. Contents:

1. One paragraph on what went wrong, with the evidence.
2. One paragraph on the fix.
3. The test that reproduces it.
4. `Fixes #<n>` for an issue. For a discussion, link it instead, because `Fixes` does not close discussions.

Open it under the writing identity:

```bash
gh pr create --repo <owner>/<repo> --draft --base <default branch> --head triage/issue-<n> --title "<title>" --body-file <scratch>/pr-body.md
```

Right after `gh pr create`, before anything else can fail, record the PR: `gary fix-record <itemId> --pr <number> --branch triage/issue-<n> --run <run> --by routine`, or `--by maintainer` when he started the fix with a click.

The title follows the project's format for PR titles.

Remove the worktree after the PR is open: `git -C <checkout> worktree remove <worktree>`. The branch stays on GitHub.

## 6. Return

Return the issue's item doc as one JSON object and nothing else:

- `section`: `review`, because the maintainer has to read the draft PR.
- `state`: what the fix changes and that the test failed before and passes after. Example: `Draft fix #431 stops the retry loop on a 413. The repro test failed on the default branch and passes with the fix.`
- `links`: `{ "label": "Draft fix", "url": "<PR URL>" }`.
- `routes`: the recommended route is a `reply` as `me` on the issue that tells the reporter a fix is in review and links the PR. The `follow_up` route is gone. The routine applies the profile's autonomous labels and assignments for an opened fix on its own.

Check the doc against the validation checklist in `<core>/skills/triage-routine/references/item-doc.md`.

## Last step

On every exit path, failures and refusals included: release your claims with `gary release <itemId> <kind> --run <run>`, and set the action doc to `done` or `failed`. A doc left `queued` or claimed blocks the item, because such docs do not expire.
