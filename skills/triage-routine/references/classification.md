# Quick classification

Read this file, then `<profile>/rules/classification.md`, then `<home>/personal.md`. Later wins.

Draft PRs never reach the routine. `gary snapshot` leaves them out, so they get no review, no board item and no label changes. A draft that is marked ready appears as a new item. The draft fix PRs the routine opens itself are reachable through the link on their issue's item.

Quick classification uses only the snapshot data: author and author type, labels, draft flag, head SHA, CI rollup, review decision, changed file paths, the last 5 comments with author and association, comment count and `updatedAt`. It decides the section and the routes. When the data is not enough for a confident call, pick the most likely section and make the item a full-review candidate.

Who counts as "us" is in `accounts.md`. Every other human is a reporter or contributor. Dependency update bots and CI bots count as neither side.

## Solved and closed threads

A thread that is closed on GitHub never reaches the board. The snapshot only fetches open ones, and the routine deletes the item when a thread closes. Never write a `close` route or a "Close" hint for a thread that is already closed. If you meet one anyway, give it no routes and `reviewDepth: "pending"`. The next snapshot removes it.

An open thread whose problem is solved is done. That covers a reporter who fixed it themselves, a workaround that worked, and a merged fix. Classify it as `easy` with `solved: true` and effort 1 or 2. Write `state` as the outcome, like `Reporter fixed it by clearing the cache.` The recommended route is `close` as `me` with reason `completed`:

- The reporter's last comment only reports success or says thanks: no `text`, hint `Close: solved`. A written reply to "thanks, it works now" is noise.
- There is something worth saying, like the release that contains the fix: a one-line `text`.
- A discussion with a correct answer that is not marked: a `chore` route with `answer_discussion` and that comment's `commentId` instead, because a discussion is done once the answer is marked.

A follow-up idea is welcome when it is useful. It passes when all three hold:

- It would have prevented this report or made it much shorter, for example a clear error where the software stayed silent.
- More users will plausibly hit the same thing. A one-off caused by a broken setup does not count.
- You can name the concrete change: the behavior, and the file or module it belongs to.

An idea that passes gets one finding with severity `idea`, written as the concrete change, and a `follow_up` route the finding points to with `routeId`. Pick the actor as `item-doc.md` describes: `agent` when a test can cover it, `bot` to file an issue for a larger change, `me` when it is a decision that should carry the maintainer's name. The recommended route stays the closing one, and `state` stays the outcome. An idea that fails any of the three is left out completely: no finding, no route, no mention in `state`, the hint or the story.

Something really important is different from an idea: data loss, a security problem, a crash or hang. Then the thread is not done. Say in `state` why it matters and classify it by the other rules.

## Sections

Check the rules top to bottom. The first match wins. The section values are the ones in SPEC.md.

### `active`: someone waits for our reply, and the conversation is live

Every rule in this section also needs the waiting comment to be at most `activeMaxWaitDays` days old (config, 14 by default). A question that sat for two months is no longer active communication. Classify such an item by the remaining rules below as if the question were not there, set `waitingDays`, and name the open question in `state`. The answer stays a route, usually the recommended one.

- The last human comment is from outside our side, is newer than our last comment, and asks something. Signals: it ends in a question mark, mentions the maintainer (`@<me>`), or asks "can you", "should I", "any update".
- A reporter answered a request for info: the reporter commented after our request. The profile may name a label that marks such requests.
- A new issue or discussion in a support category has no comment from our side yet.
- A contributor asks for a re-review after pushing changes ("addressed", "updated", "PTAL") and also asks a question. Without a question, the re-review goes to `review` or `almost` after the full review.

### `easy`: done with one click

- A PR with review decision `APPROVED`, CI `passing`, and no open review feedback (see "Open review feedback" below). Recommended route: `merge` as `me`.
- A dependency update PR from a bot with CI `passing`. Recommended route: `merge` as `me`. Say in `state` which package and version range it changes. A major version bump goes to `review` instead.
- An issue whose fix is merged. Signals: a comment links a merged PR, "Fixed by #…", or the snapshot shows a closing PR. Recommended route: `close` with reason `completed` and a short text naming the fix and the release.
- A question with a direct answer from the docs or the changelog: a `reply` route. A discussion with a correct answer that is not marked: a `chore` route with `answer_discussion` and `params.commentId`.
- A duplicate: `close` with reason `duplicate`, `params.duplicateOf` and a reply that links the original.
- A report that belongs in a repo from the profile's `relatedRepos`: a `move` route to that repo (`item-doc.md`). A report for a project outside the org: `close` with reason `not_planned` and a reply that links the right place.

### `almost`: small refinement or one decision

A stalled contributor PR that we can finish faster ourselves gets `take_over` as the recommended route (rules in `item-doc.md`). A PR whose open threads all have a verdict gets `address_review`. Either goes to `easy` when that route plus merge would finish it, otherwise here.

- A PR whose full review found only `minor` findings. Recommended route: `review` with `event: "request_changes"` or `"comment"`, inline comments and a summary.
- A PR with failing CI where the failure comes from the PR's own change and the fix is small.
- An issue or feature request that only needs the maintainer's yes or no, like "accept this API?". Put the open question in `state`.

### `review`: a human must read the code

- A contributor or bot PR with substantial code changes where the agent review is done. The agent review lowers the effort. It does not replace the maintainer's reading.
- Any PR that touches a path in the profile's `sensitivePaths`. Say which paths in `state`.
- A PR with `blocker` or `major` findings that need the maintainer's judgment before the contributor gets feedback.
- A dependency PR with failing CI or a major version bump.
- PRs by the bot or with `authorType: "copilot"`, until the maintainer approved them. Agents wrote them and he has to review them himself.

### `deferred`: waiting on others, or large

- We asked the reporter for something, and nobody outside our side commented since. No routes, so the item stays off the board until it changes on GitHub or our request is older than `activeMaxWaitDays`. Then the recommended route is `close` with reason `not_planned` (`item-doc.md`).
- Changes requested, and no new commits since that review.
- The maintainer's own open PRs without new outside activity.
- Feature requests and enhancements that need design work or a large effort. The profile may name labels for that.

### `hardware`: needs real hardware

The item cannot be reproduced without real hardware or an environment the agent lacks. The profile's `rules/classification.md` says what the agent's test setup can and cannot emulate in this project. The item goes here when the next step needs a person with that hardware. If the evidence already shows the cause, it is an answer and goes to `easy` or `active`.

## Open review feedback

`reviewDecision` alone does not tell you whether a PR is ready. A review with state `COMMENTED` never changes it, and that is how most review bots review. Look at `reviews` and `openThreads` in the snapshot entry:

- `openThreadCount` above 0: unresolved review threads exist. Name the count and who opened them in `state`, like `Approved, but a review bot left 2 open threads after the approval.`
- A review that arrived after the latest approval, from a person or a bot, with change requests or recommendations in its body.

A PR with open review feedback is never `easy` and never gets a recommended `merge`. It goes to `almost` when the points look small, otherwise to `review`, and it is a full-review candidate. The full review judges each open thread in `threads`: `valid`, `optional` or `wrong`, with a note. Once every thread has a verdict, `address_review` is the usual recommended route. The agent behind it can push only when the account setup allows pushes and the PR allows it: a fork PR needs `maintainerCanModify: true`, a branch inside the repo needs nothing extra. When it cannot push and a thread is `valid`, recommend a `review` route that asks the contributor instead.

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

Such an item comes back when it changes on GitHub. The one exception is a close that becomes due: after `activeMaxWaitDays` of waiting on a reporter, the recommended route is `close` with reason `not_planned`.

## Full-review candidates

Items that need analysis before they can show up go first, because without routes they are invisible: every item at `reviewDepth: "pending"`, and every PR with an `unjudged` thread. The routine takes them before any other candidate.

A changed item is also a candidate when a full review adds information the snapshot lacks:

- every contributor PR,
- every item classified `active`,
- PRs by the bot or with `authorType: "copilot"` whose head changed,
- issues and discussions with new comments from outside our side.

These usually need no full review and stay at `quick`: dependency update PRs with passing CI, the maintainer's own PRs, and items where only labels changed.

When a PR was fully reviewed at the same head SHA and only new comments arrived, reuse the old findings. Reclassify from the new comments, and review in full only when a comment asks something that needs the code.

## Priority

`priority` is 1 for the top of a section. The maintainer works a section from the top, so cheap decisions come first. Order within a section:

- `active`: longest wait first.
- `easy`: lowest `effortMinutes` first, then merges, closes, answers.
- `almost` and `review`: lowest `effortMinutes` first, then contributor items before bot items, then highest `waitingDays`.
- `deferred` and `hardware`: newest `updatedAt` first.

## Autonomous labels and assignments

Apply these without a click, with `gary action` (`label` with `params.add` or `params.remove`, `assign` with `params.assignees`). Only labels in the profile's `autoLabels` qualify, and only under the conditions the profile's rules state. Each change records a fact that is already true on GitHub. A label that states a judgment becomes a `chore` route with `action: "label"`, and only when the label is the whole job.

A label that marks "we asked for info" becomes true only after the request is on GitHub, which takes a click. Never add it before.

## Bot commands

The profile's `botCommands` lists commands that the repo's own automation reacts to. Such automation usually ignores comments by the bot itself, and board posts come from the bot. Never put a bot command into a route's `text`. When a command would solve the item, write it into a finding, so the maintainer can paste it himself. The `move` route with `to: "issue"` exists only when `botCommands.escalate` exists.
