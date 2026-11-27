# The local review stage

Local reviewers read a job's commits before the job pushes. SPEC.md, "Local review", is the contract. This file is the worker's part: you run the reviewers between the job's commit and its push, because the job usually runs as your subagent and cannot start subagents itself.

## Is it on

Run `gary local-review plan` once per run, right after `gary models`. It prints `{ reviewers, maxPasses, source, reason }`.

- `reviewers` is empty: nothing in this file applies. Brief every job as before, start no reviewer, and run no `gary local-review` command. This is the case for an instance with a GitHub review bot and no `review.local`.
- `reviewers` has entries: add the line `Local review: on.` to the brief of every job that may push: a fix (`triage-issue` fix mode), a `drive` round, a round for feedback, `revise`, `take_over` and `address_review`, and the drive on the maintainer's own PR in a contributions instance. A `format` job gets no local review and no such line.

## The handoff

A job with the line commits its change and returns, before any push:

```json
{ "status": "local_review", "itemId": "pr-412", "worktree": "<its worktree>", "base": "<sha it started from>", "head": "<sha it committed>", "job": "<action id or run>" }
```

It keeps its worktree and its claims. Then, for that job:

1. Run `gary local-review pass <itemId> --base <base> --head <head> --worktree <worktree> --job <job>`. It makes a read-only worktree of the head, runs the CLI reviewers itself and prints `{ pass, maxPasses, last, agents, cli, findingsFile }`. Exit code 3 is a refusal: hand its `refused` text back to the job as the result of the stage, and the job stops without a push.
2. For each entry of `agents`, start one subagent, all in one message so they run in parallel. The prompt is exactly `Read <brief> and follow it exactly.` with the entry's `brief`. Pass no other context: no item doc, no diff, no notes of the job.
   - `kind: "self"`: the Agent tool, `subagent_type: "general-purpose"`, `model: <review>`.
   - `kind: "agent"`: the tool of your harness that starts a session on another provider, with the entry's `provider` and `model`. In T3 Code that is `delegate_task`. A headless `claude -p` worker reaches only Claude models through the Agent tool, and only by an alias.
   - When you cannot start the reviewer, run `gary local-review skip <itemId> --reviewer <key> --reason "<why>"`, like `codex is not reachable from a headless claude -p worker.`
3. When every started reviewer returned, run `gary local-review collect <itemId>`. A reviewer that wrote no findings file counts as failed, and the stage goes on. Skip this step when `pass` already printed `findingsFile`.
4. Hand the findings back to the job: `{ "localReview": { "worktree", "base", "head", "findingsFile", "pass", "last" } }`. Where your harness can continue a finished subagent, like SendMessage to it, continue the same job with that object. Otherwise start the job again in the same mode, with the same brief plus that object. It goes on in the same worktree.
5. The job judges the findings, fixes the valid ones, commits and runs `gary local-review judge`. When its result says `next: "pass"`, the job returns `status: "local_review"` again with the new head: go back to step 1. When it says `next: "push"`, the job pushes and returns as usual.

Read nothing of the findings yourself. You pass file paths and take back these short results.

## Without subagents

When you cannot start subagents, you do the job yourself (SKILL.md, "Subagents or not"). The stage still runs: run `gary local-review pass` and `collect` as above. A `self` reviewer has no fresh context then, because you wrote the change. Skip it with the reason `The worker cannot start subagents, so a self review has no fresh context.` Start an `agent` reviewer when a tool for another provider is there, and skip it with the reason otherwise. Then judge the CLI findings as the job.

## The summary

A request job's one line names the stage when it ran, like `revise for pr-412: pushed 1 commit after 2 local passes, 1 finding fixed.` An hourly run adds one line when any job ran it: `Local review: 3 jobs, 5 passes, 4 findings fixed, 1 reviewer skipped (codex: not reachable).`
