# Mode: drive

The maintainer clicked `drive` on a PR, or the code started a drive without a click: the review rounds of a fix PR (see "A drive on Gary's own fix PR") or a round for feedback on a watched PR (see "A round for feedback on a watched PR"). You drive the PR on your own for up to `params.maxRounds` rounds (1 to 3, default 3). Each round judges and addresses the open review comments, pushes, and requests a review from the profile's review bot. The next round starts when that review has arrived.

A watched PR is an open PR by the instance's bot, Gary's fix PRs among them, or a PR whose item has `takenOver: true`. Its state file stays after the drive, with `stage: "watch"`, until the PR is merged or closed. No watched PR gets more than 3 review bot rounds over its whole life. `gary pr-watch` enforces both.

When `drive` is allowed and when it is preferred over `address_review` is the rule in `<core>/skills/triage-routine/references/item-doc.md`, "Who may push to a PR". Check that first. Otherwise, return `status: "failed"` without touching the PR.

## One round per subagent

Waiting for a bot review takes minutes. A worker that waits would hold its slot, so every round is its own worker. Between rounds `gary watch-queue`, which the `triage-master` session runs under one Monitor, reads the PR once a minute and prints a line when the review arrived. The master starts the next round on that line. No round waits for an hourly run.

The drive's state lives in `<state>/drive/<itemId>.json`, because a drive can span several hourly runs:

```json
{ "actionId": "<action id>", "repo": "<owner>/<repo>", "number": 412, "maxRounds": 3, "reviewBot": "<first entry of reviewBots>", "rounds": [ { "n": 1, "fixed": ["…"], "dismissed": [ { "summary": "…", "reason": "…" } ], "open": [] } ], "lastPushedSha": "<sha>", "reviewRequestedAt": "ISO" }
```

On a watched PR the file also has `watch: true`, `stage` (`review` while a review bot round waits, `watch` otherwise), `copilotRounds` (the review bot rounds requested over the PR's life) and `seenAt: { me, others }`. Only `gary pr-watch` and `gary fix-review` change those fields. You append to `rounds` and set `lastPushedSha` yourself.

The caller passes the action file, the item file, the state file path (on a PR that is not watched it does not exist before round 1) and a scratch directory.

## A round

1. Read the state file, if any. `n` is the number of rounds done plus 1.
2. Check the preconditions in `push-to-pr.md`. From round 2 on, the head must equal `lastPushedSha` instead of `reviewedSha`. A different head means someone else pushed: stop.
3. Read CI for the head (`gh pr checks <n> --repo <owner>/<repo>`). A failure caused by the PR's own change that you can fix from the job log is part of this round. A failure you cannot fix, or one from infrastructure, is a stop.
4. Note the time, then fetch the open threads and the PR's comments, as `address-review.md` does. That time is the round's `<read at>`. Judge each thread against the code at the head, with the same verdicts as a full review: `valid`, `optional`, `wrong`. A thread or comment by the maintainer (`me`) since the last round is part of this round, whatever started it. Judge it by "The maintainer's threads" below. Threads and comments by other people are judged only in a round with `params.trigger: "others"`. In any other round, leave them alone: the hourly run starts their round. The review bot's threads get these verdicts:
   - `valid`: fix it.
   - `wrong`: dismiss it with a short reason.
   - `optional`: fix it when the change is small and mechanical. That is your own judgement here, because nobody chose per thread. Otherwise leave it open, and it goes into `open`.
5. If a fix would touch a sensitive path, leave that thread open and stop after this round. The one exception is a PR that is ours alone, as `gary push-check` in the preconditions confirmed. There a fix may change the sensitive files the PR already changes. A fix that needs another sensitive path still stays open.
6. When nothing is left to fix, push nothing. Still reply in the threads that need an answer, then stop.
7. Make the fixes in the worktree, one commit per round, like `fix: address review feedback (round 2)` in the project's format. Push as `push-to-pr.md` describes. Reply in every handled thread and resolve it, as `address-review.md` describes, with your verdict's reason as the reply for dismissed ones.
8. Append the round to the state file, with `lastPushedSha` set to the head you pushed.
9. If rounds remain, this round fixed something and the profile lists a review bot, request a review from the review bot. On a watched PR, run `gary pr-watch review --pr <n> --sha <head> --action <action id> --seen-me <read at>`, and add `--seen-others <read at>` when this round judged other people's feedback. It requests the review, counts the round and refuses with exit code 3 when the PR had all its rounds: then the drive ends. It answers `skipped` with exit code 0 when the profile lists no review bot: then the drive ends cleanly. On any other PR, write
   ```json
   { "itemId": "<itemId>", "action": "request_review", "params": { "reviewer": "<reviewBot>" }, "text": "" }
   ```
   to `<scratch>/request-review.json`, run `gary action <scratch>/request-review.json`, which runs under the maintainer's login, and set `reviewRequestedAt` in the state file to now.

## Return after a round

Your final report is one JSON object and nothing else.

When the drive continues:

```json
{ "status": "waiting", "result": "round 2 pushed, review requested", "statePath": "<state>/drive/pr-412.json" }
```

When the drive ends, for any of the reasons below, return `{ status: "done", result, item }` as `push-to-pr.md` describes. Use `status: "failed"` only when nothing was done at all. The item gets:

- `rounds` copied from the state file,
- `threads` with the threads still open and your verdicts,
- `reviewedSha` set to the last pushed head,
- routes that fit: `merge` as `me` when nothing is open and CI passes. Otherwise `address_review` when the open threads need his decision, or `review` when findings for the contributor remain,
- a `state` that names why the drive stopped, and says when the PR needs a new approval because our pushes dismissed the earlier one, like `The review bot found nothing new after round 2.` or `CI fails in the build step, which needs a decision on the API.`

Then, on a watched PR, run `gary pr-watch done --pr <n> --sha <head> --seen-me <read at>`, with `--seen-others <read at>` when this round judged other people's feedback. Add `--request-maintainer` when the drive ended cleanly, as "Clean and stuck ends" below defines. The PR goes back to waiting for the maintainer's feedback. On any other PR, delete the state file.

With `--request-maintainer` the command then requests his review on GitHub, as the bot. Its output's `maintainerReview` says whether the request went out, was skipped or failed. A skip or a failure does not fail the command, and the round has ended all the same. Name a failure in `result`. Exit code 4 means the instance is paused: nothing changed. Record the step in `<run>/would-have.json` and run `gary pr-watch done` again without the flag, so the round ends.

The drive ends when:

- no valid comment is left after a round, or the bot's review brought no new threads,
- `maxRounds` rounds are done,
- CI fails for a reason you cannot fix,
- someone other than the maintainer and the bot pushed to the branch,
- another person commented or reviewed since the drive started, in a drive that no `params.trigger: "others"` started,
- a needed change would touch a sensitive path that step 5 does not allow,
- the bot's review did not arrive within 30 minutes.

### Clean and stuck ends

The first two reasons are a clean end: the drive's outcome is `done`, and you have nothing left that you could do on your own. Threads left open for his decision count as clean, because the next move is his. A round for feedback that handled its feedback and requests no next review bot round ends cleanly too. Every other reason is a stuck end, like a refused push or a refusal of `gary push-check`. Only a clean end passes `--request-maintainer`. Never name him with an @-mention, in a reply, a comment or a `--reason`. The review request is his notification.

## Between rounds

The state file with `reviewRequestedAt` is all a waiting drive needs. `gary watch-queue` reads `repo` and `number` from it, never from the id, and reads the PR once a minute. Review bots post under app logins that start with their name, like `<reviewBot>-pull-request-reviewer[bot]`, so it compares case-insensitively by prefix. It prints one line per review request:

```json
{ "instance": "widgets", "id": "<action id>", "itemId": "pr-412", "action": "drive", "event": "review-arrived" }
```

`event` is `review-timeout` when no review arrived within 30 minutes. The master starts the next round's worker on that line. A worker started on `review-timeout` ends the drive with the reason `The review did not arrive within 30 minutes.`

## A drive on Gary's own fix PR

`gary fix-review start` begins these rounds right after a fix PR was recorded, without a click. The drive's action doc and state file carry `by: "fix"` and `fixFor`, the item the fix is for. The first review is already requested when the state file appears, so your first round starts with a review to address. Everything above holds, with these differences:

- The PR has no board item during its first rounds, and the caller passes no item file then. Take repo and number from the state file. The head must equal `lastPushedSha` in every round. Nothing here needs `reviewedSha`.
- "Who may push to a PR" holds by construction: the PR is the bot's own. Check that `gary fixes --json` lists the PR for the `fixFor` item. When a discussion became an issue, `fixFor` can name either one. `gary fixes` lists the PR for both. Otherwise, stop and touch nothing. The preconditions of `push-to-pr.md` hold here too, with `lastPushedSha` as the SHA for `gary push-check`. A fix PR that changes sensitive files passes while only the bot and the maintainer have committed to it.
- A comment or a review by another person on the PR since `startedAt` ends the drive, like a push by someone else does. The maintainer does not count: his feedback is part of the next round. The review bot, the configured bot and automated comments do not count either. Read them from `gary item pr <number>`: `facts.timeline` entries with side `them`, or side `us` whose author is neither `me` nor the bot.
- You never return an item and never write routes. The drive ends through one command, in every case:
  ```bash
  gary fix-review finish --pr <number> --outcome done --reason "<why the rounds ended>" --seen-me <read at> --request-maintainer
  ```
  Add `--seen-others <read at>` when the round judged other people's feedback. Pass `--request-maintainer` with every `--outcome done` and never with `--outcome stopped`. After the ready mark, the command requests his review as the bot. `maintainerReview` in its output says what happened, and a failed request still ends the rounds.
  Use `--outcome done` when the review bot has nothing open after a round, when its review brought no new threads, or when `maxRounds` rounds are done. The command marks the PR ready when the instance's `fixReview.markReady` is on. You never mark it ready yourself. Use `--outcome stopped` when the drive is stuck or failed: CI fails for a reason you cannot fix, the push was refused, a person commented or pushed, `gary push-check` refused, a needed change would touch a sensitive path that step 5 does not allow, or the review did not arrive. The PR then stays a draft.
- `--reason` is one or two plain sentences for the maintainer, like `Copilot found nothing new after round 2.` or `CI fails in the build step, which the fix cannot change.` Name the comments still open after the last round there, in words. Never put a node id into it.
- The command queues the full review of the PR item and puts the state file into the stage `watch`. It marks the PR ready only the first time. The master starts that review within seconds, and its worker writes the item with the `rounds` and your reason. Return `{ "status": "done", "result": "<the reason>" }` without `item`.
- Exit code 4 means the instance is paused: nothing was sent and the state file stays. Record the step in `<run>/would-have.json` and return `status: "waiting"`.

Append each round to the state file before you request the next review, so the issue's chip shows the stage.

The routes of the returned item follow "Routes after a push" in `push-to-pr.md`: routes from before the push are dropped, and `reviewedSha` is the new head.

## A drive after a push by another job

A `revise`, `take_over` or `address_review` job that pushed to a watched PR requests a review bot review with `gary pr-watch review --after`, when the profile lists a review bot. That writes a `drive` action doc with `params.after` naming the job, or `api_edit` after the server's API edit, and puts the state file into the stage `review`. The master starts your first round when the review arrived. Everything above holds, with these differences:

- Your first round starts with a review to address. `n` is the number of rounds in the state file plus 1.
- The head must equal `lastPushedSha`, the job's push.
- `params.by` is `fix` on a fix PR, and the drive ends through `gary fix-review finish`. Otherwise it is `watch`, and the drive ends with `gary pr-watch done` as above.

## A round for feedback on a watched PR

`gary pr-watch round` queues such a round without a click. Its action doc has `params.trigger`: `maintainer` when the maintainer reviewed or commented, `others` when the hourly run found reviews or comments by other people. `params.at` is the time of the newest feedback that started it, and `params.by` is `fix` on a fix PR and `watch` otherwise. The state file exists with `stage: "watch"`. The caller passes the item file when the PR has one. Everything above holds, with these differences:

- It is one round, `n` the number of rounds in the state file plus 1. It needs no review bot review to start.
- "Who may push to a PR" holds: the PR is by the bot or has `takenOver: true`, as `gary pr-watch` checked. The preconditions of `push-to-pr.md` hold, with the PR's current head as the SHA for `gary push-check`. A head other than `lastPushedSha` is fine when every newer commit is by the maintainer or the bot. A commit by anyone else stops the round. A bot PR can carry commits by other people, and then it is not ours alone: `gary push-check` decides that, never you.
- The maintainer's threads and comments follow "The maintainer's threads" below. Other people's follow "Other people's threads", and only with `params.trigger: "others"`.
- A plain PR comment that asks for a change counts like a thread. Answer such comments in one PR comment as the writing identity, saying what you changed or why not. Post nothing else.
- When the profile lists a review bot, review bot rounds remain and the round pushed, request the next one with `gary pr-watch review`, as step 9 says. The drive then continues as above.
- When the round ends without a next review bot round: on a fix PR, end through `gary fix-review finish` as in the section above. On any other PR, return `{ status: "done", result, resultParts, item }` as `push-to-pr.md` describes, with the round appended to `rounds`, and run `gary pr-watch done`, with `--request-maintainer` when the round ended cleanly. Its item is the PR reviewed again on the new head, with a card for every thread that stayed open for his decision.

### The maintainer's threads

He sometimes asks a question or is not sure himself. Judge his threads less strictly than an outside reviewer's: his request wins unless it is clearly wrong or the code shows he misread it.

- A request you find right, or that is a matter of taste: fix it, reply what you changed, resolve the thread.
- A question: answer it in the thread. Fix something only when the answer shows a fix is needed. Leave the thread open for him when it was only a question.
- A request you find clearly wrong, or one that rests on a misreading of the code: reply why, with the line or the fact that shows it. Leave the thread open for him.
- A request outside the PR's scope or one that needs a design decision: reply what it would take, leave it open, and put it into `open`.

### Other people's threads

Judge them like any review, by the same verdicts as a full review.

- `valid`: fix it, reply what you changed, resolve the thread.
- `wrong`: reply why, and leave the thread open for the maintainer.
- Anything that needs his decision: a design question, a disagreement between him and the other reviewer, a request outside the PR's scope. Reply nothing, leave the thread open and put it into `open`. The item's card shows it.

## Last step

On every exit path, failures and refusals included: release your claims with `gary release <itemId> <kind> --run <run>`, and set the action doc to `done` or `failed`. A doc left `queued` or claimed blocks the item, because such docs do not expire.
