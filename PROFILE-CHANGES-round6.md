# Profile changes for round 6

Wording changes a project profile needs after the round-6 changes in the core. Nothing here is applied anywhere. The line numbers are from the zwave-js profile copy that was read for this list.

## zwave-js profile

### `rules/classification.md`

1. **Line 72, the `take_over` example stays as it is.** "A contributor's config PR lacks metadata that a sibling device file on master already has … `take_over` with `mode: "push"` is the quickest way" is still right. A contributor PR that is not taken over is the one place where `take_over` is valid now. Optional addition at the end of that bullet:

   > After the take-over, further changes to that PR are a `revise` ("Change") route.

2. **Line 58, the routes on AI-written PRs.** The bullet says: "Recommend what moves his review forward: `drive` when review threads are open, otherwise no agent route." The bot's own PRs now get `revise` for one concrete change, like dropping a file from a draft fix PR. Proposed wording:

   > Recommend what moves his review forward: `drive` when review threads are open, a `revise` ("Change") route when the agent can name one concrete change to the PR, otherwise no agent route. Never `take_over`: these PRs are ours already.

3. **Line 51, what counts as AI-written.** The code no longer counts the bot's own commits on a PR someone else opened. Add one sentence after "`facts.aiSignals` lists what it found.":

   > The bot's own commits on a contributor's PR, from a take-over, a change or a format run, do not count. `facts.ourCommits` counts them, and such a PR is judged like the contributor's PR it is.

4. **Line 41, PRs from the bot go to `review`.** Still right. Gary's own fix PRs now arrive on the board after their Copilot review rounds, marked ready. Optional addition:

   > A fix PR Gary opened reaches the board after its Copilot review rounds. Its item names the rounds and what they left open.

5. **No change needed for a fix in progress.** The profile has no rule that offers a "fix is in review" reply on the issue. The core now keeps such an issue or discussion out of the plan and writes no route that only announces the fix.

### `rules/issues.md`

6. **New rule under the fix section (after line 88): what a fix PR says.**

   > A fix PR's body describes the change and its evidence. It never @-mentions the reporter and never asks anyone to test or confirm. `Fixes #N` is the link. What the fix could not verify goes to the maintainer in one sentence under the evidence.

7. **New rule in the same place: second sources for device configs.**

   > Before calling a device config unverified, check a second source. The Z-Wave Alliance product database entry of the device lists its parameters and association groups. The manufacturer's manual is the other source. A sibling device of the same series with the same firmware family is good evidence for the parameter set. A config PR that rests on one of these does not need the reporter's confirmation.

8. **"Ask the reporter to test" needs a way to test a PR build. TODO for the maintainer.** With the new switch on the fix card, the PR body ends with one request to the reporter, and it should say how to install the PR's build "when the profile describes that". The profile's rules do not describe it today: `rules/voice.md` only has the links for logs and diagnostics. Decide what to name there, then add it to `rules/issues.md`, for example:

   > To test a fix PR, the reporter … (TODO: name the way, like the bot command that builds a test package for the PR, or the Z-Wave JS UI setting that installs a driver PR build).

   Until this exists, the request names what to test and leaves out the install steps.

### `rules/review.md`

9. **Review event.** The profile presets no `comment` review. Line 37, "A clean config PR gets a `review` with `event: "approve"` and text `Thanks!`", stays. If a rule for config PRs with findings is added later, it uses `event: "request_changes"`: the core no longer presets `comment`, and the validator warns on it.

10. **Line 80, the review bot's login.** Still right. The queue watcher matches review bots by a case-insensitive prefix of the name in `reviewBots`, so `copilot` matches `copilot-pull-request-reviewer[bot]`.

## Any profile

- **`take_over` on our own PRs.** A rule or example that offers `take_over` on a PR by the maintainer, the bot, another bot or Copilot, or on a PR with `takenOver: true`, has to name `revise` in its place. The validator refuses such a `take_over`.
- **Reviews.** A rule that picks `event: "comment"` by severity has to go. Every review with something for the contributor is `request_changes`, and a clean PR gets `approve`.
- **Routes after the agent pushed.** A rule that ends a finished take-over or review round with a `reply` that reports the push has to offer the decision in its place: `merge`, `review`, or another pass by the agent.
- **Fix PRs.** A rule that tells the fix to ask the reporter for a confirmation has to go. The card's switch "Ask the reporter to test" carries that wish now.

## Not in a profile: the instance's `config.json`

These are settings of the instance. They are listed here so they are not missed after the merge. Nothing was edited.

- `fixReview`: `{ "reviewer": "copilot", "requestAs": "me", "maxRounds": 3, "markReady": true }` is the default for an instance that can push. The profile's `reviewBots` must list `copilot`, which the zwave-js profile does. Set `"reviewer": "off"` to keep fix PRs as drafts without review rounds.
- `maxPendingAutoFixes`: 10 by default.
