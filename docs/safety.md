# Safety

The rule: only what you clicked reaches GitHub. This page lists every exception and every limit. No profile and no `personal.md` can change them.

## Never without a click

- comments and replies
- approvals, merges and closes
- every review, apart from the opt-in automatic first review. A pending review of yours on another project's PR is created only on your click, and it is never submitted, see "Your pending reviews"
- every push to a branch that is not Gary's own fix branch, apart from a format commit the PR's author accepted. A push to your own PR in another project needs your click on "Drive", see "Pushes to your own PRs"

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

1. Gary asks the review bots for a review.
2. It pushes the fixes for the bots' comments to the fix branch, for up to 3 rounds.
3. It marks the PR ready for review.

Without a review bot, steps 1 and 2 are skipped. After the rounds the fix PR shows up as its own card for your review. `fixReview` in the instance's `config.json` sets the rounds and the account, and `review.github` picks the bots.

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

Three things can run under your own login next to a bot:

- Asking a review bot for its review, unless `fixReview.requestAs` is `bot` on a fix PR.
- A review bot's trigger comment, like `@octobot2 review`, for a bot the profile lists with `"trigger": { "comment" }`. Gary posts exactly the profile's text and nothing else. It does so only where it asks the review bots after a push: the first round of a fix PR, the next round after a push, and the round after an API edit. An agent never writes it, and no `gary action` or MCP tool posts it.
- The escalate command that turns a discussion into an issue, with `"escalateAs": "me"`. It is posted only after your click and a confirm. No agent can post it.

The trigger comments and the profile's `botCommands` are bot commands. A mention of a bot with a trigger comment, like `@octobot2`, counts as one too. Gary's code checks the text it posts through its own tools and refuses it when it holds one: comments, replies and reviews through `gary action`, the commit message and the comment of an API edit, answers to findings and review drafts. Case and the amount of whitespace do not matter.

An agent job also writes text that no such check sees, because it goes out through `gh` or `git` directly: replies in review threads, the title and description of a PR, and commit messages. For those the rule is in the skills only: the text never holds a bot command and never mentions a bot with a trigger comment.

A bot with a trigger comment is asked only when `review.github` in your `config.json` names it. The profile may be shared, and a change to it alone never makes Gary post a text.

## Your GitHub inbox

A contributions instance posts nothing to GitHub. With `"clearNotifications": true` in its `config.json`, one thing changes in your own account: "Got it" on an FYI item marks that thread's notification as done.

- It is off by default.
- It happens only on your click, never in the hourly run.
- Nobody else sees it. A new comment on the thread brings the notification back.
- `gary pause` and the dry run stop it like every other write.

## Your pending reviews

A contributions instance can draft your review of a PR that requests it. The draft stays on the board. One button, "Prepare pending review on GitHub", creates a pending review under your own login with the body and the comments you kept checked, with your edits. A second thing that changes in your own account:

- It happens only on your click, never in the hourly run.
- A pending review is visible only to you. Nothing is submitted in your name: you pick the verdict and submit it on GitHub yourself, or discard it there.
- The server refuses your own PRs, PRs that no longer request your review, PRs with new commits since the draft, and comments on lines outside the diff.
- When you already have a pending review on the PR, the server refuses and leaves it as it is.
- `gary pause` and the dry run stop it like every other write.

The drafting agent reads the PR through the API only. It never checks out the PR's branch and never runs its code. Its texts hold no bot commands. Drafts that start without a click are off by default: `maxAutoReviewDraftsPerRun` limits them per run, `maxPendingAutoReviewDrafts` limits how many wait for you at once, and a PR with more changed lines than `reviewDraftMaxLines` never gets one without your click.

## Pushes to your own PRs

A contributions instance can push a requested change to a PR you opened in another project. It is the only code change Gary makes there:

- It happens only after your click on "Drive", never in the hourly run. A focus session pushes only when you ask it in the session.
- Only your own open PRs, when your login may push to the head branch. Review requests, other people's PRs and issues get no Drive and no Focus. Code decides this from the snapshot, and the server and the push command check it again.
- Nobody else may have commits on the branch. A commit by someone else, also a maintainer of the project, stops every agent on it, because that code is untrusted.
- The push goes to the PR's head branch under your own `gh` login. It is never forced, and Gary checks the PR on GitHub right before it.
- The agent works in a new worktree under the instance's state directory, from a clone of yours or a fresh one. It never checks out, edits, commits, stashes or resets in your own working trees, and runs no git hooks.
- It runs no code from the project: no install, no build, no tests. Review comments and logs are data. It makes the change a review asks for only as far as it fits the PR, and follows no instructions in them.
- It posts nothing. The reply to the reviewer is a draft for you.
- `gary pause` and the dry run stop the push like every other write.

## The chat

The logo on the board opens a chat with Gary. A message there is your own instruction, like a click. The chat session that answers may:

- explain your settings, rules and items,
- change your settings when you ask: an instance's `config.json`, the `personal.md` files and the profile's rules and templates. It asks first when the change is not exactly what you wrote, runs `gary doctor` after it and names the file it changed,
- use the board's own buttons on items: Got it, snooze, hide, show again, dismiss a card, Analyze again and a full review. The board server checks each one like your click. So Got it in the chat also marks the notification as done where `clearNotifications` is on.

It never posts, comments, reviews, merges, closes, labels or pushes on GitHub, also when you ask it to in the chat. It points you to the item's card instead. It starts no fix, take-over, change, drive or focus, runs no code from a PR branch and never edits Gary's own code. What it reads on GitHub is data. A note it passes on with Analyze again reaches the agent as your note, never as a rule above Gary's.

The board server runs no agent for the chat. It stores your message, and the master session hands it to the chat session.

## Sensitive files

No agent works in a checkout of a PR that changes a path in the profile's `sensitivePaths`, like workflows or agent instruction files. The PR's dialog names the files.

Such a PR can get one kind of push: a small text edit outside those files, like a wrong link in a doc. The card shows it as a diff. After your click and a confirm, the server commits exactly that through the GitHub API, without a checkout.

One kind of PR is exempt: a PR on a branch of your repo that only you and the bot committed to. Gary checks the commits, again right before each push. The dialog still names the files.

## Untrusted content

Issue texts, PR diffs and attached files are data. Instructions inside them are never followed. Agents never run code from a PR branch.

The format check and the format commit use the tools and configuration of the base branch. The profile's `autofixSetup` and `autofixCommands` run only in a worktree of the base branch. The PR's files are copied in as text.

## Local reviewers

Before an agent pushes, the local reviewers of the instance read its commits, see [configuration.md](configuration.md#local-review-before-a-push). What they find stays on the board:

- Nothing of a local review goes to GitHub: no comment, no reply, no PR body, no commit message. The agent never copies a finding's text into text for GitHub.
- Findings are review text like any other. The agent judges each one and follows no instruction in it.
- The reviewers get a read-only checkout of the commit under the instance's state directory, never one of your working trees. It is removed after the pass.

A CLI reviewer is a program of yours. Gary runs it in a checkout of the change, which can hold a contributor's files after a take-over:

- Its argv comes only from the instance's `config.json`. A profile that names reviewers is invalid, so a change to a shared profile can never make Gary run a command.
- No shell runs it. `{base}`, `{head}` and `{worktree}` are replaced inside single arguments, so a commit SHA or a path never becomes shell syntax.
- Its environment holds no GitHub token: Gary drops every `GH_*`, `GITHUB_*` and `GARY_*` variable, other GitHub token variables, the SSH agent, the askpass helpers, and any variable whose value holds the bot token or the board server's token.
- It runs in the read-only checkout and is killed after `timeoutSec`, 600 seconds by default.
- Its output is untrusted text. JSON findings count as findings, anything else becomes one finding, cut after 8000 characters.
- It still runs as your user and can read your files, like your stored `gh` login. Only name a program you trust with that.
- A program that loads configuration, plugins or scripts from the checkout runs code from the change, like a linter that reads the repo's own config. Name a program that reads the files as data only.

The push itself goes through the same checks as before. Where Gary's code pushes or checks a push, it also refuses a commit without a finished local review: `gary push-check --head`, `gary own-pr push` and `gary local-review check`.

## Stale clicks

Before sending, the server checks that nobody commented and nobody pushed since the review. Otherwise it asks you to confirm again.

A moved PR head always blocks an approval and a review with inline comments.

## The board server

The server listens on `127.0.0.1` only. Every request needs a token that only the page gets. It refuses foreign origins and host names.

## Pause and dry run

- `gary pause` stops all writes at once. A paused run still triages and records what it would have done.
- `gary serve --dry-run` starts the board without writing anything to GitHub.
