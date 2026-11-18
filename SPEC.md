# Gary: contract

Gary is maintainer triage for one GitHub repository. An hourly Claude routine reviews the open PRs, issues and discussions. It writes one briefing per item as a JSON file into a local store. A local Node.js server serves the board page from that store. The maintainer reads the board and clicks buttons. A click is the maintainer's approval. Only approved actions change anything public on GitHub, with the exceptions listed under Autonomy.

The examples below use the project `acme/widgets`, the maintainer `octocat` and the bot `widgets-bot`.

## Decisions

- **Runtime**: one master Claude session, working directory the project checkout from `config.json`. An hourly scheduled task posts into that same session. The master owns the board server and only orchestrates. Classification, reviews, triage and fixes run in subagents, so the master's context stays small across runs.
- **Identity**: see Accounts. Gary's code reads the bot token from `bot.tokenFile` and sets `GH_TOKEN` itself. It never depends on a `gh` shell function or alias.
- **Scope**: all open PRs that are not drafts. Draft PRs are ignored entirely. Issues and discussions with activity in the last `activeWindowDays` days. Older ones appear only as a count.
- **Author tags**: `maintainer` (the profile's `maintainers` and `me`), `bot` (the profile's `botLogins`, the configured bot and every GitHub App), `copilot` (GitHub's Copilot coding agent), `contributor` (everyone else). All are included and filterable.
- **Review depth**: tiered. Every changed item gets a quick classification. Contributor PRs and active issues get a full review. The profile's `rules/review.md` names the project's own review skills and tools.
- **Budget per run**: at most `maxFullReviewsPerRun` full reviews and `maxAutoFixesPerRun` auto-fix attempts. Remaining changed items get `reviewDepth: "pending"`.
- **Autonomy without a click**: add and remove the labels in the profile's `autoLabels`, assign, and open draft fix PRs with a reproducing test where the project's `rules/issues.md` allows it. Everything else needs a click.
- **Board server**: `server/server.mjs` serves the board on `127.0.0.1` at the `port` from `config.json`. It runs inside the `gary` MCP server of the master session, which starts it with the `board_start` tool at the beginning of every run. Other sessions leave it alone. It watches `<state>/board/` and pushes changes to the open page.
- **Buttons**: a click on a bot route makes the server run it live through `scripts/lib/actions.mjs`. When the server cannot reach GitHub, it writes the action to `<state>/board/actions/` with status `queued`, and the next hourly run executes it. Agent requests are always queued.
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
    doctor.mjs           gary doctor
    lib/                 paths and settings, gh wrapper, actions, freshness guard, board store
  mcp-server/index.mjs   stdio MCP server "gary"
  server/server.mjs      board server: serves the page, runs clicked routes, watches the board store
  board/board.html       the board page
  skills/                triage-routine, triage-review-pr, triage-issue, triage-setup
  profiles/template/     the skeleton `gary setup` copies for a new project

<home>/                  $GARY_HOME, default ~/.config/gary/. Survives updates, nothing in it is shared
  config.json            local settings
  personal.md            the maintainer's own rules, read last
  state/                 board store, snapshots, runs, worktrees, server token, logs
    board/               items/<id>.json, actions/<id>.json, meta.json

<profile>/               one directory per project, named by `profile` in config.json. A team can share it
  profile.json           facts the code needs
  rules/                 classification.md, voice.md, review.md, issues.md
  templates/             canned texts, like request-logs.md and reopen-elsewhere.md
```

The core contains no repo name, no account name and no absolute path. It works as a Claude Code plugin and from a plain git clone. In a plugin install Claude Code puts `bin/` on the Bash PATH and starts the MCP server from `.mcp.json`. For a clone, `gary setup` links the skills into `~/.claude/skills`, links the launcher into `~/.local/bin` and registers the MCP server with `claude mcp add --scope user gary`.

### config.json

```jsonc
{
  "profile": "~/repositories/gary-profile-widgets",   // directory of the project profile. Relative paths are relative to home
  "me": "octocat",                 // the maintainer's GitHub login
  "checkout": "~/repositories/widgets",   // local clone of the repo. Worktrees for fixes go under state/worktrees/
  "bot": { "login": "widgets-bot", "tokenFile": "~/.config/widgets-bot/gh-token" },   // or null
  "allowOwnTokenPushes": false,    // without a bot: may agents push and post with the maintainer's own gh login
  "port": 7878,
  "activeWindowDays": 30,
  "activeMaxWaitDays": 14,
  "maxFullReviewsPerRun": 10,
  "maxAutoFixesPerRun": 2
}
```

`profile` and `me` are required. The other fields have the defaults shown. Unknown fields are errors.

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

Reading order for every rule: the core reference, then the profile's file of the same topic, then `personal.md`. A later file overrides an earlier one. The hard limits in the core skills cannot be overridden.

## Launcher

`gary <command>` runs every command the skills and the maintainer need. Skills never use a path into the core.

- `gary snapshot`, `gary snapshot --commit`: see Snapshot.
- `gary put items <id> <file>`, `gary put items <id> --delete`, `gary put meta <file>`: write one board document through the board server, or directly when it does not run.
- `gary action [--dry-run] [--check-fresh] [file]`: run one GitHub action from a JSON file or stdin.
- `gary watch-queue [--once]`: print queued agent requests as JSON lines.
- `gary paths`: print JSON with the keys `core`, `home`, `profile`, `state` and `checkout`.
- `gary setup`: create the home with `config.json`, `personal.md` and `state/`. It asks in a terminal and takes flags in a script: `--repo`, `--me`, `--checkout`, `--profile`, `--name`, `--bot-login`, `--bot-token-file`, `--no-bot`, `--port`, `--force`, `--no-links`, `--register-mcp`. A new project gets a profile copied from `profiles/template/`. It never replaces an existing `config.json` without `--force` and never touches an existing `personal.md`.
- `gary doctor`: read-only checks of Node, `gh`, the stored `gh` login against `me`, the bot token against `bot.login`, the profile, the checkout, the port, the skill links and the launcher.

Environment: `GARY_HOME` moves the home. `GARY_DRY_RUN=1` makes the board server and the MCP server run without GitHub writes. `GARY_GUARD_STUB` replaces the freshness read in tests.

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
| `request_logs` | `bot`, `me` without a bot | | post `text`, a request for logs or details (template `request-logs`) |
| `close` | `me` | `reason`: `completed`, `not_planned`, `duplicate`. `duplicateOf`: number, with `duplicate` | copy `text` when present, open the thread. He closes there with that reason. For a PR there is no reason |
| `reopen` | `bot` (default), `me` | | `bot`: reopen, and post `text` first when present. `me`: copy `text`, open the thread |
| `merge` | `me` | | copy `text` when present, open the PR page |
| `review` | `bot`, `me` without a bot (prefill of the body, no inline comments) | `event`: `approve`, `request_changes`, `comment`. `comments`: `[{ id, path, line, startLine, text, diffHunk }]`. `diffHunk` holds the at most 12 diff lines the comment refers to, shown on the card and never sent to GitHub. `line` is on the right side of a diff hunk at `reviewedSha`. `startLine` is optional, for a range | submit one PR review with `text` as the body and the checked `comments` inline |
| `address_review` | `agent` | | offered only when every open thread has a verdict. When the bot cannot push to the branch it is offered only if no thread needs a fix. The agent fixes or dismisses each open review thread per the maintainer's decisions, replies in each thread, resolves it and pushes to the PR branch |
| `follow_up` | `agent`, `bot`, `me` | `title` for an issue | `agent`: queued as `start_fix` with the route's `text` as instructions and `params.finding`. `bot`: file an issue with `title` and `text`, then link it in the thread. `me`: open GitHub's new-issue form with `title` and `text` filled in |
| `take_over` | `agent` | `mode`: `push` (default), `replace` | `push`: the agent finishes the PR in the contributor's PR with our commits, pushed as the bot. `replace`: it opens a replacement PR. `replace` is the exception and needs a `callout` that says why pushing is not possible. After a take-over the item carries `takenOver: true` |
| `drive` | `agent` | `maxRounds`: 1 to 3, default 3 | the agent drives the PR on its own: address the open review comments by its own verdicts, push, request a Copilot review, wait for it, repeat. It stops when no valid comment is left, after `maxRounds`, or when it is stuck. Offered only on PRs by a maintainer, a bot or Copilot, and on contributor PRs with `takenOver: true` |
| `move` | per button | `to`: a name from `relatedRepos`, `discussion`, or `issue` | Repo name, on an issue: two buttons, both bot. "Transfer" moves the issue. "Close, ask to reopen there" posts `text` (template `reopen-elsewhere`) and closes as not planned, for issues that lack the info the other repo needs. `discussion`, on an issue: `me`, opens the issue, he converts it there. GitHub has no API for it and it needs no reply. `issue`, on a discussion: `me`, copies `botCommands.escalate` and opens the discussion. Without that command there is no such route |
| `chore` | `bot` | `action`: `label`, `assign`, `ready`, `answer_discussion`, `react`, `update_branch`, `rerun_ci`, plus that action's params | run the action |

The click sends `{ itemId, routeId, text, draftHash, force, input }` to `/api/action`. The server reads type, actor and params from the item file. `input` carries what the maintainer chose on the card:

- `review`: `{ commentIds: ["c1", "c3"] }`, the checked inline comments. All are checked by default.
- `address_review`: `{ decisions: [{ threadId, decision: "fix" | "dismiss", note }] }`. The card lists the item's `threads`. Each switch starts from the agent's verdict: `valid` is `fix`, `wrong` is `dismiss`, `optional` and `unjudged` are `fix`. `note` is optional per thread. `text` is an optional note for the whole run.
- `follow_up`: `{ title }` when the maintainer edited it.
- `drive`: `{ maxRounds }`, 1 to 3, when the maintainer changed it.
- `move` to a repo: `{ mode: "transfer" | "close" }`. Required. `close` needs a non-empty `text`. The two buttons share one route, so after one ran the other is refused.

The server checks every id and value in `input` against the route and the item. It refuses a route whose actor is `me` or `unavailable`, every merge, and a route that already ran or was queued with the same draft (409). The draft hash covers the route's stored text, its params and the item's `reviewedAt`. When the routine rewrote the route after the page showed it, the server answers that the board is out of date.

Before a bot route that posts text, reviews, closes, reopens or transfers, the server reads the thread from GitHub. It refuses when the thread is in the wrong state, when a person commented or reviewed after `reviewedAt`, or when the PR head differs from `reviewedSha`. Bots do not count. "Post anyway" sends `force: true` after a second confirm. A moved head still blocks a merge, an approval and a review with inline comments.

Routes with `as: "me"` are never logged and never reach GitHub through the server. The page marks them "opened today" in localStorage.

## Board page

`GET /api/state` returns `{ board, items, actions, meta }`. `board` holds what the page needs to name the project and the accounts without hard-coding them: `name`, `repo`, `repoUrl`, `me` and `bot` with `login` and `avatarUrl` (`bot` is `null` without one), `accountMode`, `relatedRepos`, `botCommands`, `reviewBots` and `dryRun`. The page gets the same object from `window.claude.use("board")`. It calls the server through `window.claude.use("mcp")` with the server name `host:gary`.

The page keeps filters, drafts and "opened today" marks in localStorage under keys prefixed `gary:<owner>/<repo>:`, so two boards on one machine keep their own.

## Day plan

The board shows three groups: "Quick & Easy" (`active`, `easy`), "Afterwards" (`almost`, `review`) and "When you have time" (`deferred`, `hardware`, snoozed items). A chip on each row names the section. The page shows at most the time budget (6 hours by default, set on the board), filled in group order by `priority`, using `effortMinutes`. An item that does not fit is skipped. Items handled today count as spent time. "Quick & Easy" shows at most 5 rows at a time. More rows appear only on click. The default view shows no backlog counts.

## Database

One JSON file per doc under `<state>/board/`. The routine writes items and `meta.json` with `gary put`. The server writes them on clicks and pushes every file change to the open page.

Every writer replaces a file atomically: it writes a temporary file in the same directory, then renames it over the target. Readers never see a half-written file. There are no versions. A writer that updates an item re-reads the file right before writing and keeps fields the other side owns.

### `items/<id>.json`

`id` is `pr-<n>`, `issue-<n>` or `disc-<n>`.

```jsonc
{
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
  "rounds": [                      // PRs: written when a drive ended
    { "n": 1, "fixed": ["…"], "dismissed": [ { "summary": "…", "reason": "…" } ], "open": ["…"] }
  ],
  "links": [ { "label": "Draft fix", "url": "…" } ],
  "hidden": false,                 // set by dismiss, cleared by the routine when updatedAt changes
  "snoozedUntil": null
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
  "via": "server",                 // server | queue
  "createdAt": "ISO",
  "finishedAt": null,
  "result": ""                     // URL of the created comment, or the error message
}
```

The server writes an action file for every bot or agent click. A GitHub action it ran live gets `status: "done"` or `"failed"` and `via: "server"`. One it could not run gets `status: "queued"` and `via: "queue"`. Agent requests always get `status: "queued"`. This gives the routine a log of what the maintainer decided.

The maintainer's fields in an item are `snoozedUntil` and `hidden`. The routine keeps them when it rewrites an item. It clears `hidden` only when the item changed on GitHub since the last run.

### `meta.json`

```jsonc
{ "lastRunAt": "ISO", "lastRunSummary": "…", "pendingReviews": 12, "staleIssues": 240, "staleDiscussions": 500 }
```

## Actions

One implementation in `scripts/lib/actions.mjs`, used by the board server, `gary action` and the MCP server. Input: `{ action, kind, number, params, text }`. The server maps a clicked route to one or more of these. The repo comes from `profile.json` and cannot be overridden by the caller.

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

Agent requests. The server writes them as queued action docs when their route is clicked. The page writes only the `reanalyze` doc of "Analyze again". The master session watches the queue between runs (`gary watch-queue` under the Monitor tool) and starts them within seconds. If the master is not running, the next hourly run picks them up:

| action | effect |
| --- | --- |
| `full_review` | run the full review for this item, outside the budget |
| `reanalyze` | `text` holds an optional maintainer instruction for the agent |
| `start_fix` | attempt a fix with repro test and draft PR. Optional `text` holds instructions, `params.finding` the finding it came from |
| `address_review` | `params.decisions` as sent by the card. The agent fixes or dismisses each thread and pushes to the PR branch as the bot |
| `take_over` | `params.mode` `push` or `replace`, optional `text` with instructions |
| `drive` | `params.maxRounds`. When it ends the agent writes `rounds: [{ n, fixed: ["…"], dismissed: [{ summary, reason }], open: ["…"] }]` into the item and the fitting routes: merge when nothing is open, otherwise a review or address_review card. The dialog shows the rounds as a short summary |

Every action returns `{ ok, result }` and never throws past the entry point. `--dry-run` applies the account rules and the read-only lookups and returns the writes it would send instead.

## MCP server

Name `gary`, stdio, for interactive Claude sessions and for the master session. A plugin install starts it from `.mcp.json`. Its tools are then named `mcp__plugin_gary_gary__<tool>`. A clone registers it in user scope with `claude mcp add --scope user gary -- node <core>/mcp-server/index.mjs`, and the tools are named `mcp__gary__<tool>`. Skills find it with ToolSearch by the tool name `board_start`.

One tool per GitHub action above, named like the action. Each takes `kind`, `number`, `params`, `text` and rejects anything outside the table. Three more tools control the board server: `board_start` starts it inside the MCP process, or reports the one that already runs. `board_stop` stops it if this process started it. `board_status` reports the URL, the owner and whether the port answers like the board.

## Snapshot

```
gary snapshot            # prints JSON work list to stdout, stages <state>/snapshot.pending.json
gary snapshot --commit   # after a successful run: save the staged snapshot as the new baseline
```

Fetches with GraphQL: all open PRs that are not drafts, plus open issues and discussions updated within `activeWindowDays`. For each item it collects what classification needs without another call: author and author type, labels, draft flag, head SHA, CI rollup, review decision, the latest reviews, a summary per reviewer, requested reviewers, open review threads, changed file paths and `sensitiveFiles`, last 5 comments with author and author association, comment count, updatedAt. It diffs against `<state>/snapshot.json`.

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

The `triage-routine` skill has the full sequence. In short:

1. Run `gary paths` and read `config.json` and the profile. Take the run lock. Check the profile's `requiredTools`. Start the board server with `board_start`. If it does not answer, continue and warn in the run summary.
2. Process queued action files in `<state>/board/actions/`. Agent requests go onto this run's work list. A queued GitHub action goes to `gary action --check-fresh`. Write back status and result.
3. Run `gary snapshot`.
4. Delete the items for `closed` ids with `gary put items <id> --delete`.
5. Quick-classify every `changed` item. Pick up to `maxFullReviewsPerRun` for a full review: first items that need analysis, then contributor PRs, then items in `active`, then the rest by updatedAt.
6. Run full reviews as parallel subagents. PRs use `triage-review-pr`, issues and discussions use `triage-issue`.
7. Attempt up to `maxAutoFixesPerRun` fixes that the issue triage marked as solvable.
8. Write item files with `gary put`, keeping the maintainer's fields. Clear `hidden` on changed items. Apply the autonomous label and assignment changes.
9. Write `meta.json`. Run `gary snapshot --commit`.
10. Between runs, follow `gary watch-queue` and handle each agent request as it arrives.
