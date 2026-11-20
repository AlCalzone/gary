# Gary internals

This page is for people changing Gary itself and for the agents' skills. A maintainer who only uses Gary needs the [README](../README.md). `SPEC.md` is the contract. When this page and the spec disagree, the spec wins.

## How the pieces connect

1. `gary snapshot` fetches the open items and prints what changed since the last run.
2. The routine in `skills/triage-routine/` reviews the changed items and writes them with `gary put`.
3. The board server in `server/server.mjs` serves `board/board.html` and pushes every change in `state/board/` to open pages. A click runs the GitHub action right away.
4. Agent requests from the board are queued in `state/board/actions/`. `gary watch-queue` wakes the master session for them.

The board server, the MCP server and `gary action` share one implementation in `scripts/lib/actions.mjs`. It accepts only the actions in the spec table and always targets the repo from the profile.

`gary paths` prints where the core, the home, the profile, the state directory and the local checkout live on this machine, as JSON.

## Instances

One machine can hold several Gary instances, one per repo:

```
~/.config/gary/                     $GARY_HOME
  personal.md                       shared by all instances
  instances/<name>/
    config.json
    personal.md                     optional, read after the shared one
    state/                          see "State layout"
```

Every `gary` command resolves the instance in this order:

1. `--instance <name>`,
2. `GARY_INSTANCE`,
3. the working directory: inside the instance's `checkout` or a git worktree of it, or a directory whose git `origin` is the instance's repo,
4. the only instance, when exactly one exists,
5. otherwise an error that lists the instances. There is no silent default.

`gary paths` prints `instance`, `root` (`$GARY_HOME`), `home` (the instance directory), `config`, `personal` (an array, shared file first), `profile`, `state`, `checkout` and `core`. `gary instances` lists the instances. `gary pause --all`, `gary resume --all` and `gary doctor --all` act on every instance. Commands that change something print the instance they acted on. `gary setup --instance <name>` creates an instance. Each instance has its own state, pause switch and decision log, and its own tab on the one board. `gary instances --json` lists the instances, see "One server, one master".

The skills resolve the instance once with `gary paths` and pass `--instance <name>` on every later command, also in subagent briefs. Only humans rely on the inference.

## One server, one master

The contract is the SPEC section "One server, one master".

- **One board server per machine** serves every instance, on the one port in `<root>/config.json` (`{ "port": 7878 }`, set with `gary setup --port`). Instance configs have no port. `gary serve` starts it (also `--watch`, `--dry-run`), and `board_start` starts or finds it from any directory. The server watches `<root>/instances/` and picks up a new instance without a restart.
- **Server-wide files** live in `<root>/state/`: `server-token` and `server.log`. Everything else stays in each instance's `state/`.
- **One master session** runs the `triage-master` skill every hour. It starts the server, starts one worker per instance that runs `triage-routine`, arms one `gary watch-queue --all` Monitor and starts one worker per agent request, and waits for drives. A worker is a child session, a headless `claude -p --model <worker>` run, or the master itself with subagents, in that order of preference. Workers report through `<state>/runs/<run>/summary.txt`, item docs and action results only.
- **Models** are set per role in `models`: `master`, `worker`, `review`, `standard` and `fast`, with the defaults `sonnet`, `sonnet`, `opus`, `sonnet` and `haiku`. `modelsOf(config, root)` in `scripts/lib/config.mjs` resolves each role from the instance config, then the root config, then `MODEL_DEFAULTS`, and `checkModels` validates both files. `master` is refused in an instance config. `master` and `worker` take an alias or a full `claude-…` id, because `claude --model` takes both. The three subagent roles take an alias only, because the Agent tool's `model` takes no full id. `gary models [--json] [--all]` (`scripts/models.mjs`) prints the result with the layer each value came from. The master passes `worker` when it starts a worker, the worker passes `review`, `standard` or `fast` on every Agent call, and every `summary.txt` ends with a `Models:` line that names what really ran. Nothing in the code can read the model of a running Claude session. So the master's own model is set where the scheduled task is created, and `gary doctor` prints it unchecked.
- **The fallback** after a safety-filter stop is the `standard` model. `modelsOf` returns it as `fallback: { model, relation }`. `relation` is `smaller` only for a known order (`haiku`, `sonnet`, `opus`), and the finding's text follows it. With the same model in both roles `fallback` is `null` and the worker blocks the item without a retry.
- **`gary watch-queue --all`** prints one line per queued agent request of any instance that is not paused: `{ "instance", "id", "itemId", "action" }`.
- **`gary paths --root`** prints `core` and `root` from any directory. `gary instances --json` returns `name`, `kind`, `repos`, `title`, `checkout`, `paused`, `served` and `current`. `board_status` returns `{ url, owner, portAnswers, instances, sessionInstance }`.
- **Kinds**: an instance has a `kind`, today only `maintainer`. Rules that differ by kind live in files named for it, like `skills/triage-routine/references/classification.maintainer.md`. Each instance has a list of allowed repos. For `maintainer` it is the profile's one `repo`, and an action on an item of another repo is refused.
- **Item identity**: every item doc carries `repo` (`owner/name`) next to `kind` and `number`. Ids are opaque (`^[a-z0-9][a-z0-9._-]{0,99}$`), and no code derives anything from one. Outside one instance an item is `{ instance, id }`. The server adds `instance` and `ref` (`owner/name#number`) to every item it serves. Decision log entries carry `instance`, `instanceKind` and `repo`.
- **API**: every endpoint names the instance. `GET /api/state` returns `board.instances[]` with each instance's title, kind, repos, bot, account mode, pause switch, related repos, bot commands and review bots, and items and proposals of all instances, each with `instance`. Clicks, decisions and board actions send `instance` in the body. Every SSE event names its instance.
- **Board page**: a combined tab "All" first, then one tab per instance. In "All", items show `owner/name#number`. Links, avatars, bot names and commands come from the item's own instance. Browser storage keys are `gary:<instance>:…`.
- **`gary migrate`** moves an installation from the layout with one server per instance.

## Commands the agents run

### gary snapshot

```sh
gary snapshot           # print the work list, stage state/snapshot.pending.json
gary snapshot --commit  # promote the staged snapshot to state/snapshot.json
```

The first command never touches the baseline in `state/snapshot.json`. `--commit` saves the snapshot from the previous plain run. Items that change on GitHub between the two calls show up again in the next run.

```jsonc
{
  "changed": [{ "id": "pr-412", "reason": "head_changed", "kind": "pr", "ci": "passing", /* … */ }],
  "unchanged": ["issue-398"],
  "closed": ["disc-371"],
  "stale": { "issues": 259, "discussions": 547 }
}
```

`closed` also lists issues and discussions that are still open but had no activity within `activeWindowDays`. Text fields are cut at 1500 characters and PRs list at most 50 changed files. A PR whose files match the profile's `sensitivePaths` carries them in `sensitiveFiles`. The staged and the committed snapshot keep that list per PR, with `sensitiveOurs: true` when the PR is ours alone. Authors count as `maintainer` when they are in the profile's `maintainers` or are `me`, and as `bot` when they are in `botLogins`, are the configured bot or are a GitHub App.

### gary item

`gary item <pr|issue|discussion> <number> [--repo owner/name]` prints the fresh snapshot entry of one item as JSON, read from GitHub with the same fields as `gary snapshot`. It writes no state. Use it to re-check one item without a full snapshot. `gary item <id>` reads an item already stored on the board. Every item doc carries `repo`.

### gary action

```sh
echo '{"action":"label","kind":"issue","number":6,"params":{"add":["bug"]}}' | gary action --dry-run
gary action action.json
gary action --check-fresh label.json
```

It prints `{ "ok": …, "result": … }` and exits with 1 when `ok` is false. Every `gh` call stops after 60 s, and a failure ends with the tail of gh's stderr. Instead of `kind` and `number`, the input may carry the `itemId` of a queued board action, like `"pr-412"`.

`--autonomous` marks an action nobody clicked. The routine passes it for every label and assign change it makes on its own. With it, only `label` and `assign` run, and `label` refuses any label outside the profile's `autoLabels`.

`--check-fresh` runs the same freshness check as a click on the board before the action. It needs the `itemId` of a board item and refuses when the thread moved since the review. `"force": true` in the input skips it, except for a moved head on a merge, an approval or a review with inline comments.

`--dry-run` validates the input, applies the account rules and runs the read-only lookups, like node ids and labels. It prints each write as the `gh` command, the account it would run as and the GraphQL body it would send on stdin.

While Gary is paused, `gary action` refuses every GitHub write with "Gary is paused. Nothing was sent."

### gary put

```sh
gary put items pr-412 item.json           # the file is the complete item and replaces the stored one
gary put --merge items pr-412 patch.json  # change only these fields, null removes a field
gary put items pr-412 --delete            # remove the item
gary put meta meta.json                   # replace meta.json
gary put proposals <id> <file>            # write a proposal
gary put learn <file>                     # write the learning cursor
```

A replace keeps the maintainer's `hidden` and `snoozedUntil`, and `priority` when the file has none. Every other field the file leaves out is gone afterwards. A dismissed route goes into the item's `dismissedRoutes`, which the routine never clears. `gary put` refuses a doc that brings back a dismissed route type.

Before every replace, and before a merge that touches `routes`, `threads`, `hint` or `findings`, it validates the item as it will be after the write, with the rules in SPEC.md under Validation. A broken rule refuses the write and prints every problem in `problems`. A warning, like an approval while a thread is judged valid, goes to stderr. `--no-validate` skips the check, for migrations.

It sends the write through the board server, so it queues behind clicks on the same item. When the server is not running, it writes the file directly with the same merge rules and says so on stderr. It prints `{ "ok": true }`, or `{ "ok": false, "error": … }` and exits with 1.

### gary watch-queue

`gary watch-queue` prints one line like `{"id":"pr-412-1763400000000","itemId":"pr-412","action":"address_review"}` for every queued, unclaimed action, first the existing ones oldest first, then each new one as it is written. The master session runs it under Monitor. `--once` prints the current queue and exits. While Gary is paused it prints nothing, and requests stay queued. For every drive that waits for its review bot it reads the PR once a minute and prints one more line with `"event": "review-arrived"`, or `"review-timeout"` after 30 minutes, so the next round starts without the hourly run. For every watched PR, the bot's open PRs and the taken-over PRs, it reads the PR every 3 minutes and once at its start, and prints a line with `"event": "maintainer-feedback"` when the maintainer reviewed or commented after our last push and no round handled it yet.

### gary api-edit

`gary api-edit --pr <n>` checks the API edit route of a stored PR item against GitHub and prints the commit and the comment the click would send, or the refusal. `--sha <head> --file <route.json>` checks a draft route before it is stored, which is how the reviewing agent finds out that its `original` matches the file exactly once. The command only reads. It has no mode that commits.

### gary push-check

`gary push-check --pr <n> --sha <head>` answers one question from GitHub's state right now: may an agent work in a checkout of this PR and push to it. It fetches the PR like `gary item`, reads every changed file and runs `oursAlone` from `scripts/lib/facts.mjs` on the live commit list. It prints one JSON object. It exits 3 in three cases: the PR is not open, its head is not `--sha`, or it changes sensitive files and is not ours alone. `refused` then holds the reason, like "commit 3 of 3 was authored by hubot". The push skills call it before they create a worktree and again right before `git push`, because the snapshot's `sensitiveOurs` can be an hour old. The command only reads.

### gary validate

`gary validate` runs the same validation as `gary put` over every stored item, read-only, and prints the problems grouped by rule. `gary validate pr-412 issue-398` checks only those. `--json` prints the result as JSON. It exits with 1 when an item fails.

### gary decisions and gary proposals

`gary decisions --since <ISO> --json` prints the entries of the decision log. `gary proposals` lists every proposal with its status. See [Learning](#learning).

## Setup in scripts

`gary setup` asks for what it needs in a terminal. In a script, pass flags:

```sh
gary setup --profile ~/repositories/gary-profile-widgets --me octocat --checkout ~/repositories/widgets \
  --bot-login widgets-bot --bot-token-file ~/.config/widgets-bot/gh-token
gary setup --repo acme/widgets --me octocat --no-bot   # new profile from profiles/template
```

It writes `config.json`, an empty `personal.md` and `state/` into the home directory. It never replaces an existing `config.json` without `--force`, and it never touches an existing `personal.md`. For a clone it also links every skill into `~/.claude/skills`, links the launcher into `~/.local/bin` and prints the `claude mcp add` command, or runs it with `--register-mcp`. `--no-links` skips that step.

## Accounts in the code

- With a bot, every GitHub write runs as the bot with its token in `GH_TOKEN`. No `gh` shell function or alias plays a part.
- Without a bot, routes without a text, like a transfer, a chore or inline review comments, run only when `allowOwnTokenPushes` is true. They then run under the maintainer's stored `gh` login, after a check that this login is `me`.
- `request_review` with `reviewer: "copilot"` always runs under his stored login, after the same check. The helper in `scripts/lib/gh.mjs` that does this sends only that one mutation.
- `request_review` with `reviewer: "maintainer"` goes through `mutate` in `scripts/lib/actions.mjs` like any other write, so it runs under the account of the current mode. When a rule says no, it sets `ctx.skipped` and sends nothing. `runAction` returns that reason as `skipped`.
- With `escalateAs: "me"` in the instance config, the escalate button of a `move` to `issue` route posts the profile's `botCommands.escalate` on the discussion under his stored login. `postEscalateCommand` in `scripts/lib/gh.mjs` reads the command from the profile, checks the login and the open discussion, and sends one `addDiscussionComment` mutation. Only `handleEscalate` in `server/server.mjs` calls it, and `test/sharing.test.zsh` checks that. With a bot configured, these two helpers are the only way to his login.
- No text the bot posts may contain a command from the profile's `botCommands`. `escalate` is no entry of `ACTIONS`, so `gary action` and the MCP server cannot post it.

## MCP server

The stdio server `gary` has one tool per GitHub action and three tools for the board server. In a plugin install Claude Code starts it from the `mcpServers` entry in `.claude-plugin/plugin.json`. For a clone, `setup` prints the `claude mcp add` command.

- `board_start` starts the board server inside this MCP process and returns its URL. When another process already serves the board, it returns `{ "running": true, "owner": false, "url": … }`. Calling it again is safe.
- `board_stop` stops the board server if this MCP process started it.
- `board_status` returns the URL, whether this process runs the board server, whether the port answers like the board, and the instances it serves.

The master triage session calls `board_start` at the start of every run. Other sessions never start it on their own.

## Board server

```sh
node server/server.mjs              # start the board without a Claude session
node server/server.mjs --dry-run    # nothing is written to GitHub
node server/server.mjs --watch      # restart on edits in server/ and scripts/lib/
```

It listens on `127.0.0.1` at the `port` from the root `config.json`, for all instances. `GARY_DRY_RUN=1` turns on dry-run mode for the MCP server too. `--port` and `--board-dir` override the port and the data directory for tests.

`GET /api/state` returns `board` next to the items: the project `name`, `repo` and `repoUrl`, `me` and `bot` with login and avatar URL (`bot` is `null` without one), `accountMode` (`bot`, `own` or `none`), `relatedRepos`, `botCommands`, `escalateAs` (`prefill` or `me`), `reviewBots` and `paused`. The page gets the same object from `window.claude.use("board")`. Every served route carries `actor`, who acts after a click: `me`, `bot`, `own`, `agent` or `unavailable`. A move to a repository carries `actors` with one entry per button.

Edits reach open pages without a manual reload. When `board/board.html` changes, the server tells open pages to reload. A page with an open dialog or typed text waits and shows "Updated, reload" instead. After `board_start`, the MCP server watches `server/server.mjs` and `scripts/lib/*.mjs` and restarts the board server with the new code. When the new code fails to load, the old server keeps running.

The server can write to GitHub, so it locks itself down:

- On the first start it writes a random token to `<root>/state/server-token` with mode 600. The page gets the token inline. Every `/api` request must send it, except `GET /api/health`.
- It rejects any `Origin` other than its own and any `Host` other than `127.0.0.1:<port>` or `localhost:<port>`.
- It accepts only JSON bodies up to 256 KB and sends no CORS headers. It serves nothing besides the board page.
- The page runs under a strict Content-Security-Policy. Images may come only from GitHub, for the avatars.
- GitHub actions run one at a time per item, so a double click cannot run twice. Writes run one at a time per file.

## What a click can run

The page cannot send an arbitrary action. A click sends `{ itemId, routeId, text, draftHash, force, input }` to `/api/action`. The server reads the route from `state/board/items/<id>.json` and takes its type, actor, params and the target from there. `input` carries only what the maintainer chose on the card, like the checked review comments, the decision per review thread, the mode of a move or the rounds of a drive. The server checks every id and value in it.

- The draft hash covers the route's stored text, its params and the item's `reviewedAt`. When the routine rewrote the route after the page showed it, the server answers "The board is out of date, reload it."
- A route that already ran or was queued with the same draft is refused with 409.
- A route whose actor is `me` never reaches GitHub through the server: the page copies its text and opens the thread, and the maintainer acts there. That covers replies to people, every close and every merge. The one close the server runs is a `move` with `input.mode: "close"`, which posts the route's text and closes as not planned. The one comment the server posts in his name is the escalate command: a `move` to `issue` with `input.mode: "escalate"`, only with `escalateAs: "me"`. The spec's "Escalate" section lists its checks.
- A bot route runs after the click as the bot, or under the maintainer's login in `own` mode. An `unavailable` route is refused.
- An agent route writes a queued action doc. `drive` and `address_review` are refused unless the PR is by a maintainer, a bot or Copilot, or carries `takenOver: true`. Pushing our commits to a contributor's PR is always a take-over, so a `take_over` route carries the per-thread decisions there. `take_over` is refused on every PR where `drive` is allowed. A change to such a PR is a `revise` route: the agent follows the route's text, which the maintainer can edit on the "Change" card, and pushes to the PR branch. A stored `take_over` with mode `push` on such a PR is served and run as `revise` (`servedRoute` in `scripts/lib/routes.mjs`), so the board is right before the next triage rewrites the item.
- On a PR whose snapshot entry lists `sensitiveFiles`, `address_review`, `drive`, `format` and the checkout forms of `take_over` and `revise` are refused (`sensitiveRefusal` in `scripts/lib/routes.mjs`). A `take_over` or `revise` with `params.via: "api"` is an API edit: its actor is the bot, the server runs it on the click through `runApiEdit` in `scripts/lib/api-edit.mjs`, and no agent is queued. It commits the route's `params.edits` with one `createCommitOnBranch` mutation that expects the reviewed head, comments on the PR, sets `pushed` and `takenOver` on the item and queues a `full_review` with `params.by: "api_edit"`. The spec's "API edit" section lists the limits and why they are checked in code.
- A PR whose entry has `sensitiveFiles` and `sensitiveOurs` is ours alone. Its head branch is in the repo. The bot or `me` opened it and authored and committed every commit. A PR by the bot is in `fixes.json`. `oursAlone` in `scripts/lib/facts.mjs` decides it from the PR's GraphQL node. The spec's "PRs that are ours alone" lists the conditions. `sensitiveRefusal` then refuses nothing. The validator refuses the API form there. Validator and server read both fields from the stored snapshot through `touchesSensitive` and `sensitiveOurs`.
- `dismiss_route` removes one suggested route and remembers it with the reason. When it was the last route, a `reanalyze` request is queued so the agent proposes something else.
- Before a route that posts text, reviews, closes, reopens or transfers, the server reads the thread from GitHub. It refuses when the thread is in the wrong state, when a person commented or reviewed after `reviewedAt`, or when the PR head differs from `reviewedSha`. Bots do not count. "Post anyway" sends the click again past that check after a second confirm. A moved head still blocks an approval and a review with inline comments. The code is in `scripts/lib/guard.mjs`.
- The server writes one action doc per bot or agent click with `routeId`, `route`, `draftHash`, `edited`, the action it ran and the result.

## Pause

The switch is `paused: true` in `<state>/control.json`, read fresh on every check, so it needs no restart. While paused:

- The board server refuses every click that writes to GitHub before any GitHub read, writes no action doc, and answers `{ ok: false, result: "Gary is paused. Nothing was sent.", paused: true }`.
- `gary action` and the MCP tools refuse the same way, also with `--dry-run` and `--autonomous`.
- Agent requests still queue, but `gary watch-queue` prints nothing. They start after `gary resume`.
- Snoozing, hiding, dismissing a route and deciding proposals keep working.

Pause is per instance: `board.instances[].paused` is in `/api/state` and in `use("board")`. A change sends a `board` SSE event, and the page shim dispatches `board:info`. `gary doctor` reports the switch.

## Blocked items

When a safety filter stopped the agent, or its analysis failed three times, the item carries `blocked: { reason: "safety_filter" | "failed", at }` and exactly one route of type `open`: `as: "me"`, no text, no params. The click opens the thread on GitHub. The next full triage drops `blocked`, which happens only after "Analyze again".

## Intent that outlives a run

An item doc may carry `wants: { labels: { add: [], remove: [] }, assignees: [] }` with a one-sentence `wantsReason`. The classification writes it. Every hourly run compares it with the item's current labels and assignees in the snapshot and attempts what is missing with `gary action --autonomous`, whether or not the item changed. Every hourly run also considers all stored items with a `follow_up` route as agent and no `Draft fix` link, up to `maxAutoFixesPerRun`. While paused, both go into `runs/<run>/would-have.json` as `[{ itemId, action, params, reason }]`, and after `gary resume` the next run attempts them again from the current state.

`meta.json` carries `rulesHash`, a hash over the rule files the routine read. When it changes, the routine re-classifies every quick item and queues the full ones for review within the normal budget, tracked in `rulesPending`.

## Facts and tiers

Every snapshot entry carries `facts`, computed in code:

- `timeline: [{ at, author, side, kind }]`, oldest first, the newest 200 events kept. `side` is `us`, `them`, `automated` or `bot`. `kind` is `opened`, `comment`, `reply`, `review` or `thread_comment`. `timelineTruncated` is set only when events are missing.
- `lastSpeaker`, `lastUsAt`, `lastThemAt`, `waitingOn` (`us`, `them` or `nobody`, decided only by `us` and `them` events), `waitingDays`.
- PRs: `ciGreen`, `dependencyOnly`, `touchesSensitive`, `sensitiveFiles` (the first 5 paths that match the profile's `sensitivePaths`) with `sensitiveFileCount`, `sensitiveOurs` (true on a PR with sensitive files that is ours alone) or `sensitiveNotOurs` (the condition that failed), `openThreadCount`, `approvedBy`, `changesRequestedBy`, `isClean`.
- Issues and discussions: `hasClosingPr` (an open or merged PR), `isAnswered`, `authorIsUs`. Discussions also carry `category`, the category's name.

The server reads two things for the page from the snapshot, with `sensitiveFacts` and the entry's `category`: a PR's `sensitive: { files, total, ours }` for the warning in the dialog, and the `category` of a discussion whose item has none yet. The routine copies `category` into the item like `isAnswered`.

The classification rules take these as given. The profile's `automatedComments` decides which bot comments are `automated`. Its entries are `{ name, pattern, origin? }`, where `pattern` is a regex without flags, tested against the start of the comment body.

Quick classification has two tiers, set by `fastTier` (`off`, `shadow` or `on`, default `off`) in the instance config. The fast tier settles only cases the facts decide and hands up everything else. The standard tier does the rest. Their models are `models.fast` and `models.standard`, by default Haiku and Sonnet. With `shadow`, both run, only the standard result is stored, and `gary shadow record <file>` keeps both tiers' entries per item. A file holds one entry or a list: `{ at, run, itemId, repo, tier: "fast"|"standard", model, section, hasRoutes, recommendedType, handedUp, reason }`. `section` and `recommendedType` may be `null` only when the fast tier handed up. `gary shadow report [--since <ISO>] [--json]` compares them. `gary shadow propose`, run by `triage-learn`, proposes `on` once 40 pairs show at least 95 percent section agreement.

Every item doc carries `classifiedBy` (`fast`, `standard` or `full`), and every decision log entry carries it too, so `gary shadow report` can show "Your decisions by tier". `--week` limits the report to the last 7 days. In `on` mode the routine samples 1 in 10 of the fast tier's own decisions, at least 1 per run, and runs the standard tier on them as well. Both entries are recorded with `sampled: true`. The fast result stays unless the two disagree on the section or the recommended route type, in which case the standard result is stored. `gary shadow propose` proposes switching back to `shadow` when agreement on the last 40 pairs drops below 95 percent, or when the maintainer's override rate on fast-tier items is at least 10 percentage points above the one on standard items.

`gary wants --json` lists per item the labels to add or remove and the assignees to add that the staged snapshot does not show yet, with the reason, and `unknown` for items without a snapshot entry. The routine attempts those changes every run. Assignees are only added.

Unknown fields in an instance config or a profile are warnings at run time. `gary doctor` and `gary setup` refuse them. `gary instances --json` reports `valid`, `settingsError` and `settingsWarnings` per instance, and the master skips an instance with `valid: false`.

`autofix.changes` is true exactly when `autofix.files` is above 0. The server does not check that a PR is still open when `format` is clicked. The format mode refuses a closed PR and a moved head itself.

## Format check and the format route

Gary never reviews style. A full PR review runs the project's formatter and lint autofix on the PR's changed files in a throwaway worktree of the base branch, with the tools and configs of the instance's checkout, and stores the result as `autofix: { changes, files, lines, tools }`. The board shows it as a badge. The agent route `format` (title `Format: fix formatting and lint`) applies exactly that result to the PR's branch as one bot commit, on files the PR already changed. It is no take-over: it sets no `takenOver` and unlocks neither `drive` nor `address_review`. It refuses when the head moved since `reviewedSha` or the result would touch other files, and it never resolves conflicts. The profile's `rules/review.md` names the commands, the CI jobs that fail on formatting, and the commit message.

## Labels on replies

`reply` and `request_logs` routes may carry `params.alsoLabel: { add: [], remove: [] }`, with labels from the profile's `autoLabels`. A route that asks the reporter for something adds the profile's waiting label, and a reply after the reporter delivered removes it. On a prefill reply the board shows a second button with the bot's avatar that sets the labels. On a bot route the labels go out with the post, behind a checkbox that is on by default. `wants` remains the fallback, so a reply posted without the button still gets the label in the next run, and the two never contradict each other.

## Claims

`gary claim <itemId> <kind> --run <run> [--ttl <minutes>] [--request <action doc id>]` (kinds `fix`, `review`, `push`) marks an item as worked on by one run. It exits with 3 when someone else holds the claim. Without `--request`, a `fix` claim is also refused while another `start_fix` request is queued or a fix PR is in draft or open. Every worker releases its claims on every exit path and sets its action doc to `done` or `failed`, because queued or claimed docs do not expire. The master marks the jobs of dead workers as failed and releases their claims. `gary release` frees it, and `gary claims` lists the current ones. Every fix, full review or triage, take-over, revise, address_review, drive round and format claims its item first and releases it at the end, also on failure. An autonomous fix reads the queue right before it starts and before it opens a PR, and gives way to a `start_fix` request for the same item.

## Answers when closing discussions

A `close` route on a discussion with `facts.answerable` and no `facts.answerChosen` carries `alsoAnswer: { commentId, url, gist }` for the comment that best answers the question. Without such a comment, the closing message states the answer.

## AI-written PRs and backlog

`facts.aiAuthored`, `facts.aiSignals`, `facts.changedLines` and `facts.changedFiles` describe AI-written PRs. The fast tier never decides them, and his reading time comes from the changed lines by the table in `item-doc.md`. Issues and discussions by the bot or an agent that describe doable work get one `Implement:` card. Small, clear work goes to `easy`, and large work or work that needs a design decision goes to `deferred`. Within a section, outside contributors and reporters come first, then the maintainer's items and bot or agent items as one group. Autonomous fixes take only `Start fix:` cards.

## Handled items

The server sets the maintainer field `handled: { at, routeId, routeType, verified }` when he used a prefill button or a bot or agent route ran, and the board hides the item until the next run. `gary handled --json` lists such items. Early in every hourly run, after the snapshot, the routine clears `handled` with `gary put --merge items <id>` and `{ "handled": null }` when the thread changed on GitHub after `handled.at`, and classifies the item again. When nothing changed and `handled.at` is more than 30 minutes old, it clears `handled`, keeps the routes and prepends a `question` finding that he opened the thread but nothing changed there. A younger mark, or an agent job still queued or claimed, keeps `handled`.

## Routes after a push

Every pushing mode returns routes for the new head only: routes written before the push are dropped, `reviewedSha` is the new head, and a failed or refused job returns the previous doc unchanged after releasing its claim.

## Fix state

The code keeps `fix: { state, pr, startedBy, since }` per issue and discussion, with `state` `working`, `draft`, `open`, `merged` or `closed`. `gary fixes --json` lists it. The fix flow calls `gary fix-record <itemId> --pr <n> --branch <name> --run <run> --by routine|maintainer` right after `gh pr create`, and checks `gary fixes` before it creates the branch and before it opens the PR. The PR's own item carries `fixFor: { itemId, ref }`. The validator and the server refuse a `follow_up` route as agent while the state is `working`, `draft` or `open`, and every hourly run removes such stored routes. Gary's own draft fix PR is the one draft that becomes a board item, once its CI finished. A merged fix leads to a close card on the source item, and a closed unmerged fix allows a new one.

While the state is `working`, `draft` or `open`, the fix carries `parked: true` (`parksItem` in `scripts/lib/fixes.mjs`) and the board keeps the issue or discussion out of the plan, in the line "Has a fix in progress". The server computes this from the fix state when it serves the items, so it holds for stored items without a new triage. The item returns when the fix PR is merged or closed, or when the other side wrote after the fix PR was recorded: the snapshot entry's `lastThemAt` is later than the fix's `since`.

A fix PR Gary recorded gets review rounds without a click, as a drive with `by: "fix"`. `gary fix-review start` requests the first review and writes the waiting drive. `gary watch-queue` polls every waiting drive once a minute and prints a `review-arrived` or `review-timeout` line, on which the master starts the next round. `gary fix-review finish` marks the PR ready after a `done` drive and queues the `full_review` that puts the PR on the board. The fix state carries `review: { reviewer, round, maxRounds }` while the rounds run. `scripts/fix-review.mjs` holds both commands, and both refuse a PR that is not in `fixes.json`.

The PRs we control stay watched after the review bot rounds, until they are merged or closed: every open PR by the instance's bot, the fix PRs among them, and every PR whose item has `takenOver: true`. `watchedPrs` in `scripts/lib/watch.mjs` lists them from `fixes.json`, the snapshot, the board items and the drive files. A drive file in the stage `watch` waits only for his feedback, so the server serves no `working` and blocks no click for it. The master turns the watcher's `maintainer-feedback` line into a queued `drive` request with `gary pr-watch round --by me`, and the hourly run does the same for other people's feedback with `--by others`. `seenAt: { me, others }` in the drive file, our last commit time from the snapshot's `feedback` and the item's `pushed.at` decide which feedback a round already handled, so feedback from before the watcher existed still starts one round. `gary pr-watch review` requests the next review bot round and refuses beyond 3 per PR over its life, counting both `copilotRounds` and the bot's reviews on GitHub. `gary fix-review finish` and `gary pr-watch done` put the file back into the stage `watch`. With `--request-maintainer` they then call `requestMaintainerReview` in `scripts/lib/watch.mjs`, which runs `request_review` with `reviewer: "maintainer"` and turns the outcome into the `maintainerReview` field of their output. The drive skill passes the flag on every clean end of a round.

`maxPendingAutoFixes` limits the pending fixes the routine started itself. `pendingAutoFixes` in `scripts/lib/fixes.mjs` counts them, and `gary claim <itemId> fix` without `--request` refuses at the limit after it took the claim.

## State layout

Everything under the instance's `state/` (`<home>/state/`):

```
board/items/<id>.json       item docs
board/actions/<id>.json     action docs, incl. queued agent requests
board/proposals/<id>.json   rule and setting proposals
board/meta.json             run status
control.json                the pause switch
decisions.jsonl             the decision log
learn.json                  the learning cursor
opened.json                 the prefill buttons he used, per item and route
failures.json               failed analyses per item
drive/<itemId>.json         waiting drives and watched PRs
runs/<run>/would-have.json  what a paused run would have done
snapshot.json, snapshot.pending.json, logs
```

## Learning

The board server logs where the maintainer deviates from the agent's proposals in `state/decisions.jsonl`: a dismissed route, another route than the recommended one, an edited text, a thread decision against the agent's verdict, an unchecked review comment, a rewritten review comment, a note to the agent, a snooze. Routes he does on GitHub himself are reported by the page to `/api/decision`. It writes that local log entry and keeps the click in `state/opened.json`, so the card still says "Copied and opened on GitHub" after a reload or a click on another card.

The `triage-learn` skill reads new entries with `gary decisions --since <ISO>`, writes rule proposals with `gary put proposals <id> <file>` and its cursor with `gary put learn <file>`. The board shows open proposals. Accepting one appends the rule under its heading in the profile's `rules/` or `templates/`, or in the home's `personal.md`, and commits that file when the profile is a git repository. It never pushes. Dismissing one stores the reason and logs it, so the pattern is not proposed again. Both work in dry-run mode, because they change only local files. `gary proposals` lists every proposal with its status.

A setting proposal (`kind: "setting"`) changes one value in the instance's `config.json`. The only one today is `fastTier`, to `on` or back to `shadow`. `gary shadow propose` writes it from the shadow report, with numbers and no prose: `stats` and `differences`. The board builds the card's sentences from them in `settingParagraphs` and `differenceLine` (`board/board.html`), in plain words: "faster model", "standard model", "passed on", "kind of card", "board section". Accepting it runs `applySetting` (`scripts/lib/learning.mjs`): validate the proposal against the allow-list `PROPOSAL_SETTINGS`, set the key, check the resulting config with `checkConfig`, write atomically with the file's indentation. The config loader notices the changed file on its next read. The server logs `accepted_proposal`. `gary shadow convert <id>` rebuilds a fast tier proposal that an older version stored as a rule proposal.

## Tests

```sh
npm test            # actions, server, accounts, learning, sharing, validate, api-edit, ours. Needs node and zsh
npm run test:page   # the board page, mocked and served. Needs Chrome or Chromium
```

The suites run offline. `test/fake-gh/gh` stands in for the `gh` binary on PATH, answers Gary's reads from `test/fixtures/github.mjs` and refuses every write. With `FAKE_GH_WRITES` it accepts a short list of mutations and logs them to that file, which is how `test/api-edit.test.mjs` checks the commit of an API edit without GitHub. Each suite makes its own temp home with the fixture profile `test/fixtures/profile` (the project `acme/widgets`) and picks free ports, so they never touch a real home or a running board. `CHROME` names the browser binary for the page suites, default `google-chrome`. Avatars from github.com may fail to load offline, and the page suites accept the letter placeholder then.
