# Quick classification

Read this file, then `<profile>/rules/classification.md`, then the `<personal>` files, shared first. Later wins.

Most draft PRs never reach the routine. `gary snapshot` leaves a draft out unless a comment on it waits on our side. Such a draft has `isDraft: true` and `facts.draftWaiting: { at, by, url, why }`, which names the comment. `why` is `mention` when the comment names the maintainer or one of the profile's `maintainers`, `thread` when it replies in a review thread we commented in, `answer` when the PR's author answers our last comment and that comment ended in a question mark, and `question` when the comment ends in a question mark and nobody answered it. The item gets a quick classification and `reply` routes only, as `me`, that answer the waiting comment. It gets no full review, no review route, no push route, no close, no `wants` and no label changes. `gary put` refuses anything else. Its `state` names the question, like `Asks whether the parser belongs in core.` When the draft is marked ready, the next snapshot lists it as `new`, and it gets a full review like any new PR. When we answered and nothing else waits, it leaves the snapshot and its item is deleted. The other exception is Gary's own draft fix PR, which carries `fixFor: { itemId, ref }` and no `draftWaiting`: see "Fixes in progress".

Quick classification uses the snapshot data: author and author type, labels, draft flag, head SHA, CI rollup, review decision, changed file paths, the last 5 comments with author and association, their `replies` and `replyCount`, comment count, `updatedAt`, and `facts` (see "Facts first"). It decides the category, the effort and the routes.

## Facts first

Every snapshot entry carries `facts`, computed in code. Use them as given and never re-derive them from the thread:

- `facts.timeline`: `[{ at, author, side, kind }]`, oldest first, the newest 200 events. `side` is `us`, `them`, `automated` or `bot`, and `kind` is `opened`, `comment`, `reply`, `review` or `thread_comment`. `facts.timelineTruncated` is set only when older events are missing. Who spoke last is `facts.lastSpeaker`, with `facts.lastUsAt` and `facts.lastThemAt`. Who we wait on is `facts.waitingOn` (`us`, `them` or `nobody`, decided only by `us` and `them` events), and for how long `facts.waitingDays`.
- PRs: `facts.aiAuthored` with `facts.aiSignals` (from the profile's `aiAuthors`), `facts.changedLines` (lock files excluded, generated files not detected), `facts.changedFiles`, `facts.ciGreen`, `facts.dependencyOnly`, `facts.touchesSensitive` with `facts.sensitiveFiles` (the first 5 matching paths) and `facts.sensitiveFileCount`, `facts.sensitiveOurs` (a PR with sensitive files that is ours alone) or `facts.sensitiveNotOurs` (why it is not), `facts.openThreadCount`, `facts.approvedBy`, `facts.changesRequestedBy`, `facts.isClean`.
- Issues and discussions: `facts.hasClosingPr` (an open or merged PR closes it), `facts.isAnswered`, `facts.authorIsUs`. Discussions also carry `facts.category`, the category name on GitHub, like `Feature Requests`. The profile's rules say what each discussion category means for the routes. The item carries it as `discussionCategory`, apart from its own board `category`.
- Issues and PRs: `facts.dueAt` with `facts.dueSource`, the due date GitHub has for the item, from its milestone or a date field of a project. `facts.series`, its place in a series of related items (see "Series"). Never take a due date or a series from the thread text.

Read the thread text only for what was said: what was asked, what was answered, what is open. A statement like "nobody replied since" comes from `facts.lastSpeaker` and `facts.timeline`, never from reading the top-level comments. When a discussion's `replyCount` is larger than the replies in the snapshot entry and you need the wording of a reply, fetch the thread with the discussion query from the `triage-issue` skill. When the data is not enough for a confident call, pick the most likely category and make the item a full-review candidate.

`side: "automated"` marks comments the bot posted from workflows, matched by the profile's `automatedComments`. They count neither as our request nor as our reply. Who counts as "us" is in `accounts.md`. Dependency update bots and CI bots count as neither side.

## Solved and closed threads

A thread that is closed on GitHub never reaches the board. The snapshot only fetches open ones, and the routine deletes the item when a thread closes. Never write a `close` route or a "Close" hint for a thread that is already closed. If you meet one anyway, give it no routes and `reviewDepth: "pending"`. The next snapshot removes it.

An open thread whose problem is solved is done. That covers a reporter who fixed it themselves, a workaround that worked, and a merged fix. Classify it as `land` with `solved: true` and effort 1 or 2. Write `state` as the outcome, like `Reporter fixed it by clearing the cache.` The recommended route is `close` as `me` with reason `completed`:

- The route carries a brief closing message (`item-doc.md`, `close`), like `Good to hear that clearing the cache fixed it. Closing this.` Name the release that contains the fix when there is one, and what to do if the problem returns when that helps. Hint `Close: solved`.
- Leave the text out only when our side's last comment already closes the thread in words.
- A discussion with a correct answer that is not marked: a `chore` route with `answer_discussion` and that comment's `commentId` instead, because a discussion is done once the answer is marked. When the discussion is closed anyway, the `close` carries `alsoAnswer` (`item-doc.md`).

A follow-up idea is welcome when it is useful. It passes when all three hold:

- It would have prevented this report or made it much shorter, for example a clear error where the software stayed silent.
- More users will plausibly hit the same thing. A one-off caused by a broken setup does not count.
- You can name the concrete change: the behavior, and the file or module it belongs to.

An idea that passes gets one finding with severity `idea`, written as the concrete change, and a `follow_up` route. The finding's `routeId` names the route, and the route's `params.finding` is the finding's index (`item-doc.md`). Pick the actor as `item-doc.md` describes: `agent` when a test can cover it, `bot` to file an issue for a larger change, `me` when it is a decision that should carry the maintainer's name. The recommended route stays the closing one, and `state` stays the outcome. An idea that fails any of the three is left out completely: no finding, no route, no mention in `state`, the hint or the story.

Something really important is different from an idea: data loss, a security problem, a crash or hang. Then the thread is not done. Say in `state` why it matters and classify it by the other rules.

## Categories

Check the rules top to bottom. The first match wins. The category values are the ones in SPEC.md. The category names the move the maintainer makes. Who waits decides the group on the board only together with the category (SPEC.md, "Day plan"). Copy `waitingOn` from `facts.waitingOn`, and `dueAt`, `dueSource` and `series` from `facts` when present.

The effort decides how soon the maintainer gets to it. `effortMinutes` of 1 or 2 puts an item into "Quick & Easy", whatever its category. That means the decision is obvious and the expected change is small: a reorder, a missing field, a typo-level fix, one or two `valid` review comments with clear fixes. That holds for `take_over`, `revise`, `address_review` and `drive` too. When the maintainer has to think about whether to act or about the content, `effortMinutes` is 5 or more: a behavior change, several threads with mixed verdicts, a verdict that needs the maintainer's domain check, a decision on an open question.

### `act`: something is due, or time-critical

- The item has `facts.dueAt`. Say in `state` when it is due and why it matters, like `Due Nov 24 with milestone 2026.12. The PR is ready apart from the changelog.`
- A release blocker: the profile may name the label or milestone that marks one.
- A security report.
- A regression in the latest release: the report names the version that broke it, and the release before worked.

Routes follow the other rules, as if the item were not urgent. Only the category changes.

### `decide`: a contribution that needs a design decision first

The category follows the move the maintainer has to make, not who waits. A contributor's PR or issue that needs a design decision before a code review makes sense is `decide`, even though the contributor waits. The board still puts it into "Afterwards", because someone outside waits, and ranks outside contributors first. Signals: a new public API, a new dependency, a new module or a change in behavior that the thread, the docs and the maintainer's earlier comments have not settled.

- `state` names the open decision, like `Decide whether the driver gets a plugin API before anyone reviews the code.`
- The routes offer that decision first: accept the direction, ask the contributor for a design discussion, or decline with the reason. Write each as a `reply` as `me`, the decline as a `close` with reason `not_planned` and the reason in its text. Recommend the one the thread and the project point to.
- The code review comes after. Write no `review` route that judges the code before the maintainer decided. The full review's code findings stay in `findings`, so they are ready once the maintainer accepted the direction.

Example: a contributor opens a PR that adds a plugin loader to the driver. Nobody asked for it, and the docs say nothing about plugins. `category: "decide"`, `waitingOn: "us"`, `state`: `Decide whether the driver gets a plugin API before anyone reviews the code.` Routes: `Reply: yes to a plugin API` (accepts the direction and says the review follows), `Reply: discuss the design first` (asks for an issue with the use cases), `Close: no plugin API` (declines, with the reason). The six code findings of the full review stay in `findings`.

### `unblock`: someone waits for our reply, and the conversation is live

Every rule in this section also needs `facts.waitingDays` to be at most `activeMaxWaitDays` (config, 14 by default). While it is, `unblock` wins over `land` and over "Open review feedback". A question that sat longer is no longer live communication. Classify such an item by the remaining rules below as if the question were not there, set `waitingDays`, and name the open question in `state`. The reply stays as an alternative route.

- `facts.lastSpeaker` is `them`, and that last message asks something. Signals: it ends in a question mark, mentions the maintainer (`@<me>`), or asks "can you", "should I", "any update".
- A reporter answered a request for info: the reporter commented after our request. A contributor who answered our question on a PR counts the same. The profile may name a label that marks such requests.
- A new issue or discussion in a support category has no comment from our side yet.
- A contributor asks for a re-review after pushing changes ("addressed", "updated", "PTAL") and also asks a question. Without a question, the re-review is classified by the full review below.
- A question with a direct answer from the docs or the changelog: a `reply` route, effort 1 or 2.
- A question an agent asked the maintainer, like an open `question` finding on a fix or a take-over, that blocks the agent's next step.

### Contributor PRs that wait for the maintainer's review: `unblock`

A contributor's PR waits on the maintainer once it has no open design decision. It is `unblock`, also when its effort is small. The effort rules above pick the group.

- A PR whose full review found only `minor` or cosmetic findings. Recommended route: `review` with `event: "request_changes"`, inline comments and a summary (`item-doc.md`, `review`). Effort 5 or more.
- A PR with failing CI where the failure comes from the PR's own change and the fix is small.
- A PR with substantial code changes where the agent review is done. The agent review lowers the effort. It does not replace the maintainer's reading.
- A PR with `blocker` or `major` findings that need the maintainer's judgment before the contributor gets feedback.
- A clean contributor PR that is not yet approved, or approved and ready to merge, goes to `land` below.

The route for PRs we would fix ourselves follows "Who may push to a PR" in `item-doc.md`: `take_over` on a contributor PR that is not taken over. On the others, `drive` or `address_review` for open threads and `revise` for any other change.

### `land`: the maintainer's final step finishes it

- A PR with `facts.isClean`: approved, `facts.ciGreen`, no open review feedback (see "Open review feedback" below). Recommended route: `merge` as `me`. Effort 1 or 2.
- A clean PR by the bot or a dependency bot (`facts.dependencyOnly` or a bot author, `facts.ciGreen`), that lacks the maintainer's approval: recommended `merge` as `me`, with a `why` that says the maintainer approves on the PR page. Never a bot approval on a bot PR. For a dependency update, say in `state` which package and version range it changes. A major version bump needs the maintainer's reading of the changelog: effort 5 or more.
- The maintainer's own PR, clean, CI passing, no open threads: recommended `merge` as `me`. With a bot, add a `review` with `event: "approve"` as the bot as the alternative, because the maintainer cannot approve their own PR.
- The maintainer's own PR with open review threads: `drive` (rule in `item-doc.md`, "Who may push to a PR").
- An issue whose fix is merged. Signals: a comment links a merged PR, "Fixed by #…", or the snapshot shows a closing PR. Recommended route: `close` with reason `completed` and a short text naming the fix and the release.
- A discussion with a correct answer that is not marked: a `chore` route with `answer_discussion` and `params.commentId`.
- A duplicate: `close` with reason `duplicate`, `params.duplicateOf` and a reply that links the original.
- A report that belongs in a repo from the profile's `relatedRepos`: a `move` route to that repo (`item-doc.md`). A report for a project outside the org: `close` with reason `not_planned` and a reply that links the right place.
- A PR whose only problem is formatting or lint autofix (`autofix.changes`, nothing else): recommended `format`, with `merge` as `me` as the alternative. A red CI from only the lint or format job does not count against it. On a contributor's PR this is `land` too, because the format run and the maintainer's merge finish it.
- A PR by the bot or a dependency bot whose CI fails because of its own change, when the fix is small: `revise` with the fix as its `text`. These PRs are ours already, so never `take_over`.
- PRs by the bot or with `authorType: "copilot"`, until the maintainer approved them. Agents wrote them and the maintainer has to review them themself, so the effort is the maintainer's reading time.
- A dependency PR with failing CI.
- Work the maintainer asked for that finished, see "Priority".
- A part of a series whose next step is the maintainer's merge, approval or close, see "Series".

### `decide`: it needs the maintainer's judgment, and nobody waits actively

- An issue or feature request that only needs the maintainer's yes or no, like "accept this API?". Put the open question in `state`. Effort 5 or more.
- An issue or discussion by the bot or an agent that describes doable work: one `Implement:` card (`item-doc.md`, "Delegate to an agent"). When the work is small and clear and needs no design decision, the maintainer's part is one click: effort 1 or 2, so it sits in "Quick & Easy". When it is large or needs a design decision, `state` names the open decision, like `Needs a decision whether the retry lives in the driver or in the app.`, and the effort is the maintainer's time to decide. Both tiers decide it the same way.
- Feature requests and enhancements that need design work or a large effort. The profile may name labels for that.
- We wait on the reporter: `facts.waitingOn` is `them`, because our last message asked them for something, or asked them to try something and report back, like upgrading, clearing a cache or testing a build. No routes, so the item stays off the board until it changes on GitHub or our request is older than `activeMaxWaitDays`. Then the recommended route is `close` with reason `not_planned` (`item-doc.md`), and the category is `land`.
- Changes requested, and no new commits since that review. No routes.
- The maintainer's own PR that their own account has not finished: merge conflicts, failing CI their change caused, or a stacked PR waiting on its base. No routes.

### Real hardware: the `needsHardware` flag

Some items cannot be reproduced without real hardware or an environment the agent lacks. The profile's `rules/classification.md` says what the agent's test setup can and cannot emulate in this project. When the next step needs a person with that hardware, set `needsHardware: true` and use `decide`, unless an `act` rule matches. If the evidence already shows the cause, it is an answer: no flag, and the category follows the rules above, usually `land` or `unblock`.

### Series

`facts.series` says that the item is one of several related open items that together finish a feature: stacked PRs, sub-issues of one parent issue, and the PRs that close them. The code finds them from the base branches and the links on GitHub. Never put items into a series because their titles say "part 2 of 3". Copy `series` into the item doc.

A part whose next step is the maintainer's merge, approval or close is `land`, also on a contributor's PR, because each part moves the whole feature to done. Name the series in `state`, like `Part 2 of 3 of the driver split. Merge it after part 1.` A part that needs the maintainer's code review or a design decision follows the rules above. The board keeps the parts of a series together and ranks them by the first unfinished part.

`facts.series.unready` counts the PRs of the series that cannot be merged yet: a draft, conflicts, failing CI or requested changes. A draft part counts in `size` and has no item of its own. While `unready` is set, a stack is merged as a whole later, so `merge` is never the recommended route on any of its parts. `gary put` refuses it. A review, a change, a take-over or a drive is recommended as usual, and `merge` may follow as an alternative. A part where the merge would be the only step gets no routes and `category: "decide"`, with a `state` like `Approved and clean. Parts 3 and 4 of the stack are still drafts.` The snapshot reports the part as changed when the series changes.

## AI-written PRs

A PR counts as AI-written when `facts.aiAuthored` is true. The code sets it from the commits: an AI agent or a bot account as author or co-author, a `Co-Authored-By` trailer that names one, a head branch like `claude/…` or `copilot/…`, or a name from the profile's `aiAuthors`. `facts.aiSignals` lists what it found. This also holds for a PR opened under the maintainer's own account.

The bot's own commits on a PR someone else opened do not count. They are ours, from a take-over, a change or a format run, and `facts.ourCommits` counts them. Such a PR is judged like the contributor's PR it is.

The default: every AI-written PR needs the maintainer's own review of the code before it is merged. GitHub shows no sign of that review on the maintainer's own PRs. A profile or `personal.md` can change this default or add exceptions. So:

- Clean never makes it a quick merge. Green CI, resolved threads and an approval by a bot change nothing. The category is `land` on a PR we control and `unblock` on a contributor's PR.
- `effortMinutes` is the maintainer's time to read the diff, from `facts.changedLines` by the table in `item-doc.md`. A small diff may still show under Quick & Easy. Above 1500 changed lines say so in `state`, like `About 1850 changed lines by Claude that you have not reviewed yet.`
- `state` says that the code was written by an AI agent and how much of it the maintainer has not reviewed.
- "Merge" is never the recommended route. Recommend what moves the maintainer's review forward: `drive` when review threads are open, a `revise` ("Change") route when the agent can name one concrete change to the PR, otherwise no agent route. A `merge` route may be the alternative.
- On a PR we control, opened by the maintainer, the bot or a coding agent working for us, never offer `take_over`. These PRs are ours already.
- A contributor's PR that only counts as AI-written because of an AI co-author or an autofix commit is still the contributor's. It follows the normal rule: when the findings are small and we can fix them ourselves, recommend `take_over` with `mode: "push"` and keep the `review` as the alternative. A finding only the contributor can answer does not block the take-over. The take-over fixes the rest, and the open question goes into its `text` so the agent asks it on the PR after the push.
- The agent's own full review does not replace the maintainer's. Its findings help the maintainer read faster, so list the three places that most deserve a look as findings with their file and line.
- The exception: the maintainer wrote in the PR or in a note to the agent that the current head is reviewed. Then the normal rules apply. A note that names an older commit counts only up to that commit.

The fast tier never decides such a PR.

## Fixes in progress

The code keeps a fix state per issue and discussion: `fix: { state, pr, startedBy, since }`, with `state` `working`, `draft`, `open`, `merged` or `closed`. Read it with `gary fixes --json` (`{ <itemId>: fix }`), or from the `fix` field the routine passes along, before you write routes. For discussions the code finds fix PRs with one search over the 100 most recently updated PRs, so an older one is missed. When the thread itself links a fix PR, say so in `story` and write no fix route, even when `gary fixes` reports nothing. `fixFor` on a PR's item is set by `gary put` from Gary's record. A skill never writes it.

- **`working`, `draft` or `open`**: a fix is under way. Write no `follow_up` route for the agent, and no "start a fix" wording anywhere. The board keeps the item out of the plan while `fix.parked` is true, and the fix PR's own item carries the work. Write no route that only announces the fix, like `Reply: fix is in review in #431`: the PR's "Fixes #N" link already tells the reporter. So the item usually has no routes. Write routes only when the other side wrote something after the fix PR was opened that needs an answer of its own, like a new question or a log that changes the picture. `fix.parked` is false then, and the item shows in the plan with its fix chip. `state` says where the fix stands, like `Draft fix pr-431 is in review, CI passing.`
- **`merged`**: recommend a `close` with a closing message that names the release when it is known (`item-doc.md`, `close`).
- **`closed`** without a merge: a new fix may start. `story` says that the earlier attempt was closed, and why when the thread says so.

When a discussion with a fix PR became an issue, `gary link-escalated` moves the fix to the issue. `gary fixes --json` then lists the PR for the issue, also when the PR was opened for the discussion. The PR's `fixFor` names the issue. Triage that issue like any issue with a fix in progress. A `closingPrs` entry can take one more run to appear.

A fix PR whose review rounds run (`fix.review` on its source item in `gary fixes --json`) is no board item yet. The rounds end with a `full_review` request that brings it to the board, ready for review when the rounds went through, still a draft when they stopped. Its item then carries the `rounds` and says in `state` how they ended. As finished agent work it sits at the top of its group ("Work the maintainer asked the agent for comes back first" covers it too).

A fix PR asks nobody to verify it. When its body names something the fix could not verify, the PR's item carries that as a `question` finding for the maintainer. Whether to ask the reporter is the maintainer's decision: offer it as a `reply` route as `me` on the fix PR's item only when the doubt is real, like a parameter set no second source confirms. Never recommend that route. A device config taken from a sibling device or confirmed by a source the profile names needs no such route.

With the rounds off, Gary's own draft fix PR, with `fixFor`, is a board item once its CI finished: category `land`, `state` like `Draft fix for acme/widgets#398. CI passing.`, routes by the rules for bot PRs. The maintainer reviews it, `drive` fits when review threads are open, and a `chore` with `action: "ready"` is the alternative that marks it ready. Its effort comes from the changed lines. While its CI still runs, it has no routes.

## Open review feedback

`reviewDecision` alone does not tell you whether a PR is ready. A review with state `COMMENTED` never changes it, and that is how most review bots review. Look at `reviews` and `openThreads` in the snapshot entry:

- `openThreadCount` above 0: unresolved review threads exist. Name the count and who opened them in `state`, like `Approved, but a review bot left 2 open threads after the approval.`
- A review that arrived after the latest approval, from a person or a bot, with change requests or recommendations in its body.

A PR with open review feedback never gets a recommended `merge`. Its effort is 1 or 2 when one or two `valid` threads have clear fixes and the rest is obvious, and 5 or more when the maintainer has to check verdicts or content or read the code. Its category is `unblock` on a contributor's PR and `land` on a PR we control. It is a full-review candidate. The full review judges each open thread in `threads`: `valid`, `optional` or `wrong`, with a note. Once every thread has a verdict, the route follows "Who may push to a PR" in `item-doc.md`: `take_over` on a contributor PR that is not taken over, `drive` or `address_review` on the others. A `revise` carries no thread decisions, so it is never the route for open threads. Outdated threads that are not resolved count as open. The agent behind it can push only when the account setup allows pushes and the PR allows it: a fork PR needs `maintainerCanModify: true`, a branch inside the repo needs nothing extra. When it cannot push and a thread is `valid`, recommend a `review` route that asks the contributor instead.

Bot reviewers are often right about real bugs and often wrong about project conventions. Never dismiss a thread because a bot wrote it, and never treat it as settled because a bot wrote it.

## Sensitive paths

A PR changing a path in the profile's `sensitivePaths` gets the fact named in `state` and needs the maintainer's reading: its effort is at least 5, so it never sits in "Quick & Easy". Such paths can run code with repo secrets, change what agents like this one do, or pull in new code. A contributor PR touching them deserves a closer look even when the change looks harmless.

No agent works in a checkout of such a PR, whoever opened it. Write no `address_review`, `drive` or `format` route for it, and no `take_over` or `revise` in their normal form. The one exception is the API edit (`item-doc.md`, "API edit"): when every finding we would fix ourselves is a small text replacement outside the sensitive files, recommend a `take_over` or `revise` with `params.via: "api"` that carries the exact edits, and keep the `review` as the alternative. The server commits those edits through the GitHub API after the maintainer's click, without a checkout. In every other case offer only the `review`. The board's dialog shows a warning with the matching files above the routes, taken from the snapshot, and it says which of the two cases holds. So `state` names the paths, and the routes need no extra explanation.

A PR with `facts.sensitiveOurs: true` is ours alone. Its branch is in the repo. The bot or the maintainer opened it. The two authored and committed every commit. A PR by the bot is a fix PR Gary recorded. Nobody outside wrote anything on such a PR. The paragraph above does not apply to it. Write the normal routes of a PR we control: `revise`, `address_review`, `drive` and `format`. Never write the API edit there. The validator refuses it. The first paragraph still applies: `state` names the paths and the effort is at least 5. The fact comes from code. Never set it or assume it yourself. Never treat a PR as ours alone because its author is the bot. A sensitive PR without the fact carries `facts.sensitiveNotOurs` with the reason, like a commit by someone else. It keeps the limits above. On a PR that is ours alone, the dialog's warning says that agents may push and that the files deserve a careful read. The routes need no callout about it.

## No routes

Some items need nothing from the maintainer right now. They get no routes, and the board does not show them:

- Nothing can be done until someone else acts: the reporter owes a log, the contributor owes a change, a vendor owes an answer.
- Informational issues, like an announcement or a tracking issue.
- The maintainer's own notes and ideas that describe no concrete change. One that does gets the `Implement:` card, like bot or agent backlog.
- Answered discussions where no reply is owed.
- Items that need analysis first. They get `reviewDepth: "pending"`, and the routine reviews them without a click.

- An issue or discussion whose decision lives on an open PR, because `facts.hasClosingPr` is true, a PR's `fixFor` names it, or a PR is clearly its companion. `state` names the PR item, like `Decided with pr-412.` The decision appears once on the board, on the PR.

A contributor PR that got an automatic first review is no such item. It keeps its routes and findings, because the maintainer has not looked at it yet. The board keeps it out of the plan while it waits for the contributor (`item-doc.md`).

Such an item comes back when it changes on GitHub. The one exception is a close that becomes due: after `activeMaxWaitDays` of waiting on a reporter, the recommended route is `close` with reason `not_planned`.

## Full-review candidates

Items that need analysis before they can show up go first, because without routes they are invisible: every item at `reviewDepth: "pending"`, and every PR with an `unjudged` thread. The routine takes them before any other candidate.

A draft PR with `facts.draftWaiting` is never a candidate, also when it has open threads or is a contributor PR.

A changed item is also a candidate when a full review adds information the snapshot lacks:

- every contributor PR,
- every item classified `unblock` because someone asked us something,
- PRs by the bot or with `authorType: "copilot"` whose head changed,
- issues and discussions with new comments from outside our side.

These usually need no full review and stay at `quick`: dependency update PRs with passing CI, the maintainer's own PRs without open threads, and items where only labels changed. The maintainer's own PRs with open threads are candidates, because their threads need verdicts.

When a PR was fully reviewed at the same head SHA and only new comments arrived, reuse the old findings. Reclassify from the new comments, and review in full only when a comment asks something that needs the code.

## Priority

The board ranks the items within each group itself (SPEC.md, "Day plan"): finished work the maintainer asked for first, then items with a due date, the earliest first, then items by outside contributors and reporters before the maintainer's own and bot work, then the lowest `effortMinutes`. `priority` breaks the ties those keys leave, so set it by the same order, 1 for the top of each category.

Work the maintainer asked the agent for comes back first. An item whose agent job finished since the maintainer last handled it (a take-over, a change they asked for with `revise`, an address-review, a drive, a format, a fix they started) and that now only needs the maintainer's decision is `land`, with the lowest effort its decision allows, so it sits at the very top, newest result first. The maintainer asked for it and is waiting to finish it. Such an item always offers the decision, as "Routes after a push" in `push-to-pr.md` describes: a `merge`, a `review`, or another pass by the agent. A `reply` that only reports the push is no route. This holds whoever authored the PR. It does not hold while CI still runs on the pushed commit, or when the job left something open that needs thought: then the normal rules place it.

After those, in every category, items by outside contributors and reporters come first, because someone outside waits on them. Items by the maintainer themself and items by bots and agents follow as one group, mixed by the category's own order. Within each of the two groups:

- `act`: earliest `dueAt` first, then the rest by the order of their other rules.
- `unblock`: longest wait first.
- `land`: lowest `effortMinutes` first, then merges, closes, answers.
- `decide`: newest `updatedAt` first. Bot or agent backlog with an `Implement:` card sorts like every other item there.

## Autonomous labels and assignments

Write these into the item's `wants` with a `wantsReason` (`item-doc.md`). The routine applies them every run with `gary action --autonomous <file>` (`label` with `params.add` or `params.remove`, `assign` with `params.assignees`) until the snapshot shows them. `--autonomous` makes the code refuse labels outside `autoLabels`. Only labels in the profile's `autoLabels` qualify, and only under the conditions the profile's rules state. Each change records a fact that is already true on GitHub. A label that states a judgment becomes a `chore` route with `action: "label"`, and only when the label is the whole job.

A label that marks "we asked for info" becomes true only after the request is on GitHub, which takes a click. Never add it before. The reply route that makes the request carries the same label in `params.alsoLabel` (`item-doc.md`), so one click can post and label. `wants` stays the fallback for a reply the maintainer posted without that button: it holds the label only once the request is visible on the timeline. `wants` and `alsoLabel` never point in opposite directions: a label one adds, the other never removes. "Waiting on the reporter" also covers a message that asked them to try something and report back.

The `reason` of every autonomous action describes the last exchange on the timeline correctly: who asked what, who answered, what is open now. Example: `The maintainer asked for a debug log. The reporter sent it in a reply. The maintainer then asked them to upgrade and report back, which is open.`

## Bot commands

The profile's `botCommands` lists commands that the repo's own automation reacts to. Such automation usually ignores comments by the bot itself, and board posts come from the bot. Never put a bot command into a route's `text`. When a command would solve the item, write it into a finding, so the maintainer can paste it themself. The `move` route with `to: "issue"` is for a confirmed bug in a discussion, and for a feature request or idea in a discussion that the maintainer may want to track (`item-doc.md`, `move`). With `botCommands.escalate` the maintainer posts the command themself. With `escalateAs: "me"` in the instance config the board posts it under the maintainer's login after their click. An agent never posts it. Without `botCommands.escalate` the route is still offered. Its card opens the discussion, and the maintainer uses GitHub's own "Create issue from discussion" link in the sidebar.
