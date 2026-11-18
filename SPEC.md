# Gary: contract

Gary is maintainer triage for one GitHub repository. An hourly Claude routine reviews the open PRs, issues and discussions. It writes one briefing per item as a JSON file into a local store. A local Node.js server serves the board page from that store. The maintainer reads the board and clicks buttons. A click is the maintainer's approval. Only approved actions change anything public on GitHub, with the exceptions listed under Autonomy.

The examples below use the project `acme/widgets`, the maintainer `octocat` and the bot `widgets-bot`.

## Decisions

- **Runtime**: one master Claude session per machine. An hourly scheduled task posts `Run the triage-master skill.` into it. The master owns the one board server and the one queue watcher, and starts one worker per instance for the hourly triage and one per agent request. Workers report only through the instance's state directory. Classification, reviews, triage and fixes run in workers or subagents, so the master's context stays small across runs.
- **Identity**: see Accounts. Gary's code reads the bot token from `bot.tokenFile` and sets `GH_TOKEN` itself. It never depends on a `gh` shell function or alias.
- **Scope**: all open PRs that are not drafts. Draft PRs are ignored entirely. Issues and discussions with activity in the last `activeWindowDays` days. Older ones appear only as a count.
- **Author tags**: `maintainer` (the profile's `maintainers` and `me`), `bot` (the profile's `botLogins`, the configured bot and every GitHub App), `copilot` (GitHub's Copilot coding agent), `contributor` (everyone else). All are included and filterable.
- **Review depth**: tiered. Every changed item gets a quick classification. Contributor PRs and active issues get a full review. The profile's `rules/review.md` names the project's own review skills and tools.
- **Budget per run**: at most `maxFullReviewsPerRun` full reviews and `maxAutoFixesPerRun` auto-fix attempts. Remaining changed items get `reviewDepth: "pending"`.
- **Autonomy without a click**: add and remove the labels in the profile's `autoLabels`, assign, and open draft fix PRs with a reproducing test where the project's `rules/issues.md` allows it. Everything else needs a click. The routine passes `--autonomous` to `gary action` for every label and assign change nobody clicked, and the code then refuses labels outside `autoLabels` and every other action.
- **Board server**: one `server/server.mjs` per machine serves every instance on `127.0.0.1` at the `port` from the root `config.json`. It runs inside the `gary` MCP server of the master session, which starts it with `board_start`, or standalone with `gary serve`. Other sessions leave it alone. It watches every instance's board store, picks up new instances without a restart and pushes changes to the open page.
- **Buttons**: a click on a bot route makes the server run it live through `scripts/lib/actions.mjs`. When GitHub cannot be reached, the action fails, the board shows the error, and the maintainer can click again. Agent requests are always queued.
- **Confirmation**: merge, close and any posting of public text need a second confirm click on the board.
- **Suggested text**: an editable textarea. The button posts the textarea content.
- **Project tools**: tools a project needs, like a log analyzer, are listed in the profile's `requiredTools`. The routine checks them at the start of a run.

## Layout

Gary has three layers, one place for each kind of change.

```
<core>/                  the tool itself. Nobody edits it to adapt the tool
  .claude-plugin/        plugin.json and marketplace.json, so the repository is its own marketplace
  .mcp.json              the gary MCP server for a plugin install
  package.json           dependencies of the MCP server, with a lockfile
  bin/gary               the launcher, the one entry point for every command
  scripts/               Node ESM, no build step
    snapshot.mjs         gary snapshot
    board-put.mjs        gary put
    execute-action.mjs   gary action
    watch-queue.mjs      gary watch-queue
    setup.mjs            gary setup
    migrate.mjs          gary migrate
    serve.mjs            gary serve
    doctor.mjs           gary doctor
    lib/                 paths and settings, gh wrapper, actions, freshness guard, board store
  mcp-server/index.mjs   stdio MCP server "gary"
  server/server.mjs      board server: serves the page, runs clicked routes, watches the board store
  board/board.html       the board page
  skills/                triage-master, triage-routine, triage-review-pr, triage-issue, triage-setup, triage-learn
  profiles/template/     the skeleton `gary setup` copies for a new project

<root>/                  $GARY_HOME, default ~/.config/gary/. Survives updates, nothing in it is shared
  config.json            the server-wide settings: { "port": 7878 }
  personal.md            the maintainer's own rules for every instance
  state/                 server-wide files: server-token, server.log
  instances/<name>/      one instance per repository. The name matches ^[a-z0-9][a-z0-9-]{0,39}$
<home>/                  one instance directory, <root>/instances/<name>/
  config.json            the instance's settings
  personal.md            optional: rules for this instance only, read after the shared one
  state/                 board store, snapshots, runs, drives, worktrees
    board/               items/<id>.json, actions/<id>.json, proposals/<id>.json, meta.json
    control.json         the pause switch, see Pause
    decisions.jsonl      the decision log, see Learning
    learn.json           the learning cursor
    failures.json        failed triage count per item, kept by the routine
    runs/<run>/          one directory per worker run, named by its UTC timestamp, which the master picks. summary.txt is the
                         worker's result, would-have.json the writes a paused run intended
    drive/<itemId>.json  a waiting drive: its round state plus repo and number, so the master can arm its monitor

<profile>/               one directory per project, named by `profile` in config.json. A team can share it
  profile.json           facts the code needs
  rules/                 classification.md, voice.md, review.md, issues.md
  templates/             canned texts, like request-logs.md and reopen-elsewhere.md
```

The core contains no repo name, no account name and no absolute path. It works as a Claude Code plugin and from a plain git clone. In a plugin install Claude Code puts `bin/` on the Bash PATH and starts the MCP server from `.mcp.json`. For a clone, `gary setup` links the skills into `~/.claude/skills`, links the launcher into `~/.local/bin` and registers the MCP server with `claude mcp add --scope user gary`.

### config.json

```jsonc
{
  "kind": "maintainer",            // the only kind today. A maintainer instance triages the one repo of its profile
  "profile": "~/repositories/gary-profile-widgets",   // directory of the project profile. Relative paths are relative to the instance directory
  "me": "octocat",                 // the maintainer's GitHub login
  "checkout": "~/repositories/widgets",   // local clone of the repo. Worktrees for fixes go under state/worktrees/
  "bot": { "login": "widgets-bot", "tokenFile": "~/.config/widgets-bot/gh-token" },   // or null
  "allowOwnTokenPushes": false,    // without a bot: may agents push and post with the maintainer's own gh login
  "activeWindowDays": 30,
  "activeMaxWaitDays": 14,
  "maxFullReviewsPerRun": 10,
  "maxAutoFixesPerRun": 2
}
```

`profile` and `me` are required. The other fields have the defaults shown. Unknown fields are errors. A `port` in an instance config is an error that asks for `gary migrate`: the port lives in the root config.

Code looks up an instance through `loadInstance(name)`. Its allowed repos are the profile's one `repo`, and `allowedRepo(instance, repo)`, `checkoutFor(instance, repo)` and `rulesFor(instance, repo, topic)` answer per repo. For `maintainer` they return the configured checkout and the profile's `rules/<topic>.md`. The skills read that file directly.

### profile.json

```jsonc
{
  "name": "widgets",               // board title: "<name> triage"
  "repo": "acme/widgets",
  "maintainers": ["octocat"],      // logins that count as maintainers, besides `me`
  "botLogins": ["widgets-bot"],    // accounts shown as bot, besides GitHub Apps and the configured bot
  "reviewBots": ["copilot"],       // review bots a drive may request. Only "copilot" is supported
  "relatedRepos": ["widgets-desktop"],   // targets of `move`, repositories of the same owner
  "sensitivePaths": [".github/**", "**/package.json"],   // globs. A PR that touches one carries `sensitiveFiles`
  "autoLabels": ["needs-info"],    // labels the routine may set without a click
  "botCommands": { "escalate": "@widgets-bot escalate" },   // commands the maintainer posts himself. No bot-posted text may contain any of them. Only `escalate` has a route
  "requiredTools": ["mcp__widgets-logs__loadLogFile"]   // checked at the start of a run
}
```

`name` and `repo` are required. Unknown fields are errors.

Reading order for every rule: the core reference, then the profile's file of the same topic, then the shared `<root>/personal.md`, then the instance's `personal.md` when it exists. A later file overrides an earlier one. The hard limits in the core skills cannot be overridden.

## Instances

Several instances can live on one machine, one per repository, each with its own config and state. One board server serves them all. Every command except `serve`, `migrate`, `instances`, `paths --root` and the `--all` forms acts on one instance, resolved in this order:

1. `--instance <name>`, before or after the command, like `gary --instance widgets snapshot`,
2. the environment variable `GARY_INSTANCE`,
3. the working directory: it lies inside an instance's `checkout` (compared by real path), it is a git worktree of that checkout (same `git rev-parse --git-common-dir`), or its git `origin` remote is the instance's `repo` (https or ssh form, case does not matter),
4. the only instance, when exactly one exists.

Otherwise the command fails and lists the instances with the hint to pass `--instance`. It never falls back silently. Two matching instances fail the same way.

Commands that change something name the instance in the first line on stderr: `Instance <name>.` for `snapshot`, `put` and `action`, `Paused <name>.` and `Resumed <name>.`, `Created instance <name>.` or `Updated instance <name>.` for `setup`.

The board server serves every instance and resolves none. `/api/health` answers `{ ok: true, name: "gary", instances: [...] }`. The MCP server resolves the instance of the session's working directory once, for its action tools, which act on that instance and return the resolution error when there is none. `board_start` and `board_status` work from any directory: `board_start` starts or finds the one server, and `board_status` returns `{ url, owner, portAnswers, instances, sessionInstance }`.

Two older layouts are moved by commands, never silently:

- The layout from before instances had an instance's `config.json` and `state/` directly in the root. Only `gary setup` moves it, into `instances/<name>/` named after the repository. Every other command fails with a one-line hint to run `gary setup`.
- The layout of one server per instance had a `port` in each instance config, a `server-token` in each instance state and items without `repo`. `gary migrate` moves it, and `gary setup` runs it too. It sets `kind`, moves the first port it finds into the root config (an existing root port is kept), adds the instance's repo to every stored item without one, and moves the first `server-token` to `<root>/state/` and removes the others. A second run changes nothing.

## Launcher

`gary [--instance <name>] <command>` runs every command the skills and the maintainer need. Skills never use a path into the core.

- `gary snapshot`, `gary snapshot --commit`: see Snapshot.
- `gary item <id>`, `gary item <pr|issue|discussion> <number> [--repo <owner/name>]`: print the fresh snapshot entry of one item, read from GitHub with the same fields as the snapshot. With an id, kind, number and repo come from the stored item doc. The repo must be one of the instance's. It writes no state.
- `gary put items <id> <file>`, `gary put --merge items <id> <file>`, `gary put items <id> --delete`, `gary put meta <file>`: write one board document through the board server, or directly when it does not run. Without `--merge` the file is the complete item and replaces the stored one. Only the maintainer's `hidden` and `snoozedUntil` carry over, and `priority` when the file has none. With `--merge` only the fields in the file change, and `null` removes a field. Both modes validate the resulting item, see Validation. A merge that touches none of `routes`, `threads`, `hint` and `findings` is not validated. `--no-validate` skips the check, for migrations.
- `gary validate [<id> ...] [--json]`: run the same validation over the stored items, read-only. Without ids it checks all of them and groups the problems.
- `gary action [--dry-run] [--check-fresh] [--autonomous] [file]`: run one GitHub action from a JSON file or stdin. `--autonomous` marks an action nobody clicked: only `label` within `autoLabels` and `assign` may run.
- `gary watch-queue [--all] [--once]`: print queued agent requests as JSON lines, `{ "instance", "id", "itemId", "action" }`. `--all` follows every instance, also ones added later, and is what the master runs.
- `gary serve [--watch] [--dry-run]`: run the one board server in the foreground.
- `gary migrate`: move instances to the single-server layout, see Instances. Safe to run again.
- `gary pause [--all]`, `gary resume [--all]`: set and clear the pause switch of the instance, or of every instance, see Pause.
- `gary instances [--json]`: list every instance with `name`, `kind`, `repos`, `title`, `checkout`, `paused`, `served` (the board server lists it) and `current` (the working directory resolves to it).
- `gary decisions [--since <ISO>] [--json]`: print the decision log, see Learning. `--since` is exclusive.
- `gary proposals [--json]`: list every rule proposal with its status and dismissal reason.
- `gary put proposals <id> <file>`: write one rule proposal, validated. `gary put learn <file>`: write the learn cursor.
- `gary paths`: print JSON with the keys `instance`, `root`, `home` (the instance directory), `config`, `personal` (a list, the shared file first), `profile`, `state`, `checkout` and `core`. Without a resolvable instance it still prints `core` and `root`, adds `error` and exits with 2. `gary paths --root` prints only `core` and `root` and works from any directory.
- `gary setup`: create an instance with `config.json` and `state/`, and the shared `personal.md` when it is missing. It asks in a terminal and takes flags in a script: `--instance` (default the repository name in lower case), `--repo`, `--me`, `--checkout`, `--profile`, `--name`, `--bot-login`, `--bot-token-file`, `--no-bot`, `--port`, `--force`, `--no-links`, `--register-mcp`. It runs `gary migrate` first. `--port` sets the one server's port in the root config. It refuses a second instance for the same repository or checkout. A new project gets a profile copied from `profiles/template/` into `<root>/profiles/`. It never replaces an existing `config.json` without `--force` and never touches an existing `personal.md`.
- `gary doctor [--all]`: read-only checks of the resolved instance, or of every instance: Node, `gh`, the stored `gh` login against `me`, the bot token against `bot.login`, the profile, the checkout, the pause, the root port and whether the board server there lists this instance, the skill links and the launcher.

Environment: `GARY_HOME` moves the root, and `GARY_INSTANCE` picks the instance. `GARY_DRY_RUN=1` makes the board server and the MCP server run without GitHub writes. `GARY_GUARD_STUB` replaces the freshness read in tests.

## Accounts

`me` is the maintainer's GitHub login. `gh` acts for him with the login stored by `gh auth login`. `bot` is a second account with its own token, or `null`. The account mode follows from the config:

- `bot`: a bot is configured. Every GitHub write of Gary's code runs as the bot.
- `own`: no bot, `allowOwnTokenPushes: true`. Bot routes without a prefill run under the maintainer's stored login after a check that this login is `me`.
- `none`: no bot, `allowOwnTokenPushes: false`. Gary's code writes nothing to GitHub, except `request_review`.

Rules:

- Without a bot, every route that would run as the bot becomes prefill for the maintainer where a prefill exists: reply, request_logs, reopen, a follow-up issue, a review body, the close of a move. Routes without a prefill (inline review comments, transfer, chores) are offered only in `own` mode, and the card shows his avatar.
- Agent routes that push (`address_review`, `take_over`, `drive`, a fix) need the `bot` or `own` mode. Otherwise the routine does not offer them and the server refuses them.
- `request_review` with `reviewer: "copilot"` runs under the maintainer's login in every mode, after the check that the login is `me`. With a bot configured, this is the only way any code reaches his login: the helper in `scripts/lib/gh.mjs` sends only that one mutation.
- No text the bot posts may contain a command from `botCommands`.

## Pause

`gary pause` stops every write to GitHub of one instance at once while the board stays up, `gary pause --all` of every instance. It sets `paused: true` in the instance's `<state>/control.json`, and `gary resume` sets it to `false`. The file lives outside `config.json`, so a change needs no restart, and every check reads it fresh.

While paused:

- the server refuses every click that would write to GitHub with `{ ok: false, result: "Gary is paused. Nothing was sent.", paused: true }`, and writes no action doc,
- `gary action` refuses every action with the same result, also with `--dry-run` and `--autonomous`,
- agent routes are still queued, but `gary watch-queue` and `gary watch-queue --all` print nothing of that instance, so the master session starts nothing for it. The requests appear when the pause ends,
- board-only actions keep working: dismiss, snooze, `dismiss_route`, `accept_proposal`, `dismiss_proposal` and `/api/decision`.

`board.instances[].paused` in `/api/state` and in `use("board")` shows the switch per instance. The event stream sends a `board` event with the full board object when a `control.json` changes. `gary doctor` reports the state.

## Sections

Board order, top to bottom. `section` field values in parentheses.

1. Active communication (`active`): someone asked us something within the last `activeMaxWaitDays` days and waits for a reply. An older unanswered question is no longer a live conversation. It is classified by the other rules and keeps a `waitingDays` value.
2. Easy wins (`easy`): PRs ready to merge, questions that can be answered or closed now.
3. Almost ready (`almost`): PRs that need small refinement, items that only need a maintainer decision.
4. Needs human review (`review`): PRs where the agent review is done and a human must look at the code.
5. Deferred and larger projects (`deferred`).
6. Needs real hardware (`hardware`): cannot be reproduced with the project's test setup.

## Who acts

Every route has an actor in `as`.

- `"me"`: the maintainer acts on GitHub under his own account. The board never does it for him. The button copies the route's text and opens the right GitHub page. He pastes and presses the final button there. This covers replies to people, every close and merge, also when they carry a comment.
- `"bot"`: the server executes the route after the click, as the bot or, in `own` mode, under his login. See Accounts.
- `"agent"`: the click queues a request. The master session picks it up within seconds and an agent does the work. What it pushes or posts goes out as the bot.

The server serves every route with `actor`, who acts after a click in the current account mode: `me`, `bot`, `own`, `agent` or `unavailable`. A move to a repository carries `actors` with one entry per button.

## Routes

A route is one way to resolve an item. The agent builds each dialog from typed route cards. It picks which cards appear, their order and their content. The page controls the look. The server controls what a click may do.

```jsonc
{
  "id": "r1",
  "type": "close",                 // see the table
  "title": "Close: fixed in 2.3.1",   // at most 60 characters, same format as `hint`
  "why": "One sentence on when to pick this route.",   // optional
  "as": "me",                      // me | bot | agent. Must be allowed for the type
  "params": {},
  "text": "",                      // draft, editable on the board
  "recommended": true,             // exactly one route per item
  "callout": ""                    // optional warning shown on the card
}
```

Rules:

- An item has 0 to 4 routes. With routes, exactly one is `recommended`. Its `title` equals the item's `hint`.
- An item without routes is not shown on the board. Nothing to do means not on the list. Two cases: it needs analysis first (`reviewDepth` is not `full`, or a review thread is `unjudged`), and the routine analyzes it on its own without a click, within `maxFullReviewsPerRun`. Or nothing can be done until someone else acts, and it returns when it changes on GitHub. Never write a placeholder route for these.
- The dialog shows the recommended route expanded. Every other route is one line with its title and expands on click.
- A finding with `routeId` belongs to that route. The card shows the finding as its reason. Findings without `routeId` stay in the collapsed findings list.
- Routes never contain "hide", "dismiss" or "snooze". The dialog footer has those.
- "Analyze again" is a footer action next to Snooze, never a route. A click reveals a full-width note field of 3 to 4 rows and a send button.
- A card can have more than one button. Each button shows who acts. A card with buttons for different actors shows no actor on its header.
- A route without inputs (no text, no choices) is a compact row. The row carries the button. It does not expand.
- Canned texts come from `<profile>/templates/<name>.md`. The agent copies the template into the route's `text` and adapts it. The text stays editable on the card.

| type | allowed `as` | params | what the click does |
| --- | --- | --- | --- |
| `reply` | `me` (default), `bot` | | `me`: copy `text`, open the thread. `bot`: post `text` |
| `request_logs` | `bot`, `me` | | post `text`, a request for logs or details (template `request-logs`). `me` is accepted in every account mode and is always prefill |
| `close` | `me` | `reason`: `completed`, `not_planned`, `duplicate`. `duplicateOf`: number, with `duplicate` | copy `text` when present, open the thread. He closes there with that reason. For a PR there is no reason |
| `reopen` | `bot` (default), `me` | | `bot`: reopen, and post `text` first when present. `me`: copy `text`, open the thread |
| `merge` | `me` | | copy `text` when present, open the PR page |
| `review` | `bot`, `me` (in every account mode, always prefill of the body, no inline comments) | `event`: `approve`, `request_changes`, `comment`. `comments`: `[{ id, path, line, startLine, text, diffHunk, original, suggestion }]`. `diffHunk` holds the at most 12 diff lines the comment refers to, starting with its `@@` header, shown on the card and never sent to GitHub. A comment that proposes a change carries `suggestion`, the replacement text without a fence, and `original`, the exact text of lines `startLine`..`line` (or `line` alone) of the file at `reviewedSha`, joined with newlines. The server composes the GitHub body from `text` and `suggestion`. `line` is on the right side of a diff hunk at `reviewedSha`. `startLine` is optional, for a range | submit one PR review with `text` as the body and the checked `comments` inline |
| `address_review` | `agent` | | offered only where `drive` is: on PRs by a maintainer, a bot or Copilot, and on contributor PRs with `takenOver: true`. Pushing our commits to a contributor's PR is always a take-over. Also offered only when every open thread has a verdict, and when the bot cannot push to the branch only if no thread needs a fix. The agent fixes or dismisses each open review thread per the maintainer's decisions, replies in each thread, resolves it and pushes to the PR branch |
| `follow_up` | `agent`, `bot`, `me` | `title` for an issue | `agent`: queued as `start_fix` with the route's `text` as instructions and `params.finding`. `bot`: file an issue with `title` and `text`, then link it in the thread. `me`: open GitHub's new-issue form with `title` and `text` filled in |
| `take_over` | `agent` | `mode`: `push` (default), `replace` | `push`: the agent finishes the PR in the contributor's PR with our commits, pushed as the bot. `replace`: it opens a replacement PR. `replace` is the exception and needs a `callout` that says why pushing is not possible. On PRs by the bot or a dependency bot only `push` is offered. On a contributor PR that is not taken over, open review threads are handled by a `take_over` with mode `push`, with the same per-thread decisions as `address_review`. After a take-over the item carries `takenOver: true`, and from then on `address_review` and `drive` are allowed |
| `drive` | `agent` | `maxRounds`: 1 to 3, default 3 | the agent drives the PR on its own: address the open review comments by its own verdicts, push, request a Copilot review, wait for it, repeat. It stops when no valid comment is left, after `maxRounds`, or when it is stuck. Offered only on PRs by a maintainer, a bot or Copilot, and on contributor PRs with `takenOver: true` |
| `move` | per button | `to`: a name from `relatedRepos`, `discussion`, or `issue` | Repo name, on an issue: two buttons, both bot. "Transfer" moves the issue. "Close, ask to reopen there" posts `text` (template `reopen-elsewhere`) and closes as not planned, for issues that lack the info the other repo needs. `discussion`, on an issue: `me`, opens the issue, he converts it there. GitHub has no API for it and it needs no reply. `issue`, on a discussion: `me`, copies `botCommands.escalate` and opens the discussion. Without that command there is no such route |
| `open` | `me` | | no text, no params. Opens the thread on GitHub. For items the agent could not analyze, see `blocked` |
| `chore` | `bot` | `action`: `label`, `assign`, `ready`, `answer_discussion`, `react`, `update_branch`, `rerun_ci`, plus that action's params | run the action |

The click sends `{ itemId, routeId, text, draftHash, force, input }` to `/api/action`. The server reads type, actor and params from the item file. `input` carries what the maintainer chose on the card:

- `review`: `{ commentIds: ["c1", "c3"] }`, the checked inline comments. All are checked by default.
- `address_review`: `{ decisions: [{ threadId, decision: "fix" | "dismiss", note }] }`. The card lists the item's `threads`. Each switch starts from the agent's verdict: only `valid` starts on `fix`, `optional`, `wrong` and `unjudged` start on `dismiss`. `note` is optional per thread. `text` is an optional note for the whole run.
- `take_over`: `{ decisions }`, the same as for `address_review` and validated the same way. Optional: a take-over without open threads sends none.
- `follow_up`: `{ title }` when the maintainer edited it.
- `drive`: `{ maxRounds }`, 1 to 3, when the maintainer changed it.
- `move` to a repo: `{ mode: "transfer" | "close" }`. Required. `close` needs a non-empty `text`. The two buttons share one route, so after one ran the other is refused.

The server checks every id and value in `input` against the route and the item. It refuses a route whose actor is `me` or `unavailable`, every merge, and a route that already ran or was queued with the same draft (409). The draft hash covers the route's stored text, its params and the item's `reviewedAt`. When the routine rewrote the route after the page showed it, the server answers that the board is out of date.

Before a bot route that posts text, reviews, closes, reopens or transfers, the server reads the thread from GitHub. It refuses when the thread is in the wrong state, when a person commented or reviewed after `reviewedAt`, or when the PR head differs from `reviewedSha`. Bots do not count. "Post anyway" sends `force: true` after a second confirm. A moved head still blocks a merge, an approval and a review with inline comments.

Routes with `as: "me"` never reach GitHub through the server and get no action doc. When the maintainer uses one, the page reports it to `POST /api/decision`, and the server writes a local entry in the decision log (see Learning). The page marks them "opened today" in localStorage.

`dismiss_route` removes a suggested route the maintainer does not want: `{ itemId, routeId, text }` to `/api/action`, with `text` an optional reason of at most 500 characters. The server removes the route from the item and appends `{ type, title, reason, at }` to the item's `dismissedRoutes`. When the removed route was the recommended one and routes remain, the first remaining route becomes recommended and `hint` becomes its title. When no route remains, the server also writes a queued `reanalyze` action doc whose `text` names the dismissed route and the reason, so the agent proposes something else. The dismissal is logged as a done action doc with `via: "board"` and in the decision log.

## Board page

One page serves every instance. `GET /api/state` returns `{ board, items, proposals }`:

- `board`: `{ me: { login, avatarUrl }, dryRun, instances: [ { name, title, kind, repos, repoUrl, bot, accountMode, paused, relatedRepos, botCommands, reviewBots } ] }`. `title` is the profile's `name`, `bot` is `{ login, avatarUrl }` or `null`. The page takes links, avatars, bot names, bot commands and new-issue URLs from the item's own instance entry, never from one global repo.
- `items[]`: each with `instance`, `id`, `ref` (`owner/name#number`), `repo` and the stored fields. Routes carry `actor`, `draftHash`, `done` and `refused`.
- `proposals[]`: the open proposals, each with `instance`.

The page talks to the server only through `window.claude`, which the server injects into the page:

- `use("board")` returns the `board` object above plus `decision(body)`, which posts `{ instance, itemId, routeId, text }` to `/api/decision` when he uses a route he does on GitHub himself. It resolves quietly, also when the post fails.
- `use("db")` returns `collection("items" | "actions" | "proposals").orderBy(field, dir).limit(n).onSnapshot(cb)`, with the docs of all instances, each doc with `instance` and keyed `<instance>/<id>`, and `doc("meta/status").onSnapshot(cb)`. `doc(path).set(data)` and `doc(path).update(data)` write through `/api/db`, whose paths gain the instance. The event stream names the instance in every event, sends a `board` event with the full `board` object when a pause changes, and `reload` when `board.html` changed.
- `use("mcp")` returns `listTools("host:gary")` and `callTool("host:gary", tool, input)`. `callTool` posts `{ instance, action: tool, ...input }` to `/api/action`. For a route click `tool` is the route type and `input` is `{ instance, itemId, routeId, text, draftHash, force, input }`. The board-only calls are `dismiss_route` with `{ instance, itemId, routeId, text }`, and `accept_proposal` and `dismiss_proposal` with `{ instance, proposalId, text }`.

The page keeps filters, drafts and "opened today" marks in localStorage under keys prefixed `gary:<instance>:`, after a one-time move of the per-repo keys. Tabs, groups and header markers are described under "One server, one master".

## Day plan

The board shows three groups: "Quick & Easy" (`active`, `easy`), "Afterwards" (`almost`, `review`) and "When you have time" (`deferred`, `hardware`, snoozed items). A chip on each row names the section. The page shows at most the time budget (6 hours by default, set on the board), filled in group order by `priority`, using `effortMinutes`. An item that does not fit is skipped. Items handled today count as spent time. "Quick & Easy" shows at most 5 rows at a time. More rows appear only on click. The default view shows no backlog counts.

## Validation

`gary put` and `gary validate` check an item against these rules. A broken rule refuses the write and lists every problem.

- The required fields are present and every enum holds one of its values: `kind`, `number`, `title`, `url`, `author`, `authorType`, `section`, `priority`, `effortMinutes`, `reviewDepth`, `state`, and where present `ci`, `mergeable`, `reviewDecision`, thread verdicts and finding severities. `repo` is present and one of the instance's repos. The id matches the opaque id pattern.
- 0 to 4 routes with the ids `r1` to `r4`, each id once. With routes, exactly one is `recommended`, and `hint` equals its title and has at most 60 characters. An item without routes needs no hint.
- No routes while a thread is `unjudged`.
- Every route's `as` is allowed for its type and is not `unavailable` in the current account mode.
- `address_review` only when every thread has an id and a verdict, and only where `drive` would be accepted. `drive` and `take_over` only where the server would accept them.
- An item with `blocked` has exactly one route, of type `open`. An `open` route has no text and no params, and is allowed without `blocked` too.
- No route whose type is in the item's `dismissedRoutes`. The message names the dismissed route and its reason. `move` targets are in `relatedRepos`. Chores name a chore action.
- No text the bot would post contains a `botCommands` string.
- Every `findings[].routeId` names a route of the item.
- A review comment with `suggestion` has `original` with exactly `line - startLine + 1` lines (1 without `startLine`), no ```` ```suggestion ```` fence in `text`, and a `diffHunk`, when present, that starts with `@@`.

A `review` that approves or a `merge` route while a thread is judged `valid` is a warning on stderr, not a refusal. So is a review comment without `suggestion` whose `text` holds a suggestion fence, the old form.

## Database

One JSON file per doc under each instance's `<state>/board/`. Item ids are opaque, matching `^[a-z0-9][a-z0-9._-]{0,99}$`, and no code derives a repo, kind or number from one. Maintainer instances keep ids like `pr-12`. Outside one instance an item is addressed as `{ instance, id }`. The routine writes items and `meta.json` with `gary put`: a full item replaces the stored one, a partial update uses `--merge`. The server writes them on clicks and pushes every file change to the open page.

Every writer replaces a file atomically: it writes a temporary file in the same directory, then renames it over the target. Readers never see a half-written file. There are no versions. A writer that updates an item re-reads the file right before writing and keeps fields the other side owns.

### `items/<id>.json`

`id` is `pr-<n>`, `issue-<n>` or `disc-<n>`.

```jsonc
{
  "repo": "acme/widgets",          // required, one of the instance's repos
  "kind": "pr",                    // pr | issue | discussion
  "number": 512,
  "title": "…",
  "url": "https://github.com/…",
  "author": "someone",
  "authorType": "contributor",     // maintainer | bot | copilot | contributor
  "labels": ["bug"],
  "isDraft": false,
  "ci": "passing",                 // passing | failing | pending | none   (PRs)
  "section": "easy",
  "priority": 2,                   // 1 = top of its section
  "effortMinutes": 5,              // estimated maintainer time to read up and decide: 1, 2, 5, 10, 15, 30 or 60
  "waitingDays": 12,               // optional: days an outside question or request has gone unanswered
  "updatedAt": "ISO",              // GitHub updatedAt
  "reviewedAt": "ISO",             // when the agent last looked
  "reviewedSha": "abc123",         // PR head at review time
  "reviewDepth": "full",           // quick | full | pending
  "state": "One sentence, at most 25 words: what the maintainer has to decide or do.",
  "story": "…",                    // 3 to 5 sentences: what happened so far, for someone who has not read the thread
  "hint": "Reply: PR welcome",     // suggested action, at most 60 characters, shown in the list
  "mergeable": "mergeable",        // PRs, from the snapshot: mergeable | conflicting | unknown
  "openThreads": 2,                // PRs: unresolved review threads, from the snapshot
  "reviews": [                     // PRs: one per reviewer, copied from the snapshot's reviewSummary, plus one "pending" entry per requested reviewer
    { "author": "octocat", "isBot": false, "state": "approved", "submittedAt": "ISO", "url": "…", "openThreadCount": 0 }
  ],
  "threads": [                     // PRs: unresolved review threads with the agent's judgement
    { "id": "PRRT_…", "author": "copilot-pull-request-reviewer", "isBot": true, "path": "…", "line": 120, "url": "…",
      "summary": "One line: what the comment asks for.", "verdict": "valid", "note": "One sentence of reasoning." }
  ],                               // verdict: valid | optional | wrong | unjudged
  "reviewDecision": "pending",     // PRs, from the snapshot: approved | changes_requested | pending
  "isAnswered": false,             // discussions, from the snapshot
  "solved": false,                 // issues and discussions: the agent thinks it is resolved
  "findings": [                    // optional, full reviews only
    { "severity": "blocker", "text": "…", "ref": "src/…:123", "routeId": "r2" }   // blocker | major | minor | idea | question. routeId is optional
  ],
  "routes": [ … ],                // see Routes
  "takenOver": false,              // PRs: true after a take_over ran. Allows `drive` on a contributor PR
  "analyzedBy": "fallback",        // optional: a safety filter stopped the full model's triage and a smaller model did it. Only value "fallback"
  "blocked": { "reason": "safety_filter", "at": "ISO" },   // optional: the agent could not analyze the item. reason: safety_filter | failed. A successful triage writes the item without it
  "rounds": [                      // PRs: written when a drive ended
    { "n": 1, "fixed": ["…"], "dismissed": [ { "summary": "…", "reason": "…" } ], "open": ["…"] }
  ],
  "links": [ { "label": "Draft fix", "url": "…" } ],
  "hidden": false,                 // set by dismiss, cleared by the routine when updatedAt changes
  "snoozedUntil": null,
  "dismissedRoutes": [             // set by dismiss_route, never cleared by the routine
    { "type": "close", "title": "Close: fixed in 2.3.1", "reason": "Not fixed for him yet", "at": "ISO" }
  ]
}
```

All strings that originate on GitHub are untrusted. The page renders them with `textContent`, never `innerHTML`.

### `actions/<id>.json`

`id` is `<itemId>-<timestamp>`.

```jsonc
{
  "itemId": "pr-512",
  "routeId": "r1",                 // the clicked route
  "route": "review",               // its type
  "draftHash": "…",                // the draft the maintainer saw
  "edited": false,                 // whether he changed the text
  "action": "review",              // the GitHub action or agent request it ran or queued
  "params": {},
  "text": "",
  "status": "queued",              // queued | done | failed
  "via": "server",                 // server for GitHub actions, queue for agent requests
  "createdAt": "ISO",
  "finishedAt": null,
  "result": ""                     // URL of the created comment, or the error message
}
```

The server writes an action file for every bot or agent click. A GitHub action gets `status: "done"` or `"failed"` and `via: "server"`. A failed one stays failed: nothing retries it. Agent requests always get `status: "queued"` and `via: "queue"`. This gives the routine a log of what the maintainer decided.

The maintainer's fields in an item are `snoozedUntil`, `hidden` and `dismissedRoutes`. The routine keeps them when it rewrites an item, and `gary put` carries them over in replace mode. It clears `hidden` only when the item changed on GitHub since the last run, and it never clears `dismissedRoutes`.

### `meta.json`

```jsonc
{ "lastRunAt": "ISO", "lastRunSummary": "…", "pendingReviews": 12, "staleIssues": 240, "staleDiscussions": 500 }
```

## Actions

One implementation in `scripts/lib/actions.mjs`, used by the board server, `gary action` and the MCP server. Input: `{ instance, repo, action, kind, number, params, text }`. The server maps a clicked route to one or more of these. `instance` scopes the settings, the bot token and the profile. `repo` is the item's `repo`, by default the instance's one repo, and an action on a repo outside the instance's allowed list is refused. The freshness guard reads the thread of the item's repo the same way. `gary action` with an `itemId` takes kind, number and repo from the stored item doc.

GitHub actions, executed with `gh` under the account of the current mode (see Accounts):

| action | params | effect |
| --- | --- | --- |
| `comment` | | post `text` on the PR, issue or discussion |
| `merge` | `method` (default `squash`), `sha` | merge the PR. With `sha` the merge fails when the head moved since the review. The board never offers it |
| `ready` | | mark a draft PR ready for review |
| `close` | `reason` (`completed`, `not_planned`, `duplicate`), `duplicateOf` | optional `text` as comment first, then close. The board offers it only inside a `move` route |
| `review` | `event`, `comments: [{ path, line, startLine, text }]`, `sha` | one PR review with body `text` and inline comments |
| `create_issue` | `title` | open an issue with body `text`, returns its URL |
| `transfer` | `repo` | transfer the issue to a repository in the profile's `relatedRepos` |
| `update_branch` | `sha` | merge the base branch into the PR branch |
| `rerun_ci` | | restart the failed checks of the PR head |
| `reopen` | | optional `text` as comment first, then reopen |
| `request_review` | `reviewer` (`copilot`) | request a Copilot review on the PR. It runs under the maintainer's own login, after the check that the login is `me`, and needs `copilot` in `reviewBots` |
| `label` | `add: []`, `remove: []` | change labels |
| `assign` | `assignees: []` | assign |
| `react` | `content` (`THUMBS_UP`, `HEART`, `HOORAY`, `ROCKET`, `EYES`), `commentId` (optional) | add a reaction to the comment, or to the thread itself without `commentId` |
| `answer_discussion` | `commentId` | mark a discussion comment as the answer |

Board-only actions, no GitHub call. The page applies them to the item file through the server:

| action | effect |
| --- | --- |
| `dismiss` | `hidden: true` until the item changes on GitHub. The board calls it "Hide until it changes" |
| `snooze` | `params.days`, sets `snoozedUntil` |
| `dismiss_route` | removes one route, see Routes. The server applies it through `/api/action` |
| `accept_proposal`, `dismiss_proposal` | decide a rule proposal, see Learning. The server applies them through `/api/action` |

Agent requests. The server writes them as queued action docs when their route is clicked. The page writes only the `reanalyze` doc of "Analyze again". The master session watches the queue between runs (`gary watch-queue` under the Monitor tool) and starts them within seconds. If the master is not running, the next hourly run picks them up:

| action | effect |
| --- | --- |
| `full_review` | run the full review for this item, outside the budget |
| `reanalyze` | `text` holds an optional maintainer instruction for the agent |
| `start_fix` | attempt a fix with repro test and draft PR. Optional `text` holds instructions, `params.finding` the finding it came from |
| `address_review` | `params.decisions` as sent by the card. The agent fixes or dismisses each thread and pushes to the PR branch as the bot |
| `take_over` | `params.mode` `push` or `replace`, optional `params.decisions` as for `address_review`, optional `text` with instructions |
| `drive` | `params.maxRounds`. When it ends the agent writes `rounds: [{ n, fixed: ["…"], dismissed: [{ summary, reason }], open: ["…"] }]` into the item and the fitting routes: merge when nothing is open, otherwise a review or address_review card. The dialog shows the rounds as a short summary |

Every action returns `{ ok, result }` and never throws past the entry point. `--dry-run` applies the account rules and the read-only lookups and returns the writes it would send instead.

## Learning

Gary learns from where the maintainer deviates from the agent's proposals. The server keeps a decision log. A daily skill turns patterns in it into rule proposals. The maintainer accepts or dismisses each proposal on the board, and an accepted one is appended to a rules file.

### Decision log

`<state>/decisions.jsonl`, append-only, one JSON object per line. Only the server writes it, one entry at a time. Every entry has these fields, plus the fields of its type:

```jsonc
{ "at": "ISO", "instance": "widgets", "instanceKind": "maintainer", "repo": "acme/widgets",
  "type": "chose_alternative", "itemId": "pr-512",
  "item": { "kind": "pr", "authorType": "contributor", "section": "easy", "labels": ["bug"], "title": "…" } }
```

`repo` is the item's repo, `null` for entries without an item, like `dismissed_proposal`. The server writes every entry through `logDecision(instance, type, itemId, item, fields)`.

| type | fields | written when |
| --- | --- | --- |
| `dismissed_route` | `route: { type, title }`, `wasRecommended`, `reason` | `dismiss_route` ran |
| `chose_alternative` | `recommended: { type, title }`, `chosen: { type, title }` | the used route is not the recommended one |
| `edited_text` | `route: { type, title }`, `draft`, `final`, each cut at 8000 characters | the sent or copied text differs from the route's draft |
| `thread_override` | `route: { type }`, `thread: { summary, verdict }`, `decision`, `note` | a fix or dismiss switch differs from the default for the agent's verdict, or carries a note |
| `unchecked_comment` | `comment: { path, text }` | one entry per inline review comment the maintainer unchecked |
| `agent_note` | `text` | the note of "Analyze again", or the instruction text of an agent route |
| `snoozed` | `days`, or `untilActivity: true` | the maintainer snoozed or hid the item |
| `dismissed_proposal` | `proposal: { id, title, target, file }`, `reason` | `dismiss_proposal` ran, so the pattern is not proposed again |

The server derives these entries itself when a bot or agent route is clicked, and for `dismiss_route`, "Analyze again", snooze and hide. Routes with `as: "me"` never reach `/api/action`. The page reports their use to `POST /api/decision` with `{ itemId, routeId, text }`, under the same token, origin and JSON checks. The server then logs `chose_alternative` and `edited_text` from the item file. It writes nothing to GitHub and no action doc.

`gary decisions [--since <ISO>] [--json]` prints the entries. `--since` is exclusive: it prints entries whose `at` is later than the value.

### Proposals

`<state>/board/proposals/<id>.json`, one file per proposal:

```jsonc
{
  "id": "learn-2026-11-18-close-stale-config-prs",   // set by the skill: learn-<YYYY-MM-DD>-<slug>, matches ^[a-z0-9-]{1,80}$
  "createdAt": "ISO",
  "title": "Close config PRs after 30 days without reply",   // at most 60 characters
  "why": "One or two sentences on the pattern.",
  "evidence": [ { "at": "ISO", "itemId": "pr-512", "type": "chose_alternative", "gist": "…" } ],
  "target": "profile",             // profile | personal
  "file": "rules/classification.md",   // relative: rules/<topic>.md or templates/<name>.md for the profile, personal.md for personal
  "heading": "## Stale PRs",       // an existing heading to append under, or null or empty for the end of the file
  "text": "The rule as markdown, editable on the board.",
  "status": "open",                // open | accepted | dismissed
  "decidedAt": null,
  "reason": ""                     // the dismissal reason
}
```

The skill writes proposals with `gary put proposals <id> <file>`, which validates them. `gary proposals [--json]` lists every proposal with its status and the dismissal reason. `/api/state` serves the open proposals as `proposals`, and the event stream pushes their changes.

### Accept and dismiss

Both go through `/api/action` with `{ proposalId, text }`.

- `accept_proposal` appends `text`, the edited rule, to the target file: under `heading` when the file has that heading, at the end of the file otherwise. The path must resolve inside the profile's `rules/` or `templates/` directory, or be exactly the shared `<root>/personal.md`. Symlinks that lead elsewhere are refused, and the write is atomic. When the profile directory is a git repository, the server commits that one file there with the message `Add rule: <title>` and does not push. Then it sets `status: "accepted"` and `decidedAt`.
- `dismiss_proposal` sets `status: "dismissed"`, `decidedAt` and `reason` from `text`, and logs a `dismissed_proposal` entry.

Both run in dry-run mode too, because they change only local files and never GitHub.

### Cursor

`<state>/learn.json` is `{ "reviewedUntil": "ISO", "lastLearnAt": "ISO" }`. The skill writes it with `gary put learn <file>`. `reviewedUntil` is the `at` of the newest log entry it read, `lastLearnAt` the time of its last pass.

## MCP server

Name `gary`, stdio, for interactive Claude sessions and for the master session. A plugin install starts it from `.mcp.json`. Its tools are then named `mcp__plugin_gary_gary__<tool>`. A clone registers it in user scope with `claude mcp add --scope user gary -- node <core>/mcp-server/index.mjs`, and the tools are named `mcp__gary__<tool>`. Skills find it with ToolSearch by the tool name `board_start`.

One tool per GitHub action above, named like the action. Each takes `kind`, `number`, `params`, `text`, acts on the instance of the session's working directory and rejects anything outside the table. Three more tools control the one board server and work from any directory: `board_start` starts it inside the MCP process at the root port, or reports the one that already runs, with the instances it serves. `board_stop` stops it if this process started it. `board_status` returns `{ url, owner, portAnswers, instances, sessionInstance }`, plus `sessionInstanceError` when the session's directory resolves to no instance.

## Snapshot

```
gary snapshot            # prints JSON work list to stdout, stages <state>/snapshot.pending.json
gary snapshot --commit   # after a successful run: save the staged snapshot as the new baseline
```

Fetches with GraphQL: all open PRs that are not drafts, plus open issues and discussions updated within `activeWindowDays`. For each item it collects what classification needs without another call: author and author type, labels, draft flag, head SHA, CI rollup, review decision, the latest reviews, a summary per reviewer, requested reviewers, open review threads, changed file paths and `sensitiveFiles`, the PRs that would close an issue (`closingPrs`), last 5 comments with author and author association, comment count, updatedAt. Open review threads include unresolved threads that GitHub marks outdated, with `outdated: true`. It diffs against `<state>/snapshot.json`.

Output:

```jsonc
{
  "changed": [ { "id": "pr-512", "reason": "new | updated | head_changed", /* item data */ } ],
  "unchanged": ["pr-1", …],
  "closed": ["issue-22", …],        // in the old snapshot, now closed or outside the active window
  "stale": { "issues": 240, "discussions": 500 }
}
```

## Routine run

The `triage-master` skill runs once per machine: it starts the board with `board_start`, follows `gary watch-queue --all`, and starts one worker per instance for the hourly triage and one per agent request. It picks each worker's run id, a UTC timestamp, and passes the run directory `<state>/runs/<run>/`. The worker writes its result to `summary.txt` there.

The `triage-routine` skill is the worker for one instance. In short:

1. Run `gary paths` and read `config.json` and the profile. Take the run lock. Check the profile's `requiredTools`.
2. Process queued action files in `<state>/board/actions/` that the master handed it. They are agent requests and go onto this run's work list. Write back status and result.
3. Run `gary snapshot`.
4. Delete the items for `closed` ids with `gary put items <id> --delete`.
5. Quick-classify every `changed` item. Pick up to `maxFullReviewsPerRun` for a full review: first items that need analysis, then contributor PRs, then items in `active`, then the rest by updatedAt.
6. Run full reviews as parallel subagents. PRs use `triage-review-pr`, issues and discussions use `triage-issue`.
7. Attempt up to `maxAutoFixesPerRun` fixes that the issue triage marked as solvable.
8. Write each item as a complete doc with `repo`, with `gary put`, which keeps the maintainer's fields. Clear `hidden` on changed items with `gary put --merge`. Apply the autonomous label and assignment changes with `gary action --autonomous`.
9. Write `meta.json`. Run `gary snapshot --commit`. Write `summary.txt`.

## One server, one master (target design, supersedes conflicting text above)

This section is the contract for the single-server change. Where an older section disagrees, this one wins, and the older section gets rewritten to match.

### Processes

- One board server per machine serves every instance. One port, in `<root>/config.json` as `{ "port": 7878 }`. Instance configs have no port.
- One master Claude session owns the server and the one queue watcher. It starts one worker per instance for the hourly triage and one worker per agent request. A worker is a child session when the harness has tools for that, otherwise a headless run, otherwise the master does the job itself with subagents.
- Workers report through the instance's state directory only. Nothing depends on messages between sessions.
- Server-wide files live in `<root>/state/`: `server-token`, `server.log`. Everything else stays in `<root>/instances/<name>/state/`.
- The server watches `<root>/instances/` and picks up a new instance without a restart.

### Instances and kinds

- Instance config gets `kind`. Today the only value is `"maintainer"`. A later kind `"contributions"` covers the user's own work across repos.
- Every instance has a list of allowed repos. For `maintainer` it is the profile's one `repo`. An action is refused when the item's repo is not in that list.
- Rules that differ by kind live in files named for the kind: `skills/triage-routine/references/classification.maintainer.md`. Shared rules keep their names.
- Checkout and rules are looked up per repo through one function each (`checkoutFor(instance, repo)`, `rulesFor(instance, repo, topic)`). For `maintainer` they return the configured checkout and the profile's file.

### Item identity

- Every item doc carries `repo` (`owner/name`), next to `kind` and `number`. Stored docs are migrated once.
- An item id is opaque: `^[a-z0-9][a-z0-9._-]{0,99}$`. No code derives the repo, kind or number from an id. Maintainer instances keep ids like `pr-12`.
- Outside one instance an item is addressed as `{ instance, id }`. The server adds `instance` and `ref` (`owner/name#number`) to every item it serves.
- Decision log entries carry `instance`, `instanceKind` and `repo`.

### Server API

All existing endpoints stay, with the instance added:

- `GET /api/health` → `{ ok, name: "gary", instances: ["…"] }`.
- `GET /api/state` → `{ board, items, proposals }`.
  - `board`: `{ me: { login, avatarUrl }, dryRun, instances: [ { name, title, kind, repos: ["owner/name"], repoUrl, bot: { login, avatarUrl } | null, accountMode, paused, relatedRepos, botCommands, reviewBots } ] }`. `title` is the profile's `name`.
  - `items[]`: each with `instance`, `id`, `ref`, `repo` and the stored fields. Routes carry `actor`, `draftHash`, `done`, `refused` as today.
  - `proposals[]`: each with `instance`.
- `POST /api/action`: the body gains `instance`. Route clicks: `{ instance, itemId, routeId, text, draftHash, force, input }`. Board actions likewise (`dismiss_route`, `accept_proposal`, `dismiss_proposal` with `{ instance, proposalId, … }`).
- `POST /api/decision`: `{ instance, itemId, routeId, text }`.
- `/api/db` reads and writes: the collection path gains the instance.
- `GET /api/events`: every event names its instance. A `board` event carries the full `board` object.
- Page shim: `use("board")` returns the `board` object above plus `decision(body)`. `db.collection("items" | "actions" | "proposals")` holds the docs of all instances, each doc with `instance`, keyed `<instance>/<id>`. `callTool` sends `{ instance, action, …input }`.
- Pause is per instance (`board.instances[].paused`). A refused click answers as today.

### CLI and MCP

- `gary serve` starts the one server (also `--watch`, `--dry-run`). `board_start` starts or finds it, `board_status` lists the instances it serves. `board_start` works from any directory.
- `gary watch-queue --all` prints one line per queued agent request of any instance: `{ "instance", "id", "itemId", "action" }`.
- `gary instances --json` lists name, kind, repos, checkout, paused.
- `gary setup` no longer takes or assigns a port per instance. `--port` sets the root port.
- Everything else resolves its instance as described under Instances.

### Board page

- Tabs: one combined tab "All" first, then one tab per instance, titled by the instance's `title`. The tab choice is remembered in the browser.
- Every tab follows the same rules: the three groups, the time budget, at most 5 rows in "Quick & Easy", "Show more", hidden controls, no backlog counts. The budget setting is one value for the whole board.
- The combined tab shows `owner/name#number` where a project tab shows `#number`. The dialog's top bar shows the full ref in the combined tab.
- Links, avatars, bot names, bot commands and new-issue URLs come from the item's own instance entry in `board.instances`. Nothing is taken from a single global repo.
- Header markers: "dry run" for the board, "Paused" per instance (on its tab, and in the combined tab when all are paused: "Paused", when some: "Paused: <titles>"). The lightbulb counts proposals of all instances, and each proposal card names its instance.
- Browser storage keys are per instance: `gary:<instance>:…`, with a one-time move of the per-repo keys.
