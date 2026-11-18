# Gary

Gary is maintainer triage for one GitHub repository. An hourly Claude routine reviews the open PRs, issues and discussions and writes one briefing per item. A local server shows them as a board on `http://127.0.0.1:<port>/`. A click on the board is the maintainer's approval. `SPEC.md` is the contract.

## Install

As a Claude Code plugin, the repository is its own marketplace:

```sh
claude plugin marketplace add <git URL or path of this repository>
claude plugin install gary@gary
gary setup
```

From a plain clone:

```sh
git clone <git URL> ~/repositories/gary
cd ~/repositories/gary && npm install
bin/gary setup --register-mcp
```

`setup` asks for what it needs in a terminal. In a script, pass flags:

```sh
gary setup --profile ~/repositories/gary-profile-widgets --me octocat --checkout ~/repositories/widgets \
  --bot-login widgets-bot --bot-token-file ~/.config/widgets-bot/gh-token
gary setup --repo acme/widgets --me octocat --no-bot   # new profile from profiles/template
```

It writes `config.json`, an empty `personal.md` and `state/` into the home directory. It never replaces an existing `config.json` without `--force`, and it never touches an existing `personal.md`. For a clone it also links every skill into `~/.claude/skills`, links the launcher into `~/.local/bin` and prints the `claude mcp add` command, or runs it with `--register-mcp`. `--no-links` skips that step.

`gary doctor` checks the installation without changing anything: Node version, `gh`, that the stored `gh` login is `me`, that the bot token belongs to the bot, the profile, the checkout, the port and the skill links.

## Three layers

- **Core**: this repository. It holds no repo name, no account name and no path of one machine, so nobody edits it to adapt the tool. `profiles/template/` is the skeleton for a new project.
- **Home**: `$GARY_HOME`, default `~/.config/gary/`. `config.json` holds the local settings, `personal.md` the maintainer's own rules, `state/` the board store, snapshots, runs, the server token and logs.
- **Profile**: one directory per project, named by `profile` in `config.json`. `profile.json` holds the facts the code needs, `rules/` and `templates/` the texts the agents read. A team can share it.

`gary paths` prints where each of these lives on this machine.

## Accounts

`me` in `config.json` is the maintainer's GitHub login. The `gh` binary acts for him with the login stored by `gh auth login`. `bot` names a second account and its token file, or is `null`.

- With a bot, every GitHub write runs as the bot with its token in `GH_TOKEN`. No `gh` shell function or alias plays a part.
- Without a bot, bot routes with a text become text the maintainer posts himself. Routes without a text, like a transfer, a chore or inline review comments, run only when `allowOwnTokenPushes` is true. They then run under his stored login, after a check that this login is `me`.
- `request_review` with `reviewer: "copilot"` always runs under his stored login, after the same check. With a bot configured, the helper in `scripts/lib/gh.mjs` that does this is the only way to that login, and it sends only that one mutation.
- No text the bot posts may contain a command from the profile's `botCommands`.

## How the pieces connect

1. `gary snapshot` fetches the open items and prints what changed since the last run.
2. The routine in `skills/triage-routine/` reviews the changed items and writes them with `gary put`.
3. The board server in `server/server.mjs` serves `board/board.html` and pushes every change in `state/board/` to open pages. A click runs the GitHub action right away.
4. Agent requests from the board are queued in `state/board/actions/`. `gary watch-queue` wakes the master session for them.

The board server, the MCP server and `gary action` share one implementation in `scripts/lib/actions.mjs`. It accepts only the actions in the spec table and always targets the repo from the profile.

## gary snapshot

```sh
gary snapshot           # print the work list, stage state/snapshot.pending.json
gary snapshot --commit  # promote the staged snapshot to state/snapshot.json
```

The first command never touches the baseline in `state/snapshot.json`. `--commit` saves the snapshot from the previous plain run. Items that change on GitHub between the two calls show up again in the next run.

```jsonc
{
  "changed": [{ "id": "pr-9488", "reason": "head_changed", "kind": "pr", "ci": "passing", /* … */ }],
  "unchanged": ["issue-9401"],
  "closed": ["disc-9310"],
  "stale": { "issues": 259, "discussions": 547 }
}
```

`closed` also lists issues and discussions that are still open but had no activity within `activeWindowDays`. Text fields are cut at 1500 characters and PRs list at most 50 changed files. A PR whose files match the profile's `sensitivePaths` carries them in `sensitiveFiles`. Authors count as `maintainer` when they are in the profile's `maintainers` or are `me`, and as `bot` when they are in `botLogins`, are the configured bot or are a GitHub App.

## gary item

`gary item pr-9488` prints the fresh snapshot entry of one item as JSON, read from GitHub with the same fields as `gary snapshot`. It writes no state. Use it to re-check one item without a full snapshot.

## gary action

```sh
echo '{"action":"label","kind":"issue","number":6,"params":{"add":["bug"]}}' | gary action --dry-run
gary action action.json
gary action --check-fresh label.json
```

It prints `{ "ok": …, "result": … }` and exits with 1 when `ok` is false. Every `gh` call stops after 60 s, and a failure ends with the tail of gh's stderr. Instead of `kind` and `number`, the input may carry the `itemId` of a queued board action, like `"pr-9488"`.

`--autonomous` marks an action nobody clicked. The routine passes it for every label and assign change it makes on its own. With it, only `label` and `assign` run, and `label` refuses any label outside the profile's `autoLabels`.

`--check-fresh` runs the same freshness check as a click on the board before the action. It needs the `itemId` of a board item and refuses when the thread moved since the review. `"force": true` in the input skips it, except for a moved head on a merge, an approval or a review with inline comments.

`--dry-run` validates the input, applies the account rules and runs the read-only lookups, like node ids and labels. It prints each write as the `gh` command, the account it would run as and the GraphQL body it would send on stdin.

## MCP server

The stdio server `gary` has one tool per GitHub action and three tools for the board server. In a plugin install Claude Code starts it from `.mcp.json`. For a clone, `setup` prints the `claude mcp add` command.

- `board_start` starts the board server inside this MCP process and returns its URL. When another process already serves the board, it returns `{ "running": true, "owner": false, "url": … }`. Calling it again is safe.
- `board_stop` stops the board server if this MCP process started it.
- `board_status` returns the URL, whether this process runs the board server, and whether the port answers like the board.

The master triage session calls `board_start` at the start of every run. Other sessions never start it on their own.

## Board server

```sh
node server/server.mjs              # start the board without a Claude session
node server/server.mjs --dry-run    # nothing is written to GitHub
node server/server.mjs --watch      # restart on edits in server/ and scripts/lib/
```

It listens on `127.0.0.1` at the `port` from `config.json`. `GARY_DRY_RUN=1` turns on dry-run mode for the MCP server too. `--port` and `--board-dir` override the port and the data directory for tests.

`GET /api/state` returns `board` next to the items: the project `name`, `repo` and `repoUrl`, `me` and `bot` with login and avatar URL (`bot` is `null` without one), `accountMode` (`bot`, `own` or `none`), `relatedRepos`, `botCommands` and `reviewBots`. The page gets the same object from `window.claude.use("board")`. Every served route carries `actor`, who acts after a click: `me`, `bot`, `own`, `agent` or `unavailable`. A move to a repository carries `actors` with one entry per button.

Edits reach open pages without a manual reload. When `board/board.html` changes, the server tells open pages to reload. A page with an open dialog or typed text waits and shows "Updated, reload" instead. After `board_start`, the MCP server watches `server/server.mjs` and `scripts/lib/*.mjs` and restarts the board server with the new code. When the new code fails to load, the old server keeps running.

The server can write to GitHub, so it locks itself down:

- On the first start it writes a random token to `state/server-token` with mode 600. The page gets the token inline. Every `/api` request must send it, except `GET /api/health`.
- It rejects any `Origin` other than its own and any `Host` other than `127.0.0.1:<port>` or `localhost:<port>`.
- It accepts only JSON bodies up to 256 KB and sends no CORS headers. It serves nothing besides the board page.
- The page runs under a strict Content-Security-Policy. Images may come only from GitHub, for the avatars.
- GitHub actions run one at a time per item, so a double click cannot run twice. Writes run one at a time per file.

## What a click can run

The page cannot send an arbitrary action. A click sends `{ itemId, routeId, text, draftHash, force, input }` to `/api/action`. The server reads the route from `state/board/items/<id>.json` and takes its type, actor, params and the target from there. `input` carries only what the maintainer chose on the card, like the checked review comments, the decision per review thread, the mode of a move or the rounds of a drive. The server checks every id and value in it.

- The draft hash covers the route's stored text, its params and the item's `reviewedAt`. When the routine rewrote the route after the page showed it, the server answers "The board is out of date, reload it."
- A route that already ran or was queued with the same draft is refused with 409.
- A route whose actor is `me` never reaches GitHub through the server: the page copies its text and opens the thread, and the maintainer acts there. That covers replies to people, every close and every merge. The one close the server runs is a `move` with `input.mode: "close"`, which posts the route's text and closes as not planned.
- A bot route runs after the click as the bot, or under the maintainer's login in `own` mode. An `unavailable` route is refused.
- An agent route writes a queued action doc. `drive` and `address_review` are refused unless the PR is by a maintainer, a bot or Copilot, or carries `takenOver: true`. Pushing our commits to a contributor's PR is always a take-over, so a `take_over` route carries the per-thread decisions there.
- `dismiss_route` removes one suggested route and remembers it with the reason. When it was the last route, a `reanalyze` request is queued so the agent proposes something else.
- Before a route that posts text, reviews, closes, reopens or transfers, the server reads the thread from GitHub. It refuses when the thread is in the wrong state, when a person commented or reviewed after `reviewedAt`, or when the PR head differs from `reviewedSha`. Bots do not count. "Post anyway" sends the click again past that check after a second confirm. A moved head still blocks an approval and a review with inline comments. The code is in `scripts/lib/guard.mjs`.
- The server writes one action doc per bot or agent click with `routeId`, `route`, `draftHash`, `edited`, the action it ran and the result.

## gary validate

`gary validate` runs the same validation over every stored item, read-only, and prints the problems grouped by rule. `gary validate pr-9488 issue-9401` checks only those. `--json` prints the result as JSON. It exits with 1 when an item fails.

## Learning

The board server logs where the maintainer deviates from the agent's proposals in `state/decisions.jsonl`: a dismissed route, another route than the recommended one, an edited text, a thread decision against the agent's verdict, an unchecked review comment, a note to the agent, a snooze. Routes he does on GitHub himself are reported by the page to `/api/decision`, which writes only that local log entry.

The `triage-learn` skill reads new entries with `gary decisions --since <ISO>`, writes rule proposals with `gary put proposals <id> <file>` and its cursor with `gary put learn <file>`. The board shows open proposals. Accepting one appends the rule under its heading in the profile's `rules/` or `templates/`, or in the home's `personal.md`, and commits that file when the profile is a git repository. It never pushes. Dismissing one stores the reason and logs it, so the pattern is not proposed again. Both work in dry-run mode, because they change only local files. `gary proposals` lists every proposal with its status.

A dismissed route goes into the item's `dismissedRoutes`, which the routine never clears. `gary put` refuses a doc that brings back a dismissed route type.

## Tests

```sh
npm test            # actions, server, accounts, learning, sharing, validate. Needs node and zsh
npm run test:page   # the board page, mocked and served. Needs Chrome or Chromium
```

The suites run offline. `test/fake-gh/gh` stands in for the `gh` binary on PATH, answers Gary's reads from `test/fixtures/github.mjs` and refuses every write. Each suite makes its own temp home with the fixture profile `test/fixtures/profile` (the project `acme/widgets`) and picks free ports, so they never touch a real home or a running board. `CHROME` names the browser binary for the page suites, default `google-chrome`. Avatars from github.com may fail to load offline, and the page suites accept the letter placeholder then.

## gary watch-queue

`gary watch-queue` prints one line like `{"id":"pr-9469-1763400000000","itemId":"pr-9469","action":"address_review"}` for every queued, unclaimed action, first the existing ones oldest first, then each new one as it is written. The master session runs it under Monitor. `--once` prints the current queue and exits.

## gary put

```sh
gary put items pr-9488 item.json           # the file is the complete item and replaces the stored one
gary put --merge items pr-9488 patch.json  # change only these fields, null removes a field
gary put items pr-9488 --delete            # remove the item
gary put meta meta.json                    # replace meta.json
```

A replace keeps the maintainer's `hidden` and `snoozedUntil`, and `priority` when the file has none. Every other field the file leaves out is gone afterwards.

Before every replace, and before a merge that touches `routes`, `threads`, `hint` or `findings`, it validates the item as it will be after the write, with the rules in SPEC.md under Validation. A broken rule refuses the write and prints every problem in `problems`. A warning, like an approval while a thread is judged valid, goes to stderr. `--no-validate` skips the check, for migrations.

It sends the write through the board server, so it queues behind clicks on the same item. When the server is not running, it writes the file directly with the same merge rules and says so on stderr. It prints `{ "ok": true }`, or `{ "ok": false, "error": … }` and exits with 1.
