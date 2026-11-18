# Mode: drive

The maintainer clicked `drive` on a PR. You drive the PR on your own for up to `params.maxRounds` rounds (1 to 3, default 3). Each round judges and addresses the open review comments, pushes, and requests a review from the profile's review bot. The next round starts when that review has arrived.

`drive` is only valid on PRs by the maintainer, the bot or with `authorType: "copilot"`, and on contributor PRs whose item has `takenOver: true`, and only when the profile's `reviewBots` is not empty. Check that first. Otherwise, return `status: "failed"` without touching the PR.

## One round per subagent

Waiting for a bot review takes minutes. A subagent that waits would hold its slot, so every round is its own subagent, and the master session waits between rounds with the Monitor tool. That is the same mechanism the routine uses for the action queue, and it does not block the hourly run.

The drive's state lives in `<state>/drive/<itemId>.json`, because a drive can span several hourly runs:

```json
{ "actionId": "pr-412-…", "maxRounds": 3, "reviewBot": "<first entry of reviewBots>", "rounds": [ { "n": 1, "fixed": ["…"], "dismissed": [ { "summary": "…", "reason": "…" } ], "open": [] } ], "lastPushedSha": "<sha>", "reviewRequestedAt": "ISO" }
```

The caller passes the action file, the item file, the state file path (it does not exist before round 1) and a scratch directory.

## A round

1. Read the state file, if any. `n` is the number of rounds done plus 1.
2. Check the preconditions in `push-to-pr.md`. From round 2 on, the head must equal `lastPushedSha` instead of `reviewedSha`. A different head means someone else pushed: stop.
3. Read CI for the head (`gh pr checks <n> --repo <owner>/<repo>`). A failure caused by the PR's own change that you can fix from the job log is part of this round. A failure you cannot fix, or one from infrastructure, is a stop.
4. Fetch the open threads, as `address-review.md` does. Judge each one against the code at the head, with the same verdicts as a full review: `valid`, `optional`, `wrong`.
   - `valid`: fix it.
   - `wrong`: dismiss it with a short reason.
   - `optional`: fix it when the change is small and mechanical. Otherwise leave it open, and it goes into `open`.
5. If a fix would touch a sensitive path, leave that thread open and stop after this round.
6. When nothing is left to fix or dismiss, stop without pushing.
7. Make the fixes in the worktree, one commit per round, like `fix: address review feedback (round 2)` in the project's format. Push as `push-to-pr.md` describes. Reply in every handled thread and resolve it, as `address-review.md` describes, with your verdict's reason as the reply for dismissed ones.
8. If rounds remain and this round fixed something, request a review from the review bot:
   ```json
   { "itemId": "pr-<n>", "action": "request_review", "params": { "reviewer": "<reviewBot>" }, "text": "" }
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
- a `state` that names why the drive stopped, like `The review bot found nothing new after round 2.` or `CI fails in the build step, which needs a decision on the API.`

Then delete the state file.

The drive ends when:

- no valid comment is left after a round, or the bot's review brought no new threads,
- `maxRounds` rounds are done,
- CI fails for a reason you cannot fix,
- someone else pushed to the branch,
- a needed change would touch a sensitive path,
- the bot's review did not arrive within 30 minutes.

## What the master does between rounds

On `status: "waiting"`, the master arms a Monitor that polls for a review by the review bot newer than `reviewRequestedAt`. Review bots post under app logins that start with their name, like `<reviewBot>-pull-request-reviewer[bot]`, so the poll compares case-insensitively by prefix. The profile's `rules/review.md` may name the exact login.

```
Monitor command="until gh api repos/<owner>/<repo>/pulls/<n>/reviews --jq '[.[] | select((.user.login | ascii_downcase | startswith(\"<reviewBot>\")) and .submitted_at > \"<reviewRequestedAt>\")] | length' | grep -qv '^0$'; do sleep 60; done; echo review-arrived" description="review bot review for pr-<n>" timeout_ms=1800000
```

On the event, it starts the next round's subagent. On expiry, it starts one more subagent that ends the drive with the reason `The review did not arrive within 30 minutes.`
