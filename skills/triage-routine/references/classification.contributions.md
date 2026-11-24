# Quick classification of a contributions instance

Read this file, then the `<personal>` files, shared first. Later wins. A contributions instance has no profile, so there is no `<profile>/rules/classification.md`. `item-doc.md`, `voice.md` and `accounts.md` still apply where this file does not say otherwise.

A contributions instance follows the maintainer's own threads in repos outside their maintainer instances: their own PRs, issues and discussions, the PRs that wait for the maintainer's review, and the threads they commented on, reviewed or were mentioned in. They are a contributor or a user there, not the maintainer. The other people in the thread are "them", whatever their role in that repo, also the repo's own maintainers. Only the instance's maintainer is "us".

Gary writes nothing to GitHub for this kind. Every route is a text the maintainer posts themself or a thread they open: `as: "me"` always.

## The entry

Every entry carries `repo` and an id like `acme.widgets.pr-12`. Copy both unchanged. The entry also carries the usual fields of the maintainer snapshot: author, labels, CI, review decision, the last 5 comments with their bodies, and `facts.timeline` with `lastSpeaker`, `waitingOn` and `waitingDays`. `waitingOn: "us"` means someone else spoke last and it may be the maintainer's turn. The contributions facts come on top:

- `facts.involvement`: why the thread is the maintainer's, a list of `author`, `assignee`, `review_requested`, `reviewer`, `commenter`, `mentioned`.
- `facts.lookedAt` and `facts.lookedVia`: when the maintainer last looked. That is their own last comment, review or opening post (`comment`), or their last "Got it" on the board (`got_it`), whichever is newer. `null` when the maintainer never wrote in the thread.
- `facts.news`: what others did after `lookedAt`, oldest first, at most 15, with `facts.newsCount` for all of them. Each is `{ at, by, kind, state?, excerpt?, mentionsMe?, asksMe? }`, with `kind` `comment`, `reply`, `thread_comment`, `review`, `commit`, `merged`, `closed`, `reopened` or `answer`. Code already dropped the mechanical noise: the maintainer's own events, bots, comments that only agree like "+1" or "same here", label and milestone changes, draft and ready flips, force-pushes and CI runs. `excerpt` is the comment without quoted lines, at most 300 characters. `mentionsMe` is a mention outside a quote. `asksMe` adds a last line that ends in a question mark.
- `facts.closed`: `{ at, by, how }` for a thread that closed or merged after the maintainer last looked, with `how` `merged`, `completed`, `not_planned` or `closed`.
- PRs: `facts.ci`, `facts.ciGreen`, `facts.approvedBy`, `facts.changesRequestedBy`, `facts.openThreadCount`, `facts.openThreadsByOthers`, `facts.reviewRequested`, `facts.canMerge` and `facts.myReview: { state, at, pushedSince }` for the maintainer's own last review on someone else's PR.
- `facts.quietDays`: days since anyone wrote in the thread.

Entries the snapshot lists under `quiet` carry nothing new and give the maintainer nothing to do. They never reach a model, see the routine skill.

## Categories

Check the rules top to bottom. The first match wins. The board puts every category, FYI too, into its three groups by the usual rules, mostly by the effort.

### `act`: something only the maintainer can do next, on their own PR or issue

- The maintainer's PR has a change request, open review threads by others, or a question to the maintainer in `facts.news`. `state` names who asked what, like `Bob asked you to split the commit.` Route: a `reply` with a draft the maintainer adapts, or `open` when the answer is code they have to write.
- The maintainer's PR's CI fails (`facts.ci: "failing"`). `state` names the failing part when the entry says it. Route: `open`.
- Someone asked the maintainer a question in a thread of the maintainer's own (`asksMe` on a news entry by someone who is not a bot). Route: `reply`.

### `unblock`: someone waits on the maintainer's review or the maintainer's answer

- A PR waits for the maintainer's review (`involvement` holds `review_requested`), and the maintainer has not reviewed since its last push (`facts.myReview` is missing or has `pushedSince: true`). `state` says who asked and since when. Route: `open`, or a `review` as `me` with the body as a draft when the snapshot shows enough to say something. A review the maintainer posts themself carries no inline comments.
- A thread of someone else asks the maintainer directly (`mentionsMe` or `asksMe` in `facts.news`). Route: `reply`.
- Use `activeMaxWaitDays` from the config like the maintainer rules do: a question older than that is no live conversation anymore, so classify by the next rule and name the open question in `state`.

### `land`: the maintainer's PR is approved and only needs a last step from them

- The maintainer's PR is approved, CI passes, nothing is open, and `facts.canMerge` is true. The merge is their own step. `state` says so. Route: `open`.
- The maintainer's PR is approved and `facts.canMerge` is false: they have no write access to the repo. Never offer a merge then, in no route and under no title, and never write that only the merge is left for them. `state` says who has to merge, like `Three approvals, nothing open. A maintainer of the repo has to merge.` While the approval is news, the item is `fyi`. After a few quiet days the last step is a short reply that asks a maintainer to merge. Route: `reply`.

### `decide`: the maintainer decides whether to keep going, close or hand over

- The maintainer's own PR or issue has been quiet for a long time (`facts.quietDays` above 30) with no answer from the repo's maintainers. `state` names the choice, like `No reaction in 45 days. Ping, close or hand over.` Routes: a `reply` that pings, a `close` with a short reason.
- A maintainer of the repo asked for a change in direction that the instance's maintainer has to weigh. Routes: a `reply` per choice, recommended the one the thread points to.

### `fyi`: news for the maintainer, and nothing to do

An item is `fyi` when `facts.news` holds something relevant for the maintainer and none of the rules above match. Relevant means it changes what the maintainer knows or would do. Judge each case for the maintainer, also a discussion between other people on a thread the maintainer takes part in.

Relevant, for example:

- A maintainer decided something on an issue or PR of the instance's maintainer, like accepting the idea, declining it or picking an approach.
- A fix or a release for an issue the maintainer reported or follows landed: a closing PR merged, a comment names the version.
- The maintainer's PR was merged or closed by someone else (`facts.closed`).
- The thread reached a conclusion or a workaround, like a root cause, a working workaround or the answer to a discussion.
- Others found something that changes the picture: a new reproduction, a plan, a change of direction.

Not relevant, so no item:

- Repeated confirmations of the same problem, more "me too" in other words.
- Side talk between others that adds nothing for the maintainer, like a question about their own setup.
- Status chatter: "any update?", a bump, a thank-you.
- A mention of the maintainer inside a quote. `mentionsMe` already ignores quotes.

Code drops reactions, bot comments, label and milestone churn and CI reruns before you see the entry. The relevance of what is left is your call. When `facts.news` holds nothing relevant and nothing is the maintainer's to do, write no item, see "No item".

An FYI item has:

- `category: "fyi"`.
- `state`: what is new, in one or two sentences, like `Dave merged the fix in 2.0.1. Your workaround is no longer needed.`
- `newsAt`: the `at` of the newest relevant news entry that `state` reports. The board hides the item once the maintainer says "Got it" after that time, and shows it again when a later run writes a newer `newsAt`.
- `effortMinutes`: the time to read it. Usually 1 or 2. A long thread the maintainer should read in full gets 5, 10 or 15. The board puts a short one into "Quick & Easy" and a long one into "When you have time".
- No routes, unless a reply makes sense, like thanking a maintainer who fixed an issue of the instance's maintainer. Then one `reply` as `me` with a short draft, recommended, and `hint` its title.
- `reviewDepth: "quick"`.

### No item

Nothing relevant since `lookedAt` and nothing to do: write the item without routes, with `category: "decide"`, `state` like `Nothing new for you since Nov 20.`, `effortMinutes: 1` and no `newsAt`. The board does not show it. When no item for the entry is stored yet, write nothing at all. A stored item must stay, because it keeps the maintainer's "Got it".

## Routes

Allowed route types are `reply`, `review`, `close` and `open`, each with `as: "me"`. The validator refuses every other type, every other actor, `alsoLabel`, `alsoAnswer` and inline review comments. There is no `merge` route: the board offers no merge, and `open` takes the maintainer to the PR. There are no agent routes, no labels, no fixes and no escalation.

Replies follow `voice.md`. The maintainer writes as a contributor or a user here, not as the maintainer of the repo: no "we", no promises about the repo's plans, no closing a thread they do not own. A draft names the concrete thing, like the version that fixed it or the question they answer. When the maintainer has nothing to add, write no reply route.

## Effort and priority

`effortMinutes` follows `item-doc.md`: the time the maintainer needs to read up and act. An FYI item is usually 1 or 2. Priority follows the maintainer rules: within a category, someone who waits on the maintainer first, then the lowest effort.

## Tiers

`fastTier` is always `off` for this kind. Only the standard tier classifies, with the model `gary models` names for `standard`. There are no full reviews, no auto-fixes and no automatic reviews: every item is `reviewDepth: "quick"` and `classifiedBy: "standard"`.
