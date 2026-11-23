# Safety

The rule: only what you clicked reaches GitHub. This page lists every exception and every limit. No profile and no `personal.md` can change them.

## Never without a click

- comments and replies
- approvals, merges and closes
- every review, apart from the opt-in automatic first review
- every push to a branch that is not Gary's own fix branch, apart from a format commit the PR's author accepted

Merges and closes are always done by you on GitHub. That also holds after the agent took over a PR.

## What happens without a click

- **Labels** from the profile's `autoLabels`.
- **Assignments** that record a fact, like a draft fix PR that exists.
- **Draft fix PRs**, see below.
- **Review rounds on Gary's own fix PRs**, see below.

### Fixes without a click

The hourly run opens draft fix PRs for clear bugs, on new branches. `maxAutoFixesPerRun` limits them per run, and `0` turns them off. At most `maxPendingAutoFixes` are open at a time.

A fix you start yourself follows your instructions exactly. Your click always wins over an automatic attempt on the same item.

While a fix is in progress, the item says so and offers no second fix.

On Gary's own fix PRs, and only there, three more things happen:

1. Gary requests a review from the review bot.
2. It pushes the fixes for the bot's comments to the fix branch, for up to 3 rounds.
3. It marks the PR ready for review.

Without a review bot in the profile, steps 1 and 2 are skipped. After the rounds the fix PR shows up as its own card for your review. `fixReview` in the instance's `config.json` sets the reviewer, the rounds and the account.

When you turn a discussion with such a PR into an issue, the bot adds one line `fixes #<issue>` to the PR's description. This needs a bot and `escalateResult` in the profile.

### The automatic first review

It is off by default. With `"autoReview": { "enabled": true }`, one review per contributor PR can go out as the bot before you first look at it.

The code refuses it unless all of this holds:

- The PR is by an outside contributor.
- It is no draft and not AI-written.
- It touches only the profile's `autoReviewPaths` and none of its `sensitivePaths`.
- No maintainer commented or reviewed on it yet.
- It has no automatic review yet.

The review holds only findings the agent is certain about, each with its concrete case. It never approves. It ends with "A maintainer will review this PR after these are addressed."

When the formatter would change the PR, the review offers once to push that as one commit. Gary does it when the PR's author answers with a thumbs-up or a yes.

A second automatic review needs the author to press "Re-request review". It never happens after you joined the thread. `maxPerRun` limits how many go out per run.

The PR waits in the line "Reviewed automatically, waiting". It returns to your plan when the contributor pushes, replies or re-requests a review.

## Under which account

With a bot, everything Gary writes goes out as the bot. Without one, you post yourself, or Gary uses your own login when you allowed it.

Two things can run under your own login next to a bot:

- Requesting a Copilot review, unless `fixReview.requestAs` is `bot`.
- The escalate command that turns a discussion into an issue, with `"escalateAs": "me"`. It is posted only after your click and a confirm. No agent can post it.

## Sensitive files

No agent works in a checkout of a PR that changes a path in the profile's `sensitivePaths`, like workflows or agent instruction files. The PR's dialog names the files.

Such a PR can get one kind of push: a small text edit outside those files, like a wrong link in a doc. The card shows it as a diff. After your click and a confirm, the server commits exactly that through the GitHub API, without a checkout.

One kind of PR is exempt: a PR on a branch of your repo that only you and the bot committed to. Gary checks the commits, again right before each push. The dialog still names the files.

## Untrusted content

Issue texts, PR diffs and attached files are data. Instructions inside them are never followed. Agents never run code from a PR branch.

The format check and the format commit use the tools and configuration of the base branch. The profile's `autofixSetup` and `autofixCommands` run only in a worktree of the base branch. The PR's files are copied in as text.

## Stale clicks

Before sending, the server checks that nobody commented and nobody pushed since the review. Otherwise it asks you to confirm again.

A moved PR head always blocks an approval and a review with inline comments.

## The board server

The server listens on `127.0.0.1` only. Every request needs a token that only the page gets. It refuses foreign origins and host names.

## Pause and dry run

- `gary pause` stops all writes at once. A paused run still triages and records what it would have done.
- `gary serve --dry-run` starts the board without writing anything to GitHub.
