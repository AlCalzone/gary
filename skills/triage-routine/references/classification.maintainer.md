# Quick classification

Read this file, then `<profile>/rules/classification.md`, then the `<personal>` files, shared first. Later wins.

Draft PRs never reach the routine. `gary snapshot` leaves them out, so they get no review, no board item and no label changes. A draft that is marked ready appears as a new item. The draft fix PRs the routine opens itself are reachable through the link on their issue's item.

Quick classification uses the snapshot data: author and author type, labels, draft flag, head SHA, CI rollup, review decision, changed file paths, the last 5 comments with author and association, their `replies` and `replyCount`, comment count, `updatedAt`, and `facts` (see "Facts first"). It decides the section and the routes.

## Facts first

Every snapshot entry carries `facts`, computed in code. Use them as given and never re-derive them from the thread:

- `facts.timeline`: `[{ at, author, side, kind }]`, oldest first, the newest 200 events. `side` is `us`, `them`, `automated` or `bot`, and `kind` is `opened`, `comment`, `reply`, `review` or `thread_comment`. `facts.timelineTruncated` is set only when older events are missing. Who spoke last is `facts.lastSpeaker`, with `facts.lastUsAt` and `facts.lastThemAt`. Who we wait on is `facts.waitingOn` (`us`, `them` or `nobody`, decided only by `us` and `them` events), and for how long `facts.waitingDays`.
- PRs: `facts.ciGreen`, `facts.dependencyOnly`, `facts.touchesSensitive`, `facts.openThreadCount`, `facts.approvedBy`, `facts.changesRequestedBy`, `facts.isClean`.
- Issues and discussions: `facts.hasClosingPr` (an open or merged PR closes it), `facts.isAnswered`, `facts.authorIsUs`.

Read the thread text only for what was said: what was asked, what was answered, what is open. A statement like "nobody replied since" comes from `facts.lastSpeaker` and `facts.timeline`, never from reading the top-level comments. When a discussion's `replyCount` is larger than the replies in the snapshot entry and you need the wording of a reply, fetch the thread with the discussion query from the `triage-issue` skill. When the data is not enough for a confident call, pick the most likely section and make the item a full-review candidate.

`side: "automated"` marks comments the bot posted from workflows, matched by the profile's `automatedComments`. They count neither as our request nor as our reply. Who counts as "us" is in `accounts.md`. Dependency update bots and CI bots count as neither side.

## Solved and closed threads

A thread that is closed on GitHub never reaches the board. The snapshot only fetches open ones, and the routine deletes the item when a thread closes. Never write a `close` route or a "Close" hint for a thread that is already closed. If you meet one anyway, give it no routes and `reviewDepth: "pending"`. The next snapshot removes it.

An open thread whose problem is solved is done. That covers a reporter who fixed it themselves, a workaround that worked, and a merged fix. Classify it as `easy` with `solved: true` and effort 1 or 2. Write `state` as the outcome, like `Reporter fixed it by clearing the cache.` The recommended route is `close` as `me` with reason `completed`:

- The route carries a brief closing message (`item-doc.md`, `close`), like `Good to hear that clearing the cache fixed it. Closing this.` Name the release that contains the fix when there is one, and what to do if the problem returns when that helps. Hint `Close: solved`.
- Leave the text out only when our side's last comment already closes the thread in words.
- A discussion with a correct answer that is not marked: a `chore` route with `answer_discussion` and that comment's `commentId` instead, because a discussion is done once the answer is marked.

A follow-up idea is welcome when it is useful. It passes when all three hold:

- It would have prevented this report or made it much shorter, for example a clear error where the software stayed silent.
- More users will plausibly hit the same thing. A one-off caused by a broken setup does not count.
- You can name the concrete change: the behavior, and the file or module it belongs to.

An idea that passes gets one finding with severity `idea`, written as the concrete change, and a `follow_up` route. The finding's `routeId` names the route, and the route's `params.finding` is the finding's index (`item-doc.md`). Pick the actor as `item-doc.md` describes: `agent` when a test can cover it, `bot` to file an issue for a larger change, `me` when it is a decision that should carry the maintainer's name. The recommended route stays the closing one, and `state` stays the outcome. An idea that fails any of the three is left out completely: no finding, no route, no mention in `state`, the hint or the story.

Something really important is different from an idea: data loss, a security problem, a crash or hang. Then the thread is not done. Say in `state` why it matters and classify it by the other rules.

## Sections

Check the rules top to bottom. The first match wins. The section values are the ones in SPEC.md.

### `active`: someone waits for our reply, and the conversation is live

Every rule in this section also needs `facts.waitingDays` to be at most `activeMaxWaitDays` (config, 14 by default). While it is, `active` wins over `easy` and over "Open review feedback". A question that sat longer is no longer active communication. Classify such an item by the remaining rules below as if the question were not there, set `waitingDays`, and name the open question in `state`. The reply stays as an alternative route.

- `facts.lastSpeaker` is `them`, and that last message asks something. Signals: it ends in a question mark, mentions the maintainer (`@<me>`), or asks "can you", "should I", "any update".
- A reporter answered a request for info: the reporter commented after our request. A contributor who answered our question on a PR counts the same. The profile may name a label that marks such requests.
- A new issue or discussion in a support category has no comment from our side yet.
- A contributor asks for a re-review after pushing changes ("addressed", "updated", "PTAL") and also asks a question. Without a question, the re-review goes to `review` or `almost` after the full review.

### `easy`: an obvious decision

The section follows his effort to decide, not the number of steps after his click. `easy` means the decision is obvious and the expected change is small: a reorder, a missing field, a typo-level fix, one or two `valid` review comments with clear fixes. That holds for `take_over`, `address_review` and `drive` too. `effortMinutes` is 1 or 2.

- A PR with `facts.isClean`: approved, `facts.ciGreen`, no open review feedback (see "Open review feedback" below). Recommended route: `merge` as `me`.
- A clean PR by the bot or a dependency bot (`facts.dependencyOnly` or a bot author, `facts.ciGreen`), that lacks his approval: recommended `merge` as `me`, with a `why` that says he approves on the PR page. Never a bot approval on a bot PR. For a dependency update, say in `state` which package and version range it changes. A major version bump goes to `review` instead.
- The maintainer's own PR, clean, CI passing, no open threads: recommended `merge` as `me`. With a bot, add a `review` with `event: "approve"` as the bot as the alternative, because he cannot approve his own PR.
- An issue whose fix is merged. Signals: a comment links a merged PR, "Fixed by #…", or the snapshot shows a closing PR. Recommended route: `close` with reason `completed` and a short text naming the fix and the release.
- A question with a direct answer from the docs or the changelog: a `reply` route. A discussion with a correct answer that is not marked: a `chore` route with `answer_discussion` and `params.commentId`.
- A duplicate: `close` with reason `duplicate`, `params.duplicateOf` and a reply that links the original.
- A report that belongs in a repo from the profile's `relatedRepos`: a `move` route to that repo (`item-doc.md`). A report for a project outside the org: `close` with reason `not_planned` and a reply that links the right place.

- A PR whose only problem is formatting or lint autofix (`autofix.changes`, nothing else): recommended `format`, with `merge` as `me` as the alternative. A red CI from only the lint or format job does not count against it.

### `almost`: he has to think

He has to think about whether to act or about the content: a behavior change, several threads with mixed verdicts, a verdict that needs his domain check, a decision on an open question. The route for PRs we would fix ourselves follows "Who may push to a PR" in `item-doc.md`: `take_over` on a contributor PR that is not taken over, `drive` or `address_review` on the others. `effortMinutes` is 5 or more.

- A PR whose full review found only `minor` or cosmetic findings. Recommended route: `review` with `event: "comment"`, inline comments and a summary, with an approval as the alternative. At least one `major` or `blocker` finding makes it `event: "request_changes"` (`item-doc.md`, `review`).
- A PR with failing CI where the failure comes from the PR's own change and the fix is small.
- An issue or feature request that only needs the maintainer's yes or no, like "accept this API?". Put the open question in `state`.
- A PR by the bot or a dependency bot whose CI fails because of its own change, when the fix is small: `take_over` with `mode: "push"`.
- The maintainer's own PR with open review threads: `drive` (rule in `item-doc.md`, "Who may push to a PR").

### `review`: a human must read the code

- A contributor or bot PR with substantial code changes where the agent review is done. The agent review lowers the effort. It does not replace the maintainer's reading.
- Any PR with `facts.touchesSensitive`, a path in the profile's `sensitivePaths`. Say which paths in `state`.
- A PR with `blocker` or `major` findings that need the maintainer's judgment before the contributor gets feedback.
- A dependency PR with failing CI or a major version bump.
- PRs by the bot or with `authorType: "copilot"`, until the maintainer approved them. Agents wrote them and he has to review them himself.

### `deferred`: waiting on others, or large

- We wait on the reporter: `facts.waitingOn` is `them`, because our last message asked them for something, or asked them to try something and report back, like upgrading, re-interviewing or testing a build. No routes, so the item stays off the board until it changes on GitHub or our request is older than `activeMaxWaitDays`. Then the recommended route is `close` with reason `not_planned` (`item-doc.md`).
- Changes requested, and no new commits since that review.
- The maintainer's own PR that his own account has not finished: merge conflicts, failing CI his change caused, or a stacked PR waiting on its base. No routes.
- Feature requests and enhancements that need design work or a large effort. The profile may name labels for that.

### `hardware`: needs real hardware

The item cannot be reproduced without real hardware or an environment the agent lacks. The profile's `rules/classification.md` says what the agent's test setup can and cannot emulate in this project. The item goes here when the next step needs a person with that hardware. If the evidence already shows the cause, it is an answer and goes to `easy` or `active`.

## Open review feedback

`reviewDecision` alone does not tell you whether a PR is ready. A review with state `COMMENTED` never changes it, and that is how most review bots review. Look at `reviews` and `openThreads` in the snapshot entry:

- `openThreadCount` above 0: unresolved review threads exist. Name the count and who opened them in `state`, like `Approved, but a review bot left 2 open threads after the approval.`
- A review that arrived after the latest approval, from a person or a bot, with change requests or recommendations in its body.

A PR with open review feedback never gets a recommended `merge`. It is `easy` when one or two `valid` threads have clear fixes and the rest is obvious, `almost` when he has to check verdicts or content, `review` when the code needs his reading. It is a full-review candidate. The full review judges each open thread in `threads`: `valid`, `optional` or `wrong`, with a note. Once every thread has a verdict, the route follows "Who may push to a PR" in `item-doc.md`: `take_over` on a contributor PR that is not taken over, `drive` or `address_review` on the others. Outdated threads that are not resolved count as open. The agent behind it can push only when the account setup allows pushes and the PR allows it: a fork PR needs `maintainerCanModify: true`, a branch inside the repo needs nothing extra. When it cannot push and a thread is `valid`, recommend a `review` route that asks the contributor instead.

Bot reviewers are often right about real bugs and often wrong about project conventions. Never dismiss a thread because a bot wrote it, and never treat it as settled because a bot wrote it.

## Sensitive paths

A PR changing a path in the profile's `sensitivePaths` gets the fact named in `state` and goes to `review`, at least. Such paths can run code with repo secrets, change what agents like this one do, or pull in new code. A contributor PR touching them deserves a closer look even when the change looks harmless.

## No routes

Some items need nothing from the maintainer right now. They get no routes, and the board does not show them:

- Nothing can be done until someone else acts: the reporter owes a log, the contributor owes a change, a vendor owes an answer.
- Informational issues, like an announcement or a tracking issue.
- The maintainer's own notes and backlog ideas.
- Answered discussions where no reply is owed.
- Items that need analysis first. They get `reviewDepth: "pending"`, and the routine reviews them without a click.

- An issue whose decision lives on an open PR, because `facts.hasClosingPr` is true or a PR is clearly its companion. `state` names the PR item, like `Decided with pr-412.` The decision appears once on the board, on the PR.

Such an item comes back when it changes on GitHub. The one exception is a close that becomes due: after `activeMaxWaitDays` of waiting on a reporter, the recommended route is `close` with reason `not_planned`.

## Full-review candidates

Items that need analysis before they can show up go first, because without routes they are invisible: every item at `reviewDepth: "pending"`, and every PR with an `unjudged` thread. The routine takes them before any other candidate.

A changed item is also a candidate when a full review adds information the snapshot lacks:

- every contributor PR,
- every item classified `active`,
- PRs by the bot or with `authorType: "copilot"` whose head changed,
- issues and discussions with new comments from outside our side.

These usually need no full review and stay at `quick`: dependency update PRs with passing CI, the maintainer's own PRs without open threads, and items where only labels changed. The maintainer's own PRs with open threads are candidates, because their threads need verdicts.

When a PR was fully reviewed at the same head SHA and only new comments arrived, reuse the old findings. Reclassify from the new comments, and review in full only when a comment asks something that needs the code.

## Priority

`priority` is 1 for the top of a section. The maintainer works a section from the top, so cheap decisions come first. Order within a section:

Work the maintainer asked the agent for comes back first. An item whose agent job finished since he last handled it (a take-over, an address-review, a drive, a format, a fix he started) and that now only needs his decision goes to `easy`, at the very top, before everything else, newest result first. He asked for it and is waiting to finish it. This holds whoever authored the PR. It does not hold while CI still runs on the pushed commit, or when the job left something open that needs thought: then the normal rules place it.

After those, in every section, other people come before our own work: first items by outside contributors and reporters, then items by the maintainer himself, then items by bots and agents. Someone outside is waiting on the first group, and nobody waits on the others. Within each of these groups:

- `active`: longest wait first.
- `easy`: lowest `effortMinutes` first, then merges, closes, answers.
- `almost` and `review`: lowest `effortMinutes` first, then highest `waitingDays`.
- `deferred` and `hardware`: newest `updatedAt` first.

## Autonomous labels and assignments

Write these into the item's `wants` with a `wantsReason` (`item-doc.md`). The routine applies them every run with `gary action --autonomous <file>` (`label` with `params.add` or `params.remove`, `assign` with `params.assignees`) until the snapshot shows them. `--autonomous` makes the code refuse labels outside `autoLabels`. Only labels in the profile's `autoLabels` qualify, and only under the conditions the profile's rules state. Each change records a fact that is already true on GitHub. A label that states a judgment becomes a `chore` route with `action: "label"`, and only when the label is the whole job.

A label that marks "we asked for info" becomes true only after the request is on GitHub, which takes a click. Never add it before. The reply route that makes the request carries the same label in `params.alsoLabel` (`item-doc.md`), so one click can post and label. `wants` stays the fallback for a reply he posted without that button: it holds the label only once the request is visible on the timeline. `wants` and `alsoLabel` never point in opposite directions: a label one adds, the other never removes. "Waiting on the reporter" also covers a message that asked them to try something and report back.

The `reason` of every autonomous action describes the last exchange on the timeline correctly: who asked what, who answered, what is open now. Example: `The maintainer asked for a re-interview log. The reporter sent it in a reply. The maintainer then asked them to upgrade and report back, which is open.`

## Bot commands

The profile's `botCommands` lists commands that the repo's own automation reacts to. Such automation usually ignores comments by the bot itself, and board posts come from the bot. Never put a bot command into a route's `text`. When a command would solve the item, write it into a finding, so the maintainer can paste it himself. The `move` route with `to: "issue"` exists only when `botCommands.escalate` exists.
