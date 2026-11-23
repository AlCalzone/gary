# Quick classification of a contributions instance

Read this file, then the `<personal>` files, shared first. Later wins. A contributions instance has no profile, so there is no `<profile>/rules/classification.md`. `item-doc.md`, `voice.md` and `accounts.md` still apply where this file does not say otherwise.

A contributions instance follows the maintainer's own threads in repos outside his maintainer instances: his own PRs, issues and discussions, the PRs that wait for his review, and the threads he commented on, reviewed or was mentioned in. He is a contributor or a user there, not the maintainer. The other people in the thread are "them", whatever their role in that repo, also the repo's own maintainers. Only he is "us".

Gary writes nothing to GitHub for this kind. Every route is a text he posts himself or a thread he opens: `as: "me"` always.

## The entry

Every entry carries `repo` and an id like `acme.widgets.pr-12`. Copy both unchanged. The entry also carries the usual fields of the maintainer snapshot: author, labels, CI, review decision, the last 5 comments with their bodies, and `facts.timeline` with `lastSpeaker`, `waitingOn` and `waitingDays`. `waitingOn: "us"` means someone else spoke last and it may be his turn. The contributions facts come on top:

- `facts.involvement`: why the thread is his, a list of `author`, `assignee`, `review_requested`, `reviewer`, `commenter`, `mentioned`.
- `facts.lookedAt` and `facts.lookedVia`: when he last looked. That is his own last comment, review or opening post (`comment`), or his last "Got it" on the board (`got_it`), whichever is newer. `null` when he never wrote in the thread.
- `facts.news`: what others did after `lookedAt`, oldest first, at most 15, with `facts.newsCount` for all of them. Each is `{ at, by, kind, state?, excerpt?, mentionsMe?, asksMe? }`, with `kind` `comment`, `reply`, `thread_comment`, `review`, `commit`, `merged`, `closed`, `reopened` or `answer`. Code already dropped the mechanical noise: his own events, bots, comments that only agree like "+1" or "same here", label and milestone changes, draft and ready flips, force-pushes and CI runs. `excerpt` is the comment without quoted lines, at most 300 characters. `mentionsMe` is a mention outside a quote. `asksMe` adds a last line that ends in a question mark.
- `facts.closed`: `{ at, by, how }` for a thread that closed or merged after he last looked, with `how` `merged`, `completed`, `not_planned` or `closed`.
- PRs: `facts.ci`, `facts.ciGreen`, `facts.approvedBy`, `facts.changesRequestedBy`, `facts.openThreadCount`, `facts.openThreadsByOthers`, `facts.reviewRequested` and `facts.myReview: { state, at, pushedSince }` for his own last review on someone else's PR.
- `facts.quietDays`: days since anyone wrote in the thread.

Entries the snapshot lists under `quiet` carry nothing new and give him nothing to do. They never reach a model, see the routine skill.

## Categories

Check the rules top to bottom. The first match wins. The board puts every category, FYI too, into its three groups by the usual rules, mostly by the effort.

### `act`: something only he can do next, on his own PR or issue

- His PR has a change request, open review threads by others, or a question to him in `facts.news`. `state` names who asked what, like `Bob asked you to split the commit.` Route: a `reply` with a draft he adapts, or `open` when the answer is code he has to write.
- His PR's CI fails (`facts.ci: "failing"`). `state` names the failing part when the entry says it. Route: `open`.
- Someone asked him a question in a thread of his own (`asksMe` on a news entry by someone who is not a bot). Route: `reply`.

### `unblock`: someone waits on his review or his answer

- A PR waits for his review (`involvement` holds `review_requested`), and he has not reviewed since its last push (`facts.myReview` is missing or has `pushedSince: true`). `state` says who asked and since when. Route: `open`, or a `review` as `me` with the body as a draft when the snapshot shows enough to say something. A review he posts himself carries no inline comments.
- A thread of someone else asks him directly (`mentionsMe` or `asksMe` in `facts.news`). Route: `reply`.
- Use `activeMaxWaitDays` from the config like the maintainer rules do: a question older than that is no live conversation anymore, so classify by the next rule and name the open question in `state`.

### `land`: his PR is approved and only needs a last step from him

- His PR is approved, CI passes, nothing is open, and the merge is his own step. `state` says so. Route: `open`.
- His PR is approved and he cannot merge. The last step is a short reply that asks a maintainer to merge, only when the thread has been quiet for a few days. Route: `reply`.

### `decide`: he decides whether to keep going, close or hand over

- His own PR or issue has been quiet for a long time (`facts.quietDays` above 30) with no answer from the repo's maintainers. `state` names the choice, like `No reaction in 45 days. Ping, close or hand over.` Routes: a `reply` that pings, a `close` with a short reason.
- A maintainer of the repo asked for a change in direction that he has to weigh. Routes: a `reply` per choice, recommended the one the thread points to.

### `fyi`: news for him, and nothing to do

An item is `fyi` when `facts.news` holds something relevant for him and none of the rules above match. Relevant means it changes what he knows or would do. Judge each case for him, also a discussion between other people on a thread he takes part in.

Relevant, for example:

- A maintainer decided something on his issue or PR, like accepting the idea, declining it or picking an approach.
- A fix or a release for an issue he reported or follows landed: a closing PR merged, a comment names the version.
- His PR was merged or closed by someone else (`facts.closed`).
- The thread reached a conclusion or a workaround, like a root cause, a working workaround or the answer to a discussion.
- Others found something that changes the picture: a new reproduction, a plan, a change of direction.

Not relevant, so no item:

- Repeated confirmations of the same problem, more "me too" in other words.
- Side talk between others that adds nothing for him, like a question about their own setup.
- Status chatter: "any update?", a bump, a thank-you.
- A mention of him inside a quote. `mentionsMe` already ignores quotes.

Code drops reactions, bot comments, label and milestone churn and CI reruns before you see the entry. The relevance of what is left is your call. When `facts.news` holds nothing relevant and nothing is his to do, write no item, see "No item".

An FYI item has:

- `category: "fyi"`.
- `state`: what is new, in one or two sentences, like `Dave merged the fix in 2.0.1. Your workaround is no longer needed.`
- `newsAt`: the `at` of the newest relevant news entry that `state` reports. The board hides the item once he says "Got it" after that time, and shows it again when a later run writes a newer `newsAt`.
- `effortMinutes`: the time to read it. Usually 1 or 2. A long thread he should read in full gets 5, 10 or 15. The board puts a short one into "Quick & Easy" and a long one into "When you have time".
- No routes, unless a reply makes sense, like thanking a maintainer who fixed his issue. Then one `reply` as `me` with a short draft, recommended, and `hint` its title.
- `reviewDepth: "quick"`.

### No item

Nothing relevant since `lookedAt` and nothing to do: write the item without routes, with `category: "decide"`, `state` like `Nothing new for you since Nov 20.`, `effortMinutes: 1` and no `newsAt`. The board does not show it. When no item for the entry is stored yet, write nothing at all. A stored item must stay, because it keeps his "Got it".

## Routes

Allowed route types are `reply`, `review`, `close` and `open`, each with `as: "me"`. The validator refuses every other type, every other actor, `alsoLabel`, `alsoAnswer` and inline review comments. There is no `merge` route: the board offers no merge, and `open` takes him to the PR. There are no agent routes, no labels, no fixes and no escalation.

Replies follow `voice.md`. He writes as a contributor or a user here, not as the maintainer of the repo: no "we", no promises about the repo's plans, no closing a thread he does not own. A draft names the concrete thing, like the version that fixed it or the question he answers. When he has nothing to add, write no reply route.

## Effort and priority

`effortMinutes` follows `item-doc.md`: the time he needs to read up and act. An FYI item is usually 1 or 2. Priority follows the maintainer rules: within a category, someone who waits on him first, then the lowest effort.

## Tiers

`fastTier` is always `off` for this kind. Only the standard tier classifies, with the model `gary models` names for `standard`. There are no full reviews, no auto-fixes and no automatic reviews: every item is `reviewDepth: "quick"` and `classifiedBy: "standard"`.
