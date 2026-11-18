# Writing an item doc

The `items/<id>.json` shape is in `<core>/SPEC.md`. This file covers the fields an agent writes: `section`, `state`, `story`, `hint`, `effortMinutes`, `waitingDays`, `solved`, `threads`, `findings`, `routes` and `links`, plus `takenOver` and `rounds` after a take-over or a drive. The routine sets `classifiedBy` (`fast`, `standard` or `full`) on every doc it writes, and `analyzedBy: "fallback"` when the doc comes from the Sonnet retry after a safety-filter stop. A subagent never sets it. `dismissedRoutes` and `handled` belong to the maintainer: read them, never write them (see "Dismissed routes" under `routes`). The routine clears `handled` under the rules of its step 4c. Every item doc with routes carries `hint` and `effortMinutes`, also after a quick classification. `priority` is set by the routine after all docs of a run are in. A subagent that handles one item keeps the existing `priority`, or leaves it out for a new item. The routine copies `mergeable`, `reviewDecision` and `isAnswered` from the snapshot, mapped to the lowercase values in SPEC.md.

Canned texts for routes live in `<profile>/templates/`. The maintainer edits their wording there, and you copy them into a route's `text`. Text follows `voice.md` and its profile and personal layers, including any writing rules `personal.md` names.

The maintainer scans dozens of items per session. A briefing earns its place when `state` tells him the situation and the recommended route is what he would do about it.

## `state`

The verdict. One sentence, at most 25 words, that describes the situation. It does not name the action, because the recommended route's card does. Less text is better: he reads `state` to pick what to tackle next, and opens the item for everything else.

- Good: `Reporter fixed it by clearing the cache.`
- Good: `Clean except one leftover comment line. The contributor's question about the retry flag has a clear answer.`  (two short sentences are fine when both are needed)
- Good: `Open question whether the client should expose its request timeout publicly.`
- Good: `Reporter needs a go-ahead to send a PR for the missing option.`
- Bad: `Reporter fixed it by clearing the cache. Close.` The card already says close.
- Bad: `This is a PR by someone that adds a config file.` It describes the item.
- Bad: a sentence that lists what was checked, what passes, and what the review found. Details belong in `findings`.

Leave out what the chips already show: CI state, draft, author, labels, the item's age, and how long it waits (the `waitingDays` chip). Leave out how you analyzed it. Name numbers and identifiers only when the decision depends on them. Keep a hedge when you are unsure ("probably"). Shortening never upgrades certainty.

## `story`

The briefing in the detail dialog. Assume the maintainer has not read the thread. Tell the short story of the item in 3 to 5 sentences, at most 90 words, in the order things happened:

1. Who wants or reports what, with the concrete symptom or change. Name the component, the versions, the file, whatever anchors it.
2. What happened since: what was tried, what the logs showed, what was asked and answered, what a review found.
3. Where it stands now and who it waits on. Describe the last exchange correctly: who asked what, who answered, what is open now. Who spoke last comes from `facts.lastSpeaker` and `facts.timeline` (classification file, "Facts first"). Read the text only for what was said.

Do not recite every comment. Leave out greetings, pleasantries and anything that changed nothing. Keep numbers and identifiers. Write past events in past tense. The story explains, `state` gives the verdict, and they do not repeat each other. Every item doc has a story, quick ones too. For a quick classification, build it from the body and the last comments in the snapshot, and say less when you know less.

- Good: `The reporter's uploads failed after the 4.2 update with a timeout after 30 s. The debug log showed the client retrying the first chunk forever, because the server answered 413. The reporter raised the server's size limit and uploads work again.`
- Bad: `The user opened an issue. The maintainer asked for logs. The user posted logs. The maintainer replied.` It recites the thread and says nothing about the problem.

## `reviews` and `threads`

The board shows review activity as badges and a collapsed thread list. Text never repeats it.

- `lastEventUrl` is copied unchanged from the snapshot entry's `facts.lastEventUrl`, the URL of the newest comment in the thread. Leave it out when the entry has none. The board opens the thread there.
- `reviews` is copied, never written by hand: the snapshot's `reviewSummary` entries, plus one entry with `state: "pending"` for each of `requestedReviewers`. The routine copies it like the other GitHub-derived fields.
- `threads` has one entry per unresolved review thread in the snapshot's `openThreads`, outdated ones included: `id` (the GraphQL thread id, `PRRT_…`), `author`, `isBot`, `path`, `line` and `url` copied, and three fields you write. The `address_review` card sends decisions by `id`, so a thread without it cannot be handled. `summary`: one line of at most 20 words that says what the comment asks for, in your words. `verdict`: `valid` when it is right and should be fixed before merging, `optional` when it is right but can be skipped, `wrong` when it does not apply, `unjudged` when you did not check it. `note`: one sentence with the reason, required for `valid` and `wrong`. A quick classification writes `summary` and leaves `verdict` at `unjudged`. A full review judges every thread against the code at the head. When the snapshot's open threads differ from the stored `threads`, judge the new ones, keep the verdicts of the unchanged ones, and drop the resolved ones.
- Do not repeat threads as `findings`. Findings are what you found yourself.
- `story`, `state` and the hint do not narrate who reviewed when. The badges show approvals, change requests and pending reviews. Mention review activity in `state` only when it decides the situation, like `Two of the review bot's three comments are valid.`

## `hint`

The action you suggest, for the overview list. It is also the `title` of the recommended route, character for character. At most 60 characters, shorter is better. Write it like a note on a sticky: an imperative verb, then a colon and the gist when the verb alone is not enough. No "maybe", no full sentences, no period at the end.

- Good: `Reply: PR welcome`
- Good: `Merge`
- Good: `Request changes: 3 nits`
- Good: `Decide: expose the request timeout?`
- Good: `Ask for a debug log`
- Good: `Take over: add the missing metadata`
- Bad: `Maybe reply and say that we accept PRs` (wordy)
- Bad: `URGENT: reply now` (pressure)

Start with one of these verbs: Reply, Decide, Ask, Close, Reopen, Merge, Approve, Request changes, Comment, Address review, Drive, Format, Implement, Start fix, Post analysis, File issue, Take over, Transfer, Convert, Escalate, Label, Assign, React, Rerun CI, Update branch, Mark ready, Mark answer. Use `Decide` for a `reply` that carries the maintainer's decision on an open question. The hint does not repeat the title of the thread. An item without routes has no hint.

## `wants` and `wantsReason`

What the agent wants changed on GitHub without a click, as labels and assignees:

```json
"wants": { "labels": { "add": ["waiting for info ⏳"], "remove": [] }, "assignees": [] },
"wantsReason": "The maintainer asked the reporter to upgrade and report back, which is still open."
```

Write it at classification time, only for changes the classification file and the profile allow without a click, and only with labels from the profile's `autoLabels`. `wantsReason` is one sentence that states the last exchange correctly. Both are agent-owned and replaced with the doc. Leave both out when nothing is wanted. The routine compares `wants` with the item's current labels and assignees every run and applies what is missing.

## `autofix`

PRs only. The result of the format check (`triage-review-pr`, `references/format-check.md`): `{ "changes": true, "files": 2, "lines": 14, "tools": ["oxfmt"] }`. The board shows it as a small badge. Formatting is never a finding.

## `solved`

`solved: true` means the reporter's problem is gone: the fix is merged, the reporter confirmed it works, or a correct answer to their question is in the thread. Nothing else.

A suggestion to close is not a solution. A feature request you would decline, a report you consider invalid, a duplicate and a stale thread all stay `solved: false`, even when the recommended route is `close`. When in doubt, leave it false.

## `effortMinutes`

Your estimate of how long the maintainer needs to read up and decide, in minutes. Use one of 1, 2, 5, 10, 15, 30, 60, 120. It covers his reading and thinking, and excludes any implementation work.

- 1: click merge on an approved PR with passing CI, close a clear duplicate.
- 2: send a suggested reply that needs no checking.
- 5: skim a small diff, confirm a short review, answer a yes or no question.
- 10 to 15: read a code change of up to about 200 lines, or decide an API question with one tradeoff.
- 30: a larger code change, a log-based diagnosis he will want to verify.
- 60: a new subsystem, a design discussion, a change of about 800 to 1500 lines.
- 120: a change above about 1500 lines that he has to read himself.

Code he has to read himself, like an AI-written PR under the profile's rules, is estimated from `facts.changedLines`, without generated files, lock files and snapshots: up to 20 lines 2, up to 100 lines 5, up to 300 lines 15, up to 800 lines 30, up to 1500 lines 60, above that 120.

A full review lowers the estimate when it leaves him only a confirmation. Open specification questions raise it. The estimate decides the section between `easy` and `almost` (the classification file): 1 or 2 minutes fit `easy`, 5 or more mean he has to think, which is `almost` or `review`.

## `waitingDays`

Set it when someone outside our side waits for an answer or a review: whole days since their unanswered comment, or since a contributor PR last got commits without a maintainer response. Leave it out otherwise.

## `findings`

Full reviews only. One entry per distinct problem:

```json
{ "severity": "major", "text": "The retry loop ignores the abort signal, so a cancelled upload keeps sending.", "ref": "src/upload/retry.ts:84" }
```

Severities:

- `blocker`: merging it breaks something, or the issue cannot move without it.
- `major`: wrong behavior in a real case, a missing test for a bug fix, a specification violation.
- `minor`: style, naming, docs, a nit the maintainer would still mention.
- `idea`: a useful follow-up on a solved thread. See "Solved and closed threads" in the classification file for the bar it has to pass.
- `question`: an open question you could not settle from the repo, especially about a specification the project implements. Phrase it as a question. Never guess the answer.

`ref` is `path:line` relative to the repo root, at the reviewed head. Leave it out when no file applies. A problem that appears in several places is one finding, with one inline comment per place in the `review` route. Order findings by severity. Leave out praise and summaries of what the PR does.

`routeId` names the one route whose card shows the finding as its reason, like the `follow_up` or `take_over` route that acts on it. A finding can support more than one route. It still has at most one `routeId`, and the other routes mention it in their `why`. A `review` route carries its findings itself, in `params.comments` and the summary `text`, so those findings need no `routeId`. Every `routeId` must name a route in the same doc.

A `follow_up` route sets `params.finding` to the 0-based index of its finding in `findings`. The routine passes that finding to the fix agent. Keep the order of `findings` stable after you set the index.

A finding that carries a `follow_up` route is two sentences: what to change, and what it buys. Example: `Log the request ID when an upload is rejected. Reports like this one would then name the failing request right away.` The route's title stays short and does not restate it, like `File issue: log rejected request ID`.

## `routes`

A route is one way to resolve the item. The board builds the dialog from your route cards. The shape, the route types and who may act on each are in SPEC.md under "Who acts", "Routes" and "Accounts". Read them before you write routes. `accounts.md` says how the account setup changes `as` and which routes it rules out.

### Dismissed routes

Read the item's `dismissedRoutes` before you write routes. Each entry `{ type, title, reason, at }` is a card the maintainer dismissed. Never write a route of a dismissed type on that item again. `gary put` refuses such a doc. Treat the dismissal and its reason as his steering for the whole item. A dismissed `close` means he wants the item kept open and moved forward, so the new recommended route must move it forward: a reply that takes the next step, a delegate route, a `move` to an issue. A queued `reanalyze` after a dismissal carries his reason in `text`. Read it together with the entry.

### Delegate to an agent

Backlog by the bot or an agent: an issue or discussion authored by the bot or an agent that describes doable work gets exactly one route, a `follow_up` with `as: "agent"`, titled `Implement: <gist>`, with the one-sentence `why`. Its section is `deferred`, and it sorts after everything else there. The maintainer's own note gets the same card when it describes a concrete change, and no routes otherwise.

An item that describes work somebody could do, like a feature, a bug, a docs gap or missing data, gets a `follow_up` route with `as: "agent"` as an alternative. Add it whenever an agent could plausibly attempt the work and the account setup allows pushing, even when the recommended route is a reply or a close. The title starts with `Implement:` for new work or `Start fix:` for a bug, like `Implement: brute-force search for a missing PIN`. Its `why` says in one sentence what the agent would build and what is uncertain. Leave it out only when the work needs real hardware, needs a design decision the maintainer has not made, or is clearly too large for one draft PR. Then say so in the `why` of the recommended route.

The agent cannot know what was agreed outside the thread. A `close` with reason `not_planned` on a feature request is therefore never the only route. Pair it with the delegate route, a `reply` that asks, or, for a discussion that describes a concrete feature, a `move` to an issue.

### Choosing routes

Pick 0 to 4 routes. With routes, exactly one has `recommended: true`, and it comes first. It is the route you would take if you were the maintainer, and its `title` equals `hint`. Most items have one route. Add another only when it is a real alternative the maintainer might prefer. Never add filler: a second wording of the same reply, a label next to a reply, a `full_review` "just in case".

```json
{ "id": "r1", "type": "reply", "title": "Reply: PR welcome", "as": "me", "params": {}, "text": "That makes sense. I'll accept a PR that adds the option to the config schema.", "recommended": true }
```

General rules:

- `id` is `r1` to `r4`, unique within the item. `title` follows the `hint` rules.
- `why` is optional: one sentence on when to pick this route over the recommended one. Leave it out on the recommended route unless the choice is not obvious.
- `as` must be allowed for the type in the SPEC.md table and the account setup. When a type allows more than one actor, the default is the one listed first.
- `callout` is a warning the maintainer must see before clicking. Use it only when something can go wrong, like a replacement PR or a transfer.
- Never write a route for hide, dismiss, snooze or "Analyze again". The dialog footer always offers those.
- A route whose text comes from a template: read the template file, copy everything below its leading comment into `text`, and change only the parts in square brackets, as the comment says.
- A route without text, like `drive`, `merge` without a title or `close` without a note, leaves `text` out.
- Every route that posts or prefills text carries finished `text`. The maintainer can click without editing. No placeholders like `<version>`, no "[insert link]", no notes to him inside the text. The text has no forced line breaks inside paragraphs and contains no bot commands (see the classification file).
- Text for `as: "me"` is in the maintainer's own first-person voice, because he posts it under his name. When he uses such a prefill, the board logs locally which route he chose and how he changed the text, for `triage-learn`. Nothing of it reaches GitHub through the server. Text for `as: "bot"` states facts and requests without "I".
- A route that depends on a profile fact exists only when that fact exists: `move` to a repo only for repos in `relatedRepos`, `move` to `issue` only with `botCommands.escalate`, `drive` only when `reviewBots` is not empty.

Per type:

- **`reply`**: an answer to a person. `as: "me"` by default. Use `as: "bot"` only for a neutral, factual note that does not need his name, like pointing to the release that contains a fix, or posting a local log analysis for the reporter (`Post analysis: <gist>`, when the profile's issue rules describe it). Without a bot, such a route becomes a prefill reply as `me` (`accounts.md`). A text built from logs or attachments quotes only what the reader needs and never contains secrets from them, like keys or tokens.
- **`alsoLabel`** on `reply` and `request_logs`: `params.alsoLabel: { add: [], remove: [] }`, labels from the profile's `autoLabels` only. A route whose text asks the other side for something (a log, diagnostics, a test, an answer) adds the profile's label for "waiting on the reporter", when the profile names one in its label table and the item does not have it yet. A route whose text ends the wait, because the reporter delivered and we answer, removes that label when the item has it. A reply that answers, declines or closes carries none. On a prefill reply the board offers it as a second button for the bot, on a bot route it goes out with the post. The core names no label. The profile's label table says which one means waiting.
- **`request_logs`**: a request for a log, posted by the bot. `text` comes from `<profile>/templates/request-logs.md`. Replace only the bracketed line with what to reproduce while the log runs. Write this route only when the profile has that template.
- **`close`**: always `as: "me"`. `params.reason` is `completed`, `not_planned` or `duplicate`. For a PR, leave `reason` out. Every `close` carries a brief closing message in `text`, one or two sentences in his voice that follow the personal rules: why the thread is closed and, where it helps, what to do if the problem returns. No thanks paragraph, nothing speculative. One short thanks at the start is fine when the person did something for us, like `Thanks for confirming! Closing this.` Examples:
  - `Good to hear that the restored backup fixed it. Closing this.`
  - `This is tracked in #123 now, so I'm closing this one.`
  - `Closing as not planned. The option would only help this one setup.`
  On a discussion with `facts.answerable` and no `facts.answerChosen`, the close also carries `params.alsoAnswer: { commentId, url, gist }`: the node id and URL of the comment that best answers the question, and a gist of at most 12 words. The reporter's own "this fixed it" comment qualifies only when it states the solution. When no comment answers it, the closing message states the answer in one or two sentences and `alsoAnswer` is left out. A `chore` route with `answer_discussion` stays for discussions that are not being closed. With `duplicate`, set `params.duplicateOf` to the original's number, and `text` names the original with its link. A close as not planned always gives the reason in one sentence. A PR we close gets a short message too, unless a bot or dependency tool opened it. Leave `text` out only when the thread's last comment already is that closing statement from our side, or when a merged PR replaced the PR and its link is already in the thread. The board then shows "Copy reply, open GitHub to close".
- **`reopen`**: `as: "bot"` by default, with a `text` that says why. Use `as: "me"` when the reason should carry his name.
- **`merge`**: `as: "me"`. When the profile wants a format for squash commit titles and the PR title does not follow it, put the title you propose into `text`. Never offer merge while a `valid` thread is open or a `blocker` or `major` finding remains.
- **`review`**: posted by the bot as one PR review. `params.event` is `approve`, `request_changes` or `comment`. Each finding with a file and a line becomes one entry in `params.comments`: `{ "id": "c1", "path": "src/…", "startLine": 83, "line": 84, "text": "…", "original": "…", "suggestion": "…", "diffHunk": "@@ -80,6 +80,7 @@ …" }`, ids `c1`, `c2` and so on. A comment with a replacement carries `original` (the exact text of lines `startLine` to `line`, or `line` alone, at `reviewedSha`) and `suggestion` (the replacement, without a fence). `text` is then one sentence of prose on why. A comment without a replacement has only `text`. The range rules are under "Suggestions" in `voice.md`. For a range, add `startLine` with the first line. `line` and `startLine` must be on the right side of the same diff hunk at `reviewedSha`, because GitHub rejects inline comments elsewhere. `diffHunk` is context: at most 12 lines of the PR diff at `reviewedSha` around the commented lines, copied from `gh pr diff` with their `+`, `-` and space prefixes, and starting with its `@@` header so the line numbers are known. The card shows it, so the maintainer can judge the comment without opening the file. Findings without such a line go into the summary `text`. Use `event: "request_changes"` when at least one finding is `major` or a `blocker`. `event: "comment"` when all findings are `minor` or cosmetic, with an approval offered as the alternative route. The summary must not count or list the inline comments, because the maintainer can uncheck any of them. Follow the suggestion rules in `voice.md`. A PR authored by the bot gets only `event: "comment"`, because GitHub forbids reviewing your own PR. Never offer `event: "approve"` while a `valid` thread is open.
- **`address_review`**: the agent handles the open review threads after the maintainer decides per thread. Offer it only on PRs where pushing is no take-over (see "Who may push to a PR" below), when every entry in `threads` has an `id` and a verdict other than `unjudged`, and the agent can push to the PR branch (see the classification file, "Open review feedback"). Leave `text` out: the maintainer adds his own note on the card. The card starts with `valid` threads switched to fix and all others to dismiss, so the title counts the `valid` threads: `Address review: 3 of 4 threads`.
- **`follow_up`**: another way forward that a finding suggests. Give that finding `routeId` of this route. Pick the actor per finding:
  - `agent`: a small change a test can cover. The agent starts a fix with a repro test and a draft PR. `text` holds the instructions: which module, which input, which expected result. The profile's `rules/issues.md` says what the test setup can reproduce.
  - `bot`: a larger change worth tracking. The bot files an issue with `params.title` and `text` as the body and links it in the thread.
  - `me`: the issue is a decision or a statement that should carry his name. The click opens GitHub's new-issue form with `params.title` and `text` filled in.
  It sets `params.finding` and the finding's `routeId` as described under `findings`. The usefulness bar from "Solved and closed threads" in the classification file applies to every follow-up. A weak idea gets no route and no finding.
- **`take_over`**: for a contributor PR that is not taken over yet, when we would push the fix ourselves: open review threads we would fix, or other findings that are small and need no knowledge only the contributor has. Also for a PR by the bot or a dependency bot whose CI fails because of its own change when the fix is small. When the item has judged threads, the card shows them with the same fix and dismiss switches as `address_review` and sends `input.decisions`, so the title counts the `valid` threads: `Take over: fix 1 review comment`. A round trip with a contributor costs days for a change that takes a minute. Example: a contributor's PR lacks a few fields that a sibling file on master already has, and the contributor stopped answering. `params.mode` is `push` by default: we continue in the contributor's PR with our commits, pushed under the writing identity. The returned item then has `takenOver: true`. Use `replace` only when pushing is impossible, and say why in `callout`, like `The contributor did not allow edits by maintainers, so the agent opens a replacement PR.` Do not offer it when a remaining point needs the contributor's knowledge or hardware, or when the PR touches a sensitive path. `text` holds instructions for the agent when the findings alone do not say what to do. The instructions cover the code and, where needed, the PR title to set, like `Set the PR title to feat(config): add Acme W100.` They never mention merging, approving or closing: a take-over does none of these, and the wording must not suggest it. The merge stays a separate `merge` route `as: "me"`.
- **`move`**: three targets.
  - A repo from `relatedRepos`, on an issue, with `as: "bot"`. The card has two bot buttons: transfer the issue, or close it with `text` that asks to reopen there. Write `text` from `<profile>/templates/reopen-elsewhere.md` for the second button, with the target repo and what the new issue needs. Say in `why` which button fits: transfer when the issue already has what the other repo needs, like versions and steps, close when it lacks it.
  - `discussion`, on an issue, with `as: "me"`: he converts it on GitHub. No `text`.
  - `issue`, on a discussion, with `as: "me"`, only when `botCommands.escalate` exists: for a confirmed bug. The board copies the command for him to post. No `text`. The bot never posts that command.
  Reports for projects outside the org get a `close` with a redirect reply.
- **`drive`**: the agent drives the PR on its own for up to `params.maxRounds` rounds (1 to 3, default 3): it judges and addresses the open review comments, pushes, requests a review from the profile's review bot and repeats. Leave `text` out.

**Who may push to a PR** (the one rule, other files point here): pushing our commits to a contributor's PR is always a take-over. The one exception is `format`: it applies only what the project's formatter and lint autofix change, on files the PR already changed, so it sets no `takenOver` and unlocks neither `drive` nor `address_review`.

- On PRs by the maintainer, the bot or with `authorType: "copilot"`, and on contributor PRs with `takenOver: true`, judged open threads get `drive` or `address_review`. When the profile's `reviewBots` is not empty and open review threads are the only thing left, recommend `drive` and offer `address_review` as the alternative, for when he wants to decide per thread. Otherwise `address_review`.
- On a contributor PR without `takenOver: true`, never `drive` and never `address_review`. When we would fix the threads or findings ourselves, recommend `take_over` with `mode: "push"`. Offer a `review` with `event: "request_changes"` or `"comment"` as the alternative, for when the contributor should do it himself. Taking over beats asking when the change is small and quick, or the contributor is slow or gone. A round trip with a contributor costs days for a change that takes a minute. When the contributor is active and the change needs his knowledge, recommend the `review` and leave out `take_over`. A drive pushes commits, which can dismiss an earlier approval. The item a drive returns says in `state` when the PR needs a new approval.
- **`open`**: only for a blocked item (`blocked` set by the routine after a safety-filter stop or three failed analyses). `as: "me"`, no text. The board opens the thread on GitHub. Never write it otherwise.
- **`format`**: `as: "agent"`, title `Format: fix formatting and lint`, no text. Offered when `autofix.changes` is true and the bot can push to the PR branch. One click applies exactly the autofix result as one commit by the bot. When formatting is the only problem of an otherwise clean PR, it is the recommended route and the item is `easy`. Otherwise it is a quiet alternative.
- **`chore`**: one bot action from the list in SPEC.md, with that action's params in `params`. Example: `{ "type": "chore", "as": "bot", "params": { "action": "answer_discussion", "commentId": "DC_kwDO…" } }`. Use it as the recommended route only when the chore is the whole job, like marking the correct answer on a discussion or rerunning a flaky CI job.

An item without routes is not shown on the board. It keeps its `section` as classified, `story`, `findings` and `threads`. It has no `hint` and no `effortMinutes`, and `state` says why nothing is to do, like `Waits for the reporter's debug log.` When you rewrite an item that had a hint, send `"hint": null` and `"effortMinutes": null`, so no old placeholder survives. Write no routes, and never a placeholder route, in these cases:

- **It needs analysis first**: a quick classification that cannot name the right action yet, or a PR with `unjudged` threads. Set `reviewDepth: "pending"`. The routine analyzes such items on its own, before any other optional review. A quick classification that can already name the right action, like merging a green dependency update, writes that route.
- **Nothing can be done until someone else acts**: the reporter owes a log, the contributor owes a change, a vendor owes an answer. The item returns when it changes on GitHub. This also covers informational issues, the maintainer's own notes and ideas that describe no concrete change, and answered discussions where no reply is owed.

A waiting item gets a route again only when a close is due: when our request to the reporter is older than `activeMaxWaitDays`, recommend `close` with reason `not_planned` and a short text that invites the reporter to reopen with the requested info.

## `links`

Related URLs the maintainer will want to open: the draft fix PR, the duplicate, the PR that fixed it, the failing CI run, the docs page an answer cites. Labels are short nouns: `Draft fix`, `Duplicate`, `Failing job`.

## Validation checklist

The routine checks each doc a subagent returns. A doc that fails any check is rejected and the item stays at `pending`.

1. It parses as one JSON object, with no text around it.
2. `repo`, `kind` and `number` match the snapshot entry of the item the subagent was given. The doc is written under the id from that entry. Ids are opaque: never build or parse one.
3. `section` is one of `active`, `easy`, `almost`, `review`, `deferred`, `hardware`.
4. `reviewDepth` is `full`, or `pending` with no routes when the subagent could not finish. A blocked item is the exception: `pending`, a `blocked` field, and exactly one `open` route. For PRs, `reviewedSha` is a 40-character SHA.
5. `state` is a non-empty string of at most 25 words that names no action: no imperative, no "merge", "close" or "reply" as the thing to do. `story` is a non-empty string of at most 90 words. With routes: `effortMinutes` is one of 1, 2, 5, 10, 15, 30, 60, and `hint` is a non-empty string of at most 60 characters, starts with a verb from the hint list and has no "maybe". Without routes: no `hint` and no `effortMinutes`.
6. `findings`, when present, is an array of objects with `severity` from the list above and a non-empty `text`. Every `routeId` names a route in this doc that is not a `review`. A finding that points to a `follow_up` route has exactly two sentences. Every `follow_up` route's `params.finding` is a valid index into `findings`.
7. `threads`, for PRs, has one entry per open thread in the snapshot, each with `id`, `summary` and a `verdict` of `valid`, `optional`, `wrong` or `unjudged`. `valid` and `wrong` have a `note`.
8. `routes` has 0 to 4 entries with ids `r1` to `r4`, each used once. With routes, exactly one has `recommended: true`, and its `title` equals `hint`. Every `title` has at most 60 characters. An item with an `unjudged` thread has no routes. An item at `reviewDepth: "pending"` has no routes, unless the route needs no analysis, like a merge of a green dependency update.
8a. No `merge` route and no `review` route with `event: "approve"` while a `valid` thread is open.
8b. Routes without text leave `text` out.
9. Each route's `type` is in the SPEC.md table, valid for the item's kind, and its `as` is allowed for that type and for the account setup (`accounts.md`). No route is a hide, dismiss, snooze or analyze action. Agent routes that push appear only when the account setup allows pushes.
10. Each route's `params` match its type:
    - `close`: `reason` is `completed`, `not_planned` or `duplicate`, or absent on a PR. `duplicateOf` is a number exactly when `reason` is `duplicate`. `text` is present, unless our side's last comment is already the closing statement, a merged replacement PR is linked in the thread, or a bot or dependency tool opened the PR. A `duplicate` text links the original, and a `not_planned` text gives the reason.
    - `review`: `event` is `approve`, `request_changes` or `comment`. `comments` entries have a unique `id`, a `path`, an integer `line`, an optional integer `startLine` below `line`, a non-empty `text` without a suggestion fence, and a `diffHunk` of 1 to 12 lines that starts with an `@@` header. A `suggestion` comes only with `original`, and `original` has exactly as many lines as the range from `startLine` (or `line`) to `line`. A PR by the bot gets only `comment`. `request_changes` only with at least one `major` or `blocker` finding, `comment` otherwise.
    - `follow_up` with `as` `bot` or `me`: `params.title` is set.
    - `take_over`: `mode` is `push` or `replace`. `replace` has a non-empty `callout`.
    - `drive`: `maxRounds` is 1, 2 or 3. The profile's `reviewBots` is not empty. The PR's author is the maintainer, the bot or has `authorType: "copilot"`, or the item has `takenOver: true`.
    - `address_review`: the same authors as `drive`, or `takenOver: true`. A contributor PR without `takenOver: true` gets `take_over` instead.
    - `move`: on an issue, `to` is a repo from `relatedRepos` with `as: "bot"` and a non-empty `text`, or `discussion` with `as: "me"`. On a discussion, `to` is `issue` with `as: "me"`, and `botCommands.escalate` exists.
    - `chore`: `action` is `label`, `assign`, `ready`, `answer_discussion`, `react`, `update_branch` or `rerun_ci`, and the other keys are that action's params.
11. `reply`, `request_logs` and `follow_up` routes have a non-empty `text`. A `review` has a `text` or at least one comment. No `text` contains a command from the profile's `botCommands`.
11a. No route has a type listed in the item's `dismissedRoutes`. A `close` with reason `not_planned` on a feature request is not the only route.
12. An `address_review` route, or a `take_over` route on an item with threads, appears only when `threads` is non-empty and no thread is `unjudged`. Its title counts the `valid` threads, the only ones that default to fix, like `Address review: 3 of 4 threads` or `Take over: fix 1 review comment`.
12b. `analyzedBy` is absent or `"fallback"`. With `"fallback"`, `findings` has the `question` entry about the safety-filter stop.
12d. `autofix`, when present, is `{ changes: boolean, files: number, lines: number, tools: [string] }`, and `changes` is true exactly when `files` is above 0. A `format` route appears only with `autofix.changes: true`. No finding, inline comment, `state` or `story` is about formatting or lint autofix.
12f. `params.alsoAnswer`, when present, appears only on a `close` of a discussion with `facts.answerable` and no chosen answer, with a `commentId`, an `https://` `url` and a `gist` of at most 12 words.
12h. A returned doc carries no `handled` and no `dismissedRoutes` changes.
12g. An item with routes has `effortMinutes`. Bot or agent backlog has exactly one `Implement:` route and section `deferred`.
12e. `params.alsoLabel`, when present, appears only on `reply` and `request_logs`, uses only labels from `autoLabels`, adds only labels the item lacks and removes only labels it has, and never contradicts `wants`.
12c. `wants`, when present, is `{ labels: { add: [string], remove: [string] }, assignees: [string] }` with every label in the profile's `autoLabels`, and comes with a non-empty one-sentence `wantsReason`.
13. `rounds`, when present, is an array of `{ n, fixed, dismissed, open }`: `n` a number, `fixed` and `open` arrays of strings, `dismissed` an array of `{ summary, reason }`. `takenOver`, when present, is `true`.
14. `links`, when present, is an array of `{label, url}` with `https://` URLs.
15. Strings are plain text or Markdown. The board renders them as text, so HTML in them shows up literally.

Fix nothing in a returned doc except the GitHub-derived fields the routine always overwrites. A doc that needs other repairs failed the review.
