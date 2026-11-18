# Mode: drive

The maintainer clicked `drive` on a PR. You drive the PR on your own for up to `params.maxRounds` rounds (1 to 3, default 3). Each round judges and addresses the open review comments, pushes, and requests a review from the profile's review bot. The next round starts when that review has arrived.

When `drive` is allowed and when it is preferred over `address_review` is the rule in `<core>/skills/triage-routine/references/item-doc.md`, "Who may push to a PR". Check that first. Otherwise, return `status: "failed"` without touching the PR.

## One round per subagent

Waiting for a bot review takes minutes. A worker that waits would hold its slot, so every round is its own worker. Between rounds `gary watch-queue`, which the `triage-master` session runs under one Monitor, reads the PR once a minute and prints a line when the review arrived. The master starts the next round on that line. No round waits for an hourly run.

The drive's state lives in `<state>/drive/<itemId>.json`, because a drive can span several hourly runs:

```json
{ "actionId": "<action id>", "repo": "<owner>/<repo>", "number": 412, "maxRounds": 3, "reviewBot": "<first entry of reviewBots>", "rounds": [ { "n": 1, "fixed": ["…"], "dismissed": [ { "summary": "…", "reason": "…" } ], "open": [] } ], "lastPushedSha": "<sha>", "reviewRequestedAt": "ISO" }
```

The caller passes the action file, the item file, the state file path (it does not exist before round 1) and a scratch directory.

## A round

1. Read the state file, if any. `n` is the number of rounds done plus 1.
2. Check the preconditions in `push-to-pr.md`. From round 2 on, the head must equal `lastPushedSha` instead of `reviewedSha`. A different head means someone else pushed: stop.
3. Read CI for the head (`gh pr checks <n> --repo <owner>/<repo>`). A failure caused by the PR's own change that you can fix from the job log is part of this round. A failure you cannot fix, or one from infrastructure, is a stop.
4. Fetch the open threads, as `address-review.md` does. Judge each one against the code at the head, with the same verdicts as a full review: `valid`, `optional`, `wrong`.
   - `valid`: fix it.
   - `wrong`: dismiss it with a short reason.
   - `optional`: fix it when the change is small and mechanical. That is your own judgement here, because nobody chose per thread. Otherwise leave it open, and it goes into `open`.
5. If a fix would touch a sensitive path, leave that thread open and stop after this round.
6. When nothing is left to fix or dismiss, stop without pushing.
7. Make the fixes in the worktree, one commit per round, like `fix: address review feedback (round 2)` in the project's format. Push as `push-to-pr.md` describes. Reply in every handled thread and resolve it, as `address-review.md` describes, with your verdict's reason as the reply for dismissed ones.
8. If rounds remain and this round fixed something, request a review from the review bot:
   ```json
   { "itemId": "<itemId>", "action": "request_review", "params": { "reviewer": "<reviewBot>" }, "text": "" }
   ```
   Write it to `<scratch>/request-review.json` and run `gary action <scratch>/request-review.json`. It runs under the maintainer's login.
9. Append the round to the state file, with `lastPushedSha` and `reviewRequestedAt` set to now.

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

Then delete the state file.

The drive ends when:

- no valid comment is left after a round, or the bot's review brought no new threads,
- `maxRounds` rounds are done,
- CI fails for a reason you cannot fix,
- someone else pushed to the branch,
- a needed change would touch a sensitive path,
- the bot's review did not arrive within 30 minutes.

## Between rounds

The state file with `reviewRequestedAt` is all a waiting drive needs. `gary watch-queue` reads `repo` and `number` from it, never from the id, and reads the PR once a minute. Review bots post under app logins that start with their name, like `<reviewBot>-pull-request-reviewer[bot]`, so it compares case-insensitively by prefix. It prints one line per review request:

```json
{ "instance": "widgets", "id": "<action id>", "itemId": "pr-412", "action": "drive", "event": "review-arrived" }
```

`event` is `review-timeout` when no review arrived within 30 minutes. The master starts the next round's worker on that line. A worker started on `review-timeout` ends the drive with the reason `The review did not arrive within 30 minutes.`

## A drive on Gary's own fix PR

`gary fix-review start` begins these rounds right after a fix PR was recorded, without a click. The drive's action doc and state file carry `by: "fix"` and `fixFor`, the item the fix is for. The first review is already requested when the state file appears, so your first round starts with a review to address. Everything above holds, with these differences:

- The PR has no board item, and the caller passes no item file. Take repo and number from the state file. The head must equal `lastPushedSha` in every round. Nothing here needs `reviewedSha`.
- "Who may push to a PR" holds by construction: the PR is the bot's own. Check that `gary fixes --json` lists the PR for the `fixFor` item. Otherwise, stop and touch nothing.
- A comment or a review by a person on the PR since `startedAt` ends the drive, like a push by someone else does. The review bot, the configured bot and automated comments do not count. Read them from `gary item pr <number>`: `facts.timeline` entries with side `them` or `us` whose author is not the bot.
- You never return an item and never write routes. The drive ends through one command, in every case:
  ```bash
  gary fix-review finish --pr <number> --outcome done --reason "<why the rounds ended>"
  ```
  Use `--outcome done` when the review bot has nothing open after a round, when its review brought no new threads, or when `maxRounds` rounds are done. The command marks the PR ready when the instance's `fixReview.markReady` is on. You never mark it ready yourself. Use `--outcome stopped` when the drive is stuck or failed: CI fails for a reason you cannot fix, the push was refused, a person commented or pushed, a needed change would touch a sensitive path, or the review did not arrive. The PR then stays a draft.
- `--reason` is one or two plain sentences for the maintainer, like `Copilot found nothing new after round 2.` or `CI fails in the build step, which the fix cannot change.` Name the comments still open after the last round there, in words. Never put a node id into it.
- The command queues the full review of the PR item and deletes the state file. The master starts that review within seconds, and its worker writes the item with the `rounds` and your reason. Return `{ "status": "done", "result": "<the reason>" }` without `item`.
- Exit code 4 means the instance is paused: nothing was sent and the state file stays. Record the step in `<run>/would-have.json` and return `status: "waiting"`.

Append each round to the state file before you request the next review, so the issue's chip shows the stage.

The routes of the returned item follow "Routes after a push" in `push-to-pr.md`: routes from before the push are dropped, and `reviewedSha` is the new head.

## Last step

On every exit path, failures and refusals included: release your claims with `gary release <itemId> <kind> --run <run>`, and set the action doc to `done` or `failed`. A doc left `queued` or claimed blocks the item, because such docs do not expire.
