# Fix mode: repro test, fix, draft PR

The routine starts fix mode for an item whose triage returned a `follow_up` route with `as: "agent"`, or when the maintainer clicked one. That item is usually an issue, sometimes a PR whose finding suggested a separate fix. You get the item doc, the snapshot entry, the route's `text` with the plan, and `params.finding` when the request named one. The goal is a draft PR that the maintainer can review: a test that fails on the default branch, the smallest fix that makes it pass, and a description he can check in a minute.

The profile's `rules/issues.md` holds the project's commands and conventions: how to set up a worktree, how to write and run the repro test, which checks to run before pushing, the commit message format. Read it before you start.

Opening the draft PR is one of the few things the routine may do without a click. It needs a writing identity that may push (`<core>/skills/triage-routine/references/accounts.md`). Without one, stop and return the item unchanged with the reason in `state`. The limits are strict:

- Work only in a new worktree on a new branch from `origin/<default branch>`.
- Push only that branch. Never push to the default branch or to any existing branch, and never to a contributor's fork.
- Open the PR as a draft. Never comment on the issue, never merge, approve or close.
- Requesting the review bot's review, marking the PR ready and requesting the maintainer's review happen only through `gary fix-review` (step 5a), which does them only for a fix PR recorded in `fixes.json` and only when the instance's `fixReview` setting is on. Never do any of them by hand.

## 0. Claim

Claim the item with `gary claim <itemId> fix --run <run>`, plus `--request <action doc id>` when a clicked `start_fix` started you, and release it with `gary release <itemId> fix --run <run>` when you are done, also on failure. Exit code 3 means another run holds it, or for an autonomous fix that the limit `maxPendingAutoFixes` is reached: stop and return the item unchanged. Pass the limit's message on to the caller, which names it in the run summary.

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

If you cannot make the bug happen in a test, stop here. Remove the worktree and the branch. Return the item doc with the `follow_up` route removed and a `state` that says plainly why, like `No repro in a test: the parser handles the reported input correctly, so the problem likely happens in the caller.` Set `needsHardware: true` and the category `decide` when the reason is hardware or environment behavior.

## 3. Fix

Make the smallest change that fixes the cause, following the project's instruction files. Then run the checks the profile lists before pushing. At least: the repro test passes, and the tests near the change still pass.

If the fix does not work within reason, keep the worktree for the maintainer. Do not push. Return the doc as `decide` with effort 5 or more and `state` naming the test file path in the worktree and what you tried. Remove the `follow_up` route, so the routine does not retry the same attempt every hour.

## 4. Commit and push

Commit under the writing identity from `accounts.md`, with a message in the project's format. Push the branch with the push command from `accounts.md` and `HEAD:refs/heads/triage/issue-<n>`.

## 5. Draft PR

Write the body to `<scratch>/pr-body.md`, with no forced line breaks inside paragraphs. Contents:

1. One paragraph on what went wrong, with the evidence.
2. One paragraph on the fix.
3. The test that reproduces it.
4. What you could not verify, in one sentence under the evidence, written for the maintainer, like `The manual does not list the parameters. They come from the ZWN3020 file.` Leave it out when everything is verified.
5. `Fixes #<n>` for an issue. For a discussion, link it instead, because `Fixes` does not close discussions.

The body describes the change and its evidence. It never @-mentions the reporter or anyone else, and it never asks anyone to test, check or confirm something. `Fixes #<n>` is the only link to the reporter. This holds also when the route's `text` or the request's instructions ask for such a question: leave that part out and say so in the returned `state`.

One switch changes this. When the `start_fix` action has `params.askReporter: true`, the maintainer switched on "Ask the reporter to test" on the card. Then, and only then, the body ends with one request to the reporter: mention them once, say exactly what to test, and say how to install the PR's build when the profile's `rules/issues.md` describes that. Keep it to a few sentences. An autonomous fix has no click and no such param, so it always asks nobody.

Before you call something unverified, look for a second source. The profile's `rules/issues.md` names the sources of the project, like a product database or a manual. Something a second source confirms is verified, and the body names the source.

Open it under the writing identity:

```bash
gh pr create --repo <owner>/<repo> --draft --base <default branch> --head triage/issue-<n> --title "<title>" --body-file <scratch>/pr-body.md
```

Right after `gh pr create`, before anything else can fail, record the PR: `gary fix-record <itemId> --pr <number> --branch triage/issue-<n> --run <run> --by routine`, or `--by maintainer` when he started the fix with a click.

The title follows the project's format for PR titles.

Remove the worktree after the PR is open: `git -C <checkout> worktree remove <worktree>`. The branch stays on GitHub.

## 5a. Review rounds

Right after `gary fix-record`, hand the PR to its review rounds:

```bash
gary fix-review start --pr <number> --sha <head sha you pushed> --run <run>
```

It answers one JSON object.

- `started: true`: the review is requested and the rounds run as a drive on the PR. The master starts each round when the review arrived, within about a minute. You are done with the PR. Name it in the summary line, like `issue-398: draft fix #431 opened, Copilot round 1 of 3 requested.`
- `started: false` with a `reason`: the rounds are off for this instance. The PR stays a draft, and the hourly run puts it on the board once its CI finished.
- Exit code 4, `paused: true`: nothing was sent. Record `{ itemId, action: "fix_review", params: { pr: <number> }, reason }` in `<run>/would-have.json`.
- Any other failure: the PR stays a draft. Say so in the returned `state`.

`--dry-run` prints what it would send and write.

## 6. Return

Return the issue's item doc as one JSON object and nothing else:

- `category`: `land`, because reading the draft PR is his step that finishes it.
- `state`: what the fix changes and that the test failed before and passes after. Example: `Draft fix #431 stops the retry loop on a 413. The repro test failed on the default branch and passes with the fix.`
- `links`: `{ "label": "Draft fix", "url": "<PR URL>" }`.
- A fix that changed a file under the profile's `sensitivePaths`: `state` names the path and says to read that part of the diff with care, like `Draft fix #431 changes .github/bot-scripts/escalate.cjs. Read that diff with care.` Say nothing about the PR counting as sensitive or about limited pushes. The PR is ours alone while only the bot and the maintainer commit to it. `facts.sensitiveOurs` on its entry shows that.
- `findings`: when the PR body names something you could not verify, the same sentence as a `question` finding, so the maintainer sees it on the board. The fix PR's own item carries it too, once the PR is reviewed for the board.
- `routes`: none, and `"hint": null` and `"effortMinutes": null`. The `follow_up` route is gone, and no route announces the fix: the PR's "Fixes #N" link tells the reporter, and the board keeps the issue out of the plan while the fix PR is a draft or open. The draft PR's own item carries the work. The routine applies the profile's autonomous labels and assignments for an opened fix on its own.

Check the doc against the validation checklist in `<core>/skills/triage-routine/references/item-doc.md`.

## Last step

On every exit path, failures and refusals included: release your claims with `gary release <itemId> <kind> --run <run>`, and set the action doc to `done` or `failed`. A doc left `queued` or claimed blocks the item, because such docs do not expire.
