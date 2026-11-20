# Gary: contract

Gary is maintainer triage for one GitHub repository. An hourly Claude routine reviews the open PRs, issues and discussions. It writes one briefing per item as a JSON file into a local store. A local Node.js server serves the board page from that store. The maintainer reads the board and clicks buttons. A click is the maintainer's approval. Only approved actions change anything public on GitHub, with the exceptions listed under Autonomy.

The examples below use the project `acme/widgets`, the maintainer `octocat` and the bot `widgets-bot`.

## Decisions

- **Runtime**: one master Claude session per machine. An hourly scheduled task posts ``Run the triage-master skill. Models come from `gary models`.`` into it. The master owns the one board server and the one queue watcher, and starts one worker per instance for the hourly triage and one per agent request. Workers report only through the instance's state directory. Classification, reviews, triage and fixes run in workers or subagents, so the master's context stays small across runs. Each of the three levels has its model set in `models`, see "Models".
- **Identity**: see Accounts. Gary's code reads the bot token from `bot.tokenFile` and sets `GH_TOKEN` itself. It never depends on a `gh` shell function or alias.
- **Scope**: all open PRs that are not drafts. Draft PRs are ignored entirely. Issues and discussions with activity in the last `activeWindowDays` days. Older ones appear only as a count.
- **Author tags**: `maintainer` (the profile's `maintainers` and `me`), `bot` (the profile's `botLogins`, the configured bot and every GitHub App), `copilot` (GitHub's Copilot coding agent), `contributor` (everyone else). All are included and filterable.
- **Review depth**: tiered. Every changed item gets a quick classification. Contributor PRs and active issues get a full review. The profile's `rules/review.md` names the project's own review skills and tools.
- **Budget per run**: at most `maxFullReviewsPerRun` full reviews and `maxAutoFixesPerRun` auto-fix attempts. Remaining changed items get `reviewDepth: "pending"`. At most `maxPendingAutoFixes` fixes the routine started on its own are pending at a time, see "Fix limit".
- **Autonomy without a click**: add and remove the labels in the profile's `autoLabels`, assign, and open draft fix PRs with a reproducing test where the project's `rules/issues.md` allows it. On Gary's own fix PRs, the ones recorded in `fixes.json`, and only there, three more things happen without a click when `fixReview` is on: requesting the Copilot review, pushing the commits of the review rounds to the fix branch with the replies in its review threads, and marking the PR ready for review. See "Fix review rounds". On every PR we watch, the bot's open PRs and the taken-over PRs, a round for the maintainer's review or comment starts without a click, and on the hourly run a round for other people's review comments: it pushes its fixes and replies in the threads. See "Watched PRs". Merging, approving and closing stay the maintainer's, on these PRs too. With `autoReview` on, one more thing happens without a click: a contributor's PR of a configured kind gets one review, see "Automatic first review". It is off by default. Everything else needs a click. The routine passes `--autonomous` to `gary action` for every label and assign change nobody clicked, and the code then refuses labels outside `autoLabels` and every other action.
- **Board server**: one `server/server.mjs` per machine serves every instance on `127.0.0.1` at the `port` from the root `config.json`. It runs inside the `gary` MCP server of the master session, which starts it with `board_start`, or standalone with `gary serve`. Other sessions leave it alone. It watches every instance's board store, picks up new instances without a restart and pushes changes to the open page.
- **Buttons**: a click on a bot route makes the server run it live through `scripts/lib/actions.mjs`. When GitHub cannot be reached, the action fails, the board shows the error, and the maintainer can click again. Agent requests are always queued.
- **Confirmation**: merge, close and any posting of public text need a second confirm click on the board.
- **Suggested text**: an editable textarea. The button posts the textarea content.
- **Project tools**: tools a project needs, like a log analyzer, are listed in the profile's `requiredTools`. The routine checks them at the start of a run.

## Layout

Gary has three layers, one place for each kind of change.

```
<core>/                  the tool itself. Nobody edits it to adapt the tool
  .claude-plugin/        plugin.json with the gary MCP server, and marketplace.json, so the repository is its own marketplace
  package.json           dependencies of the MCP server, with a lockfile
  bin/gary               the launcher, the one entry point for every command
  scripts/               Node ESM, no build step
    snapshot.mjs         gary snapshot
    board-put.mjs        gary put
    execute-action.mjs   gary action
    watch-queue.mjs      gary watch-queue
    pr-watch.mjs         gary pr-watch
    auto-review.mjs      gary auto-review
    api-edit.mjs         gary api-edit
    push-check.mjs       gary push-check
    setup.mjs            gary setup
    migrate.mjs          gary migrate
    serve.mjs            gary serve
    doctor.mjs           gary doctor
    models.mjs           gary models
    lib/                 paths and settings, gh wrapper, actions, freshness guard, board store
  mcp-server/index.mjs   stdio MCP server "gary"
  server/server.mjs      board server: serves the page, runs clicked routes, watches the board store
  board/board.html       the board page
  skills/                triage-master, triage-routine, triage-review-pr, triage-issue, triage-setup, triage-learn
  profiles/template/     the skeleton `gary setup` copies for a new project

<root>/                  $GARY_HOME, default ~/.config/gary/. Survives updates, nothing in it is shared
  config.json            the machine-wide settings: { "port": 7878, "models": { … } }, see "Models"
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
    opened.json          the `as: "me"` buttons he used, per item and route, see Routes
    failures.json        failed triage count per item, kept by the routine
    auto-reviews.json    the automatic reviews Gary posted and their format offers, see "Automatic first review"
    runs/<run>/          one directory per worker run, named by its UTC timestamp, which the master picks. summary.txt is the
                         worker's result, would-have.json the writes a paused run intended
    drive/<itemId>.json  a drive: its round state plus repo and number, which the queue watcher polls. On a watched PR it
                         stays after the review bot rounds, see "Watched PRs"

<profile>/               one directory per project, named by `profile` in config.json. A team can share it
  profile.json           facts the code needs
  rules/                 classification.md, voice.md, review.md, issues.md
  templates/             canned texts, like request-logs.md and reopen-elsewhere.md, the fixed texts of the automatic review
                         and api-edit.md, the comment after an API edit
```

The core contains no repo name, no account name and no absolute path. It works as a Claude Code plugin and from a plain git clone. In a plugin install Claude Code puts `bin/` on the Bash PATH and starts the MCP server from the `mcpServers` entry in `.claude-plugin/plugin.json`. For a clone, `gary setup` links the skills into `~/.claude/skills`, links the launcher into `~/.local/bin` and registers the MCP server with `claude mcp add --scope user gary`.

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
  "maxAutoFixesPerRun": 2,
  "maxPendingAutoFixes": 10,       // how many fixes the routine started on its own may be pending at a time. 0 turns automatic fixes off
  "fixReview": { "reviewer": "copilot", "requestAs": "me", "maxRounds": 3, "markReady": true },   // the review rounds a fix PR of Gary gets on its own, see "Fix review rounds"
  "fastTier": "off",               // off | shadow | on: whether simple items get a smaller model. shadow runs both and records them for `gary shadow report`
  "models": { "worker": "sonnet", "review": "opus", "standard": "sonnet", "fast": "haiku" },   // optional: the model per role for this instance, see "Models"
  "escalateAs": "prefill",         // prefill | me: who posts the profile's escalate command on a discussion, see "Escalate"
  "autoReview": { "enabled": false, "kinds": ["config"], "maxPerRun": 3 }   // the one review a contributor PR gets without a click, see "Automatic first review"
}
```

`profile` and `me` are required. The other fields have the defaults shown. `fixReview` has the default shown when the instance can push, with a bot or with `allowOwnTokenPushes`. Otherwise it is off. `reviewer` is `copilot` or `off`, `requestAs` is `me` or `bot`, `maxRounds` is 1 to 3, and fields left out take their default. A value outside these lists is an error. It is also off when the profile's `reviewBots` does not list `copilot`, or when `requestAs` is `bot` without a bot. `gary doctor` says which case holds. `autoReview` is off when the field is missing. `enabled` is true or false, `kinds` is a list that may only hold `config`, `maxPerRun` is 0 to 50, and fields left out take the default shown. It is also off without an account that may post, with a bot or with `allowOwnTokenPushes`, with `maxPerRun: 0`, and when the profile's `autoReviewPaths` names no paths for any of the `kinds`. `gary doctor` shows the setting and warns when it is on and cannot run. `escalateAs` is `prefill` or `me`, another value is an error, and `gary doctor` shows it and warns when it is `me` and the profile has no `botCommands.escalate`. Unknown fields are errors in `gary setup` and `gary doctor`, so typos get caught. Everywhere else they are only warnings, so settings written for a newer Gary do not stop an older one. A `port` in an instance config is an error that asks for `gary migrate`: the port lives in the root config.

Code looks up an instance through `loadInstance(name)`. Its allowed repos are the profile's one `repo`, and `allowedRepo(instance, repo)`, `checkoutFor(instance, repo)` and `rulesFor(instance, repo, topic)` answer per repo. For `maintainer` they return the configured checkout and the profile's `rules/<topic>.md`. The skills read that file directly.

### Models

Three levels of sessions run, and `models` names the model of each role:

```jsonc
{
  "master": "sonnet",     // the one master session. Root config only
  "worker": "sonnet",     // a triage-routine session, one per instance and per agent request
  "review": "opus",       // every subagent that reads code or writes text that gets posted
  "standard": "sonnet",   // the standard tier of the quick classification
  "fast": "haiku"         // the fast tier of the quick classification
}
```

The values shown are the defaults. The `review` role covers full PR reviews, full issue and discussion triages, fixes, every `triage-review-pr` mode (`address_review`, `take_over`, `revise`, `format`, `drive`, `offer-reply`) and the learn pass.

- **Layers.** `models` can stand in the root `config.json` and in an instance's `config.json`, each with any subset of the roles. Per role the instance's value wins, then the root's, then the default. `models.master` in an instance config is an error, because one master session serves every instance.
- **Values.** `master` and `worker` take an alias (`haiku`, `sonnet`, `opus`, `fable`) or a full model id that matches `^claude-[a-z0-9-]+$`. Both are sessions, and `claude --model` takes either. `review`, `standard` and `fast` take an alias only. They are subagents, and the Agent tool's `model` takes no full id. Another value is an error. An unknown role is an unknown field.
- **Who applies them.** The master starts each worker on the instance's `worker` model: `claude -p --model <worker> "<job line>"`, or the model option of the tool that starts a child session. A worker that only runs `triage-learn` starts on `review`. The worker passes `model` on every subagent start, with the value of the subagent's role. A skill the maintainer starts himself uses the same roles for its subagents. No job line and no scheduled-task prompt names a model.
- **The master's own model.** No skill can change the model of a running session. `models.master` is applied where the scheduled task or its thread is created: the `triage-setup` skill sets the model there when the host has a tool for it, or tells the maintainer which model to pick. The master compares its own model with `models.master` on every start and says so in its reply when they differ. `gary doctor` prints the value and cannot check it.
- **Fallback.** A `review` subagent that the provider's safety filter stopped is retried once on the `standard` model. The item then carries `analyzedBy: "fallback"` and a finding that says so. The finding says "smaller model" only when both are among `haiku`, `sonnet` and `opus` and `standard` comes earlier in that order. Otherwise it names the model. When `review` and `standard` are the same model there is no retry, and the item is blocked right away.
- **`gary models [--json] [--all]`** prints what applies. For the resolved instance: `{ instance, models, sources, fallback }`, where `sources` names the layer per role (`instance`, `root` or `default`) and `fallback` is `{ model, relation: "smaller" | "other" }` or `null`. With `--all`: `{ master, instances: { <name>: { models, sources, fallback } } }`, with `{ error }` for an instance whose config is invalid. The master reads `--all`, a worker reads its instance.
- **Visibility.** Every `summary.txt` a worker writes has a `Models:` line with the model each role really ran on, like `Models: worker claude-sonnet-4-5, review opus, standard sonnet, fast haiku.` The worker names its own model as its session reports it, and adds `(config: <value>)` when that is another model. Item docs get no new field: `classifiedBy` and `analyzedBy` stay as they are.

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
  "botCommands": { "escalate": "@widgets-bot escalate" },   // commands the maintainer posts himself. No bot-posted text may contain any of them. Only `escalate` has a route, and with `escalateAs: "me"` the board posts it under his login after his click
  "requiredTools": ["mcp__widgets-logs__loadLogFile"],   // checked at the start of a run
  "automatedComments": [           // comments a workflow posts on its own. They do not count as anyone's turn in the snapshot facts
    { "name": "logfile feedback", "pattern": "<!-- LOGFILE_COMMENT_TAG -->", "origin": "the workflow that posts it" }
  ],
  "aiAuthors": ["devin"],          // extra names of AI agents for facts.aiAuthored, matched as case-insensitive parts of a commit author's name or login
  "autoReviewPaths": { "config": ["config/devices/**"] },   // globs per kind of PR that may get an automatic review. A PR is of a kind when every changed file matches one of its globs
  "formatCommand": "npm run fmt"   // or null: the one-line command a contributor runs to format. The automatic review names it when it cannot offer to push
}
```

`name` and `repo` are required. Unknown fields are handled like in config.json. An `automatedComments` entry has `name`, `pattern` and an optional `origin`. `pattern` is a JavaScript regular expression of at most 500 characters, without flags, tested against the first 20000 characters of the comment body with leading white space removed. Validation compiles it and refuses one that does not compile or nests quantifiers like `(a+)+`. `autoReviewPaths` maps a kind to a list of globs. A kind this version does not know is an unknown field. `formatCommand` has at most 200 characters, one line, no backtick.

A long-running process, like the board server, keeps the last valid settings of an instance when its config.json or profile.json breaks. `loadInstance` then returns them with `settingsError` naming the problem, and `settingsWarnings` lists unknown fields. An instance whose settings were never valid in the process is listed by `listInstances` with `valid: false`, no repos and its `settingsError`, and serves no items.

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
- `gary put items <id> <file>`, `gary put --merge items <id> <file>`, `gary put items <id> --delete`, `gary put meta <file>`: write one board document through the board server, or directly when it does not run. Without `--merge` the file is the complete item and replaces the stored one. Only the maintainer's `hidden` and `snoozedUntil` carry over, and `priority` when the file has none. With `--merge` only the fields in the file change, and `null` removes a field. Both modes validate the resulting item, see Validation. A merge that touches none of `routes`, `threads`, `hint`, `findings`, `wants` and `wantsReason` is not validated. `gary put meta` checks `rulesHash` and `rulesPending`. `--no-validate` skips the check, for migrations.
- `gary validate [<id> ...] [--json]`: run the same validation over the stored items, read-only. Without ids it checks all of them and groups the problems.
- `gary action [--dry-run] [--check-fresh] [--autonomous] [file]`: run one GitHub action from a JSON file or stdin. `--autonomous` marks an action nobody clicked: only `label` within `autoLabels` and `assign` may run.
- `gary watch-queue [--all] [--once]`: print queued agent requests as JSON lines, `{ "instance", "id", "itemId", "action" }`. `--all` follows every instance, also ones added later, and is what the master runs. It also prints the drive events of "Fix review rounds" and "Watched PRs" and the `auto_review` lines of "Automatic first review".
- `gary serve [--watch] [--dry-run]`: run the one board server in the foreground.
- `gary migrate`: move instances to the single-server layout, see Instances. Safe to run again.
- `gary pause [--all]`, `gary resume [--all]`: set and clear the pause switch of the instance, or of every instance, see Pause.
- `gary models [--json] [--all]`: print the model of every role for the resolved instance, or the master's model and every instance's, see "Models".
- `gary instances [--json]`: list every instance with `name`, `kind`, `repos`, `title`, `checkout`, `paused`, `valid`, `served` (the board server lists it) and `current` (the working directory resolves to it), plus `settingsError` and `settingsWarnings` when there are any.
- `gary wants [--json]`: list, per item with `wants`, the labels to add, the labels to remove and the assignees to add that GitHub does not show yet, with `wantsReason`. GitHub's state comes from the labels and assignees in the staged snapshot, or in the baseline when nothing is staged. Items without a snapshot entry are listed as `unknown`. Read-only.
- `gary shadow record <file>`: append shadow comparison entries, one object or a list, to `<state>/shadow.jsonl`. Each is `{ at, run, itemId, repo, tier: "fast" | "standard", model, section, hasRoutes, recommendedType, handedUp, reason, sampled }`. `sampled` is optional, true for a pair the routine sampled in `on` mode. `section` and `recommendedType` may be null when the fast tier handed up, and only the fast tier hands up. An invalid entry refuses the whole file.
- `gary shadow report [--since <ISO> | --week] [--json]`: pair the latest fast and standard entry per run and item, and print the number of pairs and how many came from sampling, how often the fast tier handed up, the agreement on section and on the recommended route type over the pairs the fast tier answered, and every disagreement with both answers. It warns when the section agreement over the last 40 pairs the fast tier answered is below 95 percent. `--week` means `--since` 7 days ago.
  The second part, "Your decisions by tier", counts per `classifiedBy` value the items of that tier: board items reviewed since `--since` plus the items the decision log names with that tier since then. For each tier it counts the items with a `dismissed_route` of the recommended route, a `chose_alternative`, an `edited_text`, and any of the three, with rates. It says when a tier has fewer than 20 items. `--json` adds the item ids, under `decisions.<tier>`: `{ items, itemIds, tooFew, dismissedRecommended, choseAlternative, editedText, any }`, each count as `{ count, rate, itemIds }`. The pair counts are `sampledPairs` and `recentSectionAgreement: { pairs, same, share, warning }`.
- `gary shadow propose [--dry-run]`: write the setting proposal for `fastTier` when the numbers meet the bar, see "Setting proposals". It prints one JSON line, `{ ok, written, id, value, since, pairs, handedUp, answered, sameSection, sectionAgreement }`, or `{ ok, written: false, why, … }`. `--dry-run` prints the proposal as `proposal` and writes nothing.
- `gary shadow convert <id> [--dry-run]`: rebuild one fast tier proposal that was stored as a rule proposal, under the same id, see "Setting proposals".
- `gary decisions [--since <ISO>] [--json]`: print the decision log, see Learning. `--since` is exclusive.
- `gary claim <itemId> <fix|review|push> --run <run> [--ttl <minutes>] [--request <action id>]`: claim work on an item before starting it. It creates `<state>/claims/<itemId>.<kind>.json` exclusively with `{ run, at, expiresAt }`, default ttl 60 minutes, and exits 3 with the holder when another run holds an unexpired claim. The same run renews its claim, an expired claim is taken over. A `fix` claim without `--request` is the routine's own fix: it also exits 3 with the numbers when `maxPendingAutoFixes` fixes of the routine are pending, see "Fix limit". `push` covers take_over, revise, address_review, drive rounds and format. A `fix` claim also exits 3 while a fix PR for the item is a draft or open, and while a `start_fix` request other than `--request` is queued for it: a request worker passes the id of its own action doc. A refused claim needs no item doc: the caller skips the item.
- `gary release <itemId> <kind> --run <run>`: remove the claim when `run` holds it, exit 3 when another run does. Every exit of a job, also a failed one, releases its claims. A claim a crashed job leaves behind expires.
- `gary claims [--json]`: list the claims with `itemId`, `kind`, `run`, `at`, `expiresAt` and `expired`.
- `gary fix-record <itemId> --pr <number> --branch <name> --run <run> --by routine|maintainer`: record a fix PR Gary opened in `<state>/fixes.json`, `{ <itemId>: [{ number, url, branch, run, startedBy, at }] }`. The autofix skill calls it right after `gh pr create`.
- `gary fix-review start --pr <number> --sha <head sha> --run <run> [--dry-run]` and `gary fix-review finish --pr <number> --outcome done|stopped --reason <text> [--seen-me <ISO>] [--seen-others <ISO>] [--dry-run]`: start the review rounds of a fix PR Gary opened, and end each round on it, see "Fix review rounds". Both refuse a PR that is not in `fixes.json`, and both exit 4 and write nothing while the instance is paused. `--dry-run` prints the GitHub writes and the docs it would write.
- `gary pr-watch list [--json]`, `gary pr-watch round --pr <n> --by me|others --at <ISO> [--run <run>] [--dry-run]`, `gary pr-watch review --pr <n> --sha <head> [--action <id>] [--seen-me <ISO>] [--seen-others <ISO>] [--dry-run]` and `gary pr-watch done --pr <n> --sha <head> [--seen-me <ISO>] [--seen-others <ISO>]`: the watch on the bot's PRs and the taken-over PRs, see "Watched PRs". Each refuses a PR that is not watched. Exit 3 means a rule refused, exit 4 that the instance is paused.
- `gary auto-review check|post|accept|reply|rerequest|list`: the one automatic first review on a contributor PR and its format offer, see "Automatic first review". Exit 3 means a rule refused, exit 4 that the instance is paused.
- `gary api-edit --pr <n> [--route <id>]` and `gary api-edit --pr <n> --sha <head sha> --file <route.json>`: check the API edit of a `take_over` or `revise` route against GitHub and print what the click would commit, see "API edit". The first form reads the route from the stored item, the second a draft route `{ params, text }` before it is stored. It prints `{ ok, dryRun, message, files, diff, invocations }` or the refusal as `{ ok: false, result }`, and exits 1 on a refusal and 4 while paused. It has no mode that commits: only the click on the board does.
- `gary push-check --pr <n> [--sha <head sha>] [--repo <owner/name>]`: say from GitHub's state right now whether an agent may work in a checkout of the PR and push to it, see "PRs that are ours alone". It prints `{ ok, pr, repo, headSha, sensitiveFiles, sensitiveOurs, refused }`. The exit code is 0 when the push is allowed and 3 when it is refused. Three things are refused: a PR that is not open, a head other than `--sha`, and a PR with sensitive files that is not ours alone. It reads every changed file of the PR, also beyond the snapshot's first 50. It writes nothing.
- `gary fixes [--json]`: the fix state of every issue and discussion on the board, in the records or with fix PRs in the snapshot, as `{ <itemId>: fix }`, see `fix` under the item doc.
- `gary handled [--json]`: list the items with `handled`, each with `id`, `repo`, `kind`, `number`, `handled`, `live` and `changedSince`: true when the staged snapshot entry, or the baseline when nothing is staged, has an `updatedAt` or a newest timeline event later than `handled.at`, false when not, null without an entry.
- `gary proposals [--json]`: list every proposal with its status and dismissal reason.
- `gary put proposals <id> <file>`: write one proposal, validated. `gary put learn <file>`: write the learn cursor.
- `gary paths`: print JSON with the keys `instance`, `root`, `home` (the instance directory), `config`, `personal` (a list, the shared file first), `profile`, `state`, `checkout` and `core`. Without a resolvable instance it still prints `core` and `root`, adds `error` and exits with 2. `gary paths --root` prints only `core` and `root` and works from any directory.
- `gary setup`: create an instance with `config.json` and `state/`, and the shared `personal.md` when it is missing. It asks in a terminal and takes flags in a script: `--instance` (default the repository name in lower case), `--repo`, `--me`, `--checkout`, `--profile`, `--name`, `--bot-login`, `--bot-token-file`, `--no-bot`, `--port`, `--force`, `--no-links`, `--register-mcp`. It runs `gary migrate` first. `--port` sets the one server's port in the root config. It refuses a second instance for the same repository or checkout. A new project gets a profile copied from `profiles/template/` into `<root>/profiles/`. It never replaces an existing `config.json` without `--force` and never touches an existing `personal.md`.
- `gary doctor [--all]`: read-only checks of the resolved instance, or of every instance: Node, `gh`, the stored `gh` login against `me`, the bot token against `bot.login`, the profile, the checkout, the pause, the root port and whether the board server there lists this instance, the fast tier, the models per role (it prints `master` without checking it), the fix review rounds, the automatic review, the skill links and the launcher. Unknown fields in config.json or profile.json fail the profile check.

Environment: `GARY_HOME` moves the root, and `GARY_INSTANCE` picks the instance. `GARY_DRY_RUN=1` makes the board server and the MCP server run without GitHub writes. `GARY_GUARD_STUB` replaces the freshness read in tests.

## Accounts

`me` is the maintainer's GitHub login. `gh` acts for him with the login stored by `gh auth login`. `bot` is a second account with its own token, or `null`. The account mode follows from the config:

- `bot`: a bot is configured. Every GitHub write of Gary's code runs as the bot.
- `own`: no bot, `allowOwnTokenPushes: true`. Bot routes without a prefill run under the maintainer's stored login after a check that this login is `me`.
- `none`: no bot, `allowOwnTokenPushes: false`. Gary's code writes nothing to GitHub, except `request_review`.

Rules:

- Without a bot, every route that would run as the bot becomes prefill for the maintainer where a prefill exists: reply, request_logs, reopen, a follow-up issue, a review body, the close of a move. Routes without a prefill (inline review comments, transfer, chores) are offered only in `own` mode, and the card shows his avatar.
- Agent routes that push (`address_review`, `take_over`, `revise`, `drive`, `format`, a fix) need the `bot` or `own` mode. Otherwise the routine does not offer them and the server refuses them. The same holds for the API edit, which the server commits itself.
- `request_review` with `reviewer: "copilot"` runs under the maintainer's login in every mode, after the check that the login is `me`. The helper in `scripts/lib/gh.mjs` sends only that one mutation.
- With `escalateAs: "me"`, a click on the escalate button of a `move` to `issue` route posts the profile's `botCommands.escalate` on the discussion under the maintainer's login, in every mode, after the same login check. See "Escalate". With a bot configured, these two helpers are the only code that reaches his login.
- No text the bot posts may contain a command from `botCommands`. The escalate button is the only place a command is posted, and it posts as the maintainer.

## Pause

`gary pause` stops every write to GitHub of one instance at once while the board stays up, `gary pause --all` of every instance. It sets `paused: true` in the instance's `<state>/control.json`, and `gary resume` sets it to `false`. The file lives outside `config.json`, so a change needs no restart, and every check reads it fresh.

While paused:

- the server refuses every click that would write to GitHub with `{ ok: false, result: "Gary is paused. Nothing was sent.", paused: true }`, and writes no action doc,
- `gary action` refuses every action with the same result, also with `--dry-run` and `--autonomous`,
- agent routes are still queued, but `gary watch-queue` and `gary watch-queue --all` print nothing of that instance, so the master session starts nothing for it. The requests appear when the pause ends,
- `gary auto-review post` posts nothing and records the step in the run's `would-have.json`. `accept`, `reply --agrees yes` and `rerequest` queue nothing and exit 4,
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
- A card whose action is done collapses on its own, once, at the moment the state arrives: a bot route that ran, an agent route that was queued or taken, and a used `as: "me"` route. Its header row then shows a check and the confirmation on the right: "Done · view on GitHub" with the link, "Requested", "The agent took this on", or "Copied and opened, 21:42". The row is muted and has no dismiss "x". No other card opens in its place. He can expand it to see what was sent, read-only. A card he expands afterwards stays open, and on a fresh page load done cards start collapsed. A failed or refused action never collapses. A used `as: "me"` card with an unused label or answer button stays expanded until he closes it, and a done label or answer shows in the collapsed header as words, like "Label added".
- A finding with `routeId` belongs to that route. The card shows the finding as its reason. Findings without `routeId` stay in the collapsed findings list.
- Routes never contain "hide", "dismiss" or "snooze". The dialog footer has those.
- "Analyze again" is a footer action next to Snooze, never a route. A click reveals a full-width note field of 3 to 4 rows and a send button.
- A card can have more than one button. Each button shows who acts. A card with buttons for different actors shows no actor on its header.
- A route without inputs (no text, no choices) is a compact row. The row carries the button. It does not expand.
- Canned texts come from `<profile>/templates/<name>.md`. The agent copies the template into the route's `text` and adapts it. The text stays editable on the card.

| type | allowed `as` | params | what the click does |
| --- | --- | --- | --- |
| `reply` | `me` (default), `bot` | `alsoLabel`: `{ add, remove }`, optional | `me`: copy `text`, open the thread. `bot`: post `text`. With `alsoLabel` see below |
| `request_logs` | `bot`, `me` | `alsoLabel`, as for `reply` | post `text`, a request for logs or details (template `request-logs`). `me` is accepted in every account mode and is always prefill |
| `close` | `me` | `reason`: `completed`, `not_planned`, `duplicate`. `duplicateOf`: number, with `duplicate`. `alsoAnswer`: `{ commentId, url, gist }`, discussions only | copy `text` when present, open the thread. He closes there with that reason. For a PR there is no reason. With `alsoAnswer` see below |
| `reopen` | `bot` (default), `me` | | `bot`: reopen, and post `text` first when present. `me`: copy `text`, open the thread |
| `merge` | `me` | | copy `text` when present, open the PR page |
| `review` | `bot`, `me` (in every account mode, always prefill of the body, no inline comments) | `event`: `approve`, `request_changes`, `comment`. `comments`: `[{ id, path, line, startLine, text, diffHunk, original, suggestion }]`. `diffHunk` holds the at most 12 diff lines the comment refers to, starting with its `@@` header, shown on the card and never sent to GitHub. A comment that proposes a change carries `suggestion`, the replacement text without a fence, and `original`, the exact text of lines `startLine`..`line` (or `line` alone) of the file at `reviewedSha`, joined with newlines. The server composes the GitHub body from `text` and `suggestion`. `line` is on the right side of a diff hunk at `reviewedSha`. `startLine` is optional, for a range | submit one PR review with `text` as the body and the checked `comments` inline |
| `address_review` | `agent` | | offered only where `drive` is: on PRs by a maintainer, a bot or Copilot, and on contributor PRs with `takenOver: true`. These are the PRs we control. Pushing our commits to any other contributor PR is always a take-over. Also offered only when every open thread has a verdict, and when the bot cannot push to the branch only if no thread needs a fix. The agent fixes or dismisses each open review thread per the maintainer's decisions, replies in each thread, resolves it and pushes to the PR branch |
| `follow_up` | `agent`, `bot`, `me` | `title` for an issue | `agent`: queued as `start_fix` with the route's `text` as instructions and `params.finding`. `bot`: file an issue with `title` and `text`, then link it in the thread. `me`: open GitHub's new-issue form with `title` and `text` filled in |
| `take_over` | `agent`, or `bot` for an API edit | `mode`: `push` (default), `replace`. For an API edit `via: "api"`, `edits` and `message`, see "API edit" | `push`: the agent finishes the PR in the contributor's PR with our commits, pushed as the bot. `replace`: it opens a replacement PR. `replace` is the exception and needs a `callout` that says why pushing is not possible. Only for contributor PRs that are not taken over (`takenOver` is not true). On every PR where `drive` is allowed, `take_over` is invalid: the validator rejects it and the server refuses the click, and changes there go through `revise`. On a contributor PR that is not taken over, open review threads are handled by a `take_over` with mode `push`, with the same per-thread decisions as `address_review`. After a take-over the item carries `takenOver: true`, and from then on `address_review`, `drive` and `revise` are allowed and `take_over` is not |
| `revise` | `agent`, or `bot` for an API edit | none. For an API edit `via: "api"`, `edits` and `message`, see "API edit" | the card and its button are called "Change". The agent changes a PR we already control by the instructions in `text` and pushes to the PR branch, as the bot or, with `allowOwnTokenPushes`, under the maintainer's login. `text` is required: it holds the agent's proposal, and the maintainer can edit it on the card. No params and no `mode`. It never opens a replacement PR and never sets `takenOver`. Offered exactly where `drive` is: on PRs by a maintainer, a bot or Copilot, and on contributor PRs with `takenOver: true`. It carries no thread decisions: open review threads stay with `address_review` and `drive`. Like a take-over it never merges, approves, closes or marks the PR ready, and it may set the PR title |
| `drive` | `agent` | `maxRounds`: 1 to 3, default 3 | the agent drives the PR on its own: address the open review comments by its own verdicts, push, request a Copilot review, wait for it, repeat. It stops when no valid comment is left, after `maxRounds`, or when it is stuck. Offered only on PRs by a maintainer, a bot or Copilot, and on contributor PRs with `takenOver: true` |
| `format` | `agent` | | no text, no params, no input. Applies the project's autofix to the PR branch and pushes the result, as the bot or, with `allowOwnTokenPushes`, under the maintainer's login. Offered on any open PR whose `autofix` has `changes: true`, also on a contributor PR that is not taken over: running the project's own formatter is not a take-over, so neither `takenOver` nor the push rule of `address_review` and `drive` applies, and it never sets `takenOver`. Without a bot and without `allowOwnTokenPushes` it is unavailable |
| `move` | per button | `to`: a name from `relatedRepos`, `discussion`, or `issue` | Repo name, on an issue: two buttons, both bot. "Transfer" moves the issue. "Close, ask to reopen there" posts `text` (template `reopen-elsewhere`) and closes as not planned, for issues that lack the info the other repo needs. `discussion`, on an issue: `me`, opens the issue, he converts it there. GitHub has no API for it and it needs no reply. `issue`, on a discussion: `me`, copies `botCommands.escalate` and opens the discussion. With `escalateAs: "me"` a primary button posts the command under his login, see "Escalate". Optional `issueKind`: `bug` or `enhancement`. Without that command there is no such route |
| `open` | `me` | | no text, no params. Opens the thread on GitHub. For items the agent could not analyze, see `blocked` |
| `chore` | `bot` | `action`: `label`, `assign`, `ready`, `answer_discussion`, `react`, `update_branch`, `rerun_ci`, plus that action's params | run the action |

The click sends `{ itemId, routeId, text, draftHash, force, input }` to `/api/action`. The server reads type, actor and params from the item file. `input` carries what the maintainer chose on the card:

- `review`: `{ commentIds: ["c1", "c3"], commentTexts: { "c1": "…" }, event }`. `commentIds` are the checked inline comments. All are checked by default. `event` is optional: the card has a switch "Request changes | Comment | Approve", preset from `params.event`, and sends his pick when it differs. The server uses it in place of `params.event`, refuses an `approve` that carries a checked comment with a `suggestion`, and logs a `changed_event` decision. The card of a PR by the bot itself has no switch, because GitHub lets the bot only comment there. `commentTexts` is optional and maps a comment id to the words the maintainer wrote in place of the agent's. Each inline comment on the card has an "Edit" link that turns its words into a textarea, and "Reset" brings the agent's words back. The suggestion, the path and the lines cannot be edited. The page keeps an edit like a step draft, under `<item>|<route>#c:<comment>|<draftHash>`, and sends it only for a checked comment. The server takes `commentTexts` only on a `review` route, refuses an unknown id, an empty text, more than 65536 characters and a text with its own suggestion block, and drops the edit of an unchecked comment and one equal to the agent's words. The posted body is the trimmed edit followed by the comment's unchanged suggestion block. The bot command check of `gary action` covers it like every posted text. Each used edit is logged as `edited_comment`. A review with `as: "me"` copies only the summary, so its card has no "Edit" link.
- `address_review`: `{ decisions: [{ threadId, decision: "fix" | "dismiss", note }] }`. The card lists the item's `threads`. Each switch starts from the agent's verdict: only `valid` starts on `fix`, `optional`, `wrong` and `unjudged` start on `dismiss`. `note` is optional per thread. `text` is an optional note for the whole run.
- `take_over`: `{ decisions }`, the same as for `address_review` and validated the same way. Optional: a take-over without open threads sends none.
- `revise`: no input. The click's `text` holds the instructions, and the server refuses a click whose `text` is empty.
- `take_over` and `revise` as an API edit: no input and no thread decisions. The click's `text` is the optional note for the contributor.
- `follow_up`: `{ title }` when the maintainer edited it. With `as: "agent"`: `{ askReporter: true | false }` from the card's switch "Ask the reporter to test". It is off by default. The route may preset it with `params.askReporter: true` and a `params.askReporterWhy` of at most 200 characters, shown next to the switch. The server stores the boolean as `params.askReporter` on the `start_fix` action doc, false when the input has none. Both params are valid on this route only.
- `drive`: `{ maxRounds }`, 1 to 3, when the maintainer changed it.
- `move` to a repo: `{ mode: "transfer" | "close" }`. Required. `close` needs a non-empty `text`. The two buttons share one route, so after one ran the other is refused.
- `move` to `issue`, the escalate button: `{ mode: "escalate" }` and nothing else, with an empty `text`.
- `reply` and `request_logs` with `alsoLabel`, run as the bot: `{ alsoLabel: true | false }`, default true. True sets the labels right after the post succeeded, in the same click.
- The label button of a `reply` or `request_logs` route with `alsoLabel`: `{ part: "label" }` and nothing else, sent without `text` and `draftHash`.

`alsoLabel` holds the labels a reply or log request also sets, like `{ "add": ["needs-info"] }`. Every label is one of the profile's `autoLabels`, at least one is named, and none is in both lists. When the maintainer posts the text himself, the card shows a second button next to the copy button. That button runs the `label` action with exactly the route's `alsoLabel`, as the bot, or under his own login in `own` mode. It is refused without a bot and without `allowOwnTokenPushes`, while paused, when the settings are invalid, and when the thread is closed or merged. Newer comments do not block it. It has its own done state: the served route carries `labelDone: { status, result }` next to `done`, and a repeat answers 409. Its key is the labels and the item's `reviewedAt`. Its action doc has `part: "label"`, `labelHash`, `action: "label"` and the labels as `params`, and no `draftHash`. The button logs no decision. A bot route that also set labels records them in its action doc as `label: { params, status, result }`. A label failure after a successful post keeps the click done and answers `{ ok: true, result, warning: "Posted. The label could not be set: …" }`.

`alsoAnswer` names the comment a discussion close also marks as the answer: `commentId` is its node id, `url` its URL in the discussion, `gist` at most 200 characters of what it says. The card shows a second button next to the copy button, sent as `{ input: { part: "answer" } }` without `text` and `draftHash`. It runs `answer_discussion` with exactly the route's `commentId`, as the bot or under his own login in `own` mode, and has the same rules as the label button, except that a closed discussion does not block it. The served route carries `answerDone: { status, result }`, its action doc has `part: "answer"` and `answerHash`.

### Escalate

A discussion becomes an issue when the maintainer comments the profile's `botCommands.escalate` there. The repo's own workflow then creates the issue and closes the discussion. Such a workflow ignores comments by the bot account, so the comment has to come from his own login.

The `move` route with `to: "issue"` is for two cases. A confirmed bug in a discussion gets it as the recommended route, titled like `Move: escalate to a bug issue`. A feature request or an idea that is concrete and plausible enough to track gets it titled like `Accept: track as an enhancement issue`, as an alternative next to the recommended reply or close, or as the recommended route when the request is clearly good. `params.issueKind` is `bug` or `enhancement` and only words the card: "The discussion becomes an enhancement issue". Gary sets no label. The repo's workflow picks it. The route is never written for a closed or already escalated discussion, and never without `botCommands.escalate`.

The card is a compact row. With `escalateAs: "prefill"`, the default, it has one button, "Copy escalate command, open GitHub", and nothing reaches GitHub through the server. With `escalateAs: "me"` it has a primary button, "Accept as an issue" for an enhancement and "Escalate to an issue" otherwise, and a secondary "Copy command, open GitHub". The primary button asks for a second confirm that names the command, like "Confirm: post @widgets-bot escalate as you". It then sends `{ itemId, routeId, draftHash, force, input: { mode: "escalate" } }` to `/api/action`.

This is the one exception to "replies in his name are prefill only". The server posts the comment under the maintainer's stored `gh` login, and these rules hold:

- Only this click posts a command. `escalate` is no action of `gary action` or the MCP server, so no agent and no `--autonomous` call can run it. `postEscalateCommand` in `scripts/lib/gh.mjs` is the only code that posts a bot command, and the server calls it from one place.
- The text is exactly `botCommands.escalate` from the profile, read on the server. Nothing from the request or the item goes into it. A click with a non-empty `text` or with another input field is refused.
- The server refuses the click when `escalateAs` is not `me`, when the profile has no escalate command, when the item is no discussion, while the instance is paused, when the settings are invalid, when the draft is outdated, and when the route already ran (409).
- Before the post the server reads the discussion from GitHub. A closed discussion is refused, also with `force`. A comment by a person after `reviewedAt` is refused with "Post anyway", like for a bot reply.
- The helper checks that the stored login is `me` and that the discussion is open, then sends one `addDiscussionComment` mutation. When GitHub refuses the comment because the login lacks the permission, the refusal says so and names the copy button, which keeps working.
- With `--dry-run` the helper runs the checks and the reads, and the result shows the invocation it would send.

A post that ran writes an action doc with `action: "escalate"`, `route: "move"`, `text` (the command), `as` (the login), `params: { to: "issue", issueKind }` and the comment's URL as `result`. A failed post writes it with `status: "failed"`, and the button works again. A successful one logs an `escalated` decision, sets `handled` with `verified: "commented"` and serves `done` on the route, so the row shows "Done · view on GitHub" and the item moves to "Handled, waiting for the next run". The next snapshot drops the discussion once the workflow closed it.

While a pushing agent job runs on a PR (`take_over`, `revise`, `address_review`, `drive`, also a drive that waits for a review bot between rounds, `format`, a round of a watched PR), every route that decides the PR on its current state answers 409 "The agent is changing this PR. Decide after it is done.": `review`, `merge`, `close`, a `chore` with `action: "ready"`, and the pushing routes `address_review`, `take_over`, `revise`, `drive` and `format`. Replies, request_logs, labels and other chores stay allowed. The block ends when the job's action doc is `done` or `failed` and no `push` claim is left. A watched PR that only waits for the maintainer's feedback, with its drive file in the stage `watch`, blocks nothing. A click on any agent route answers 409 "The agent is already working on this." while an unexpired claim of its kind or a queued or claimed request of the same kind exists for the item.

A stored `take_over` route with mode `push` on a PR where `revise` is allowed is served and run as `revise`: the served route has `type: "revise"`, a title that starts with "Change" where the stored one starts with "Take over", and the same id, text, params and draft hash. The item's served `hint` follows the title when the route is the recommended one. A click on it queues a `revise` action, and `handled.routeType`, the decision log and a dismissal name `revise`. The server never rewrites the stored route. The next triage does that, and `gary validate` reports such an item until then. A stored `take_over` with mode `replace` on such a PR is served as it is and its click is refused.

A `follow_up` with `as: "agent"` (Start fix) on an issue or discussion whose `fix` state is `working`, `draft` or `open` answers 409 with a message that names the running job or the PR, also when the item file still has the route.

The server checks every id and value in `input` against the route and the item. It refuses a route whose actor is `me` or `unavailable`, every merge, and a route that already ran or was queued with the same draft (409). The draft hash covers the route's stored text, its params and the item's `reviewedAt`. When the routine rewrote the route after the page showed it, the server answers that the board is out of date.

Before a bot route that posts text, reviews, closes, reopens or transfers, the server reads the thread from GitHub. It refuses when the thread is in the wrong state, when a person commented or reviewed after `reviewedAt`, or when the PR head differs from `reviewedSha`. Bots do not count. "Post anyway" sends `force: true` after a second confirm. A moved head still blocks a merge, an approval and a review with inline comments.

Routes with `as: "me"` never reach GitHub through the server and get no action doc. The one exception is the escalate button, see "Escalate". When the maintainer uses a prefill, the page reports it to `POST /api/decision`, and the server writes a local entry in the decision log (see Learning).

The server also keeps every such click per item and route in `<state>/opened.json`: `{ <itemId>: { <routeId>: { at, draftHash, text } } }`, with the text he copied. A click on another route of the item adds to it, and a repeat on the same route replaces its entry. The server serves the mark on the route as `opened: { at }` while the stored `draftHash` equals the route's current draft hash. So a triage that rewrites the route or reviews the item again clears it, like `done`. A click also drops the item's stored marks whose draft is gone. The mark survives a reload and every other click on the item.

The card of a used `as: "me"` route says so in words where a bot card says "Done": a check and "Copied and opened on GitHub, 21:42", or "Opened on GitHub, 21:42" when the button copies nothing. Its button turns into a secondary "Copy again" or "Open again" that still works, and the collapsed card header carries the same check. It never says "Done", because he may have copied the text without posting it. This holds for every `as: "me"` route: `reply`, `request_logs`, `review`, `close`, `merge`, `reopen`, `follow_up`, `move` and `open`.

`dismiss_route` removes a suggested route the maintainer does not want: `{ itemId, routeId, text }` to `/api/action`, with `text` an optional reason of at most 500 characters. The server removes the route from the item and appends `{ type, title, reason, at }` to the item's `dismissedRoutes`. When the removed route was the recommended one and routes remain, the first remaining route becomes recommended and `hint` becomes its title. When no route remains, the server also writes a queued `reanalyze` action doc whose `text` names the dismissed route and the reason, so the agent proposes something else. The dismissal is logged as a done action doc with `via: "board"` and in the decision log.

### API edit

A PR that changes a file matching the profile's `sensitivePaths` gets no agent in a checkout of its branch. Such files are agent instruction files, workflows, lint configs and manifests. An agent in that checkout would load instructions or run code the contributor wrote. So `address_review`, `drive`, `format` and the checkout forms of `take_over` and `revise` are refused there: by the validator, and by the server at the click when the item file still offers one. The one exception is a PR that is ours alone, see "PRs that are ours alone" below.

The API edit is the one push such a PR can get. It is a `take_over` (contributor PR that allows edits by maintainers) or a `revise` (PR we control) with `as: "bot"` and these params:

```jsonc
{
  "id": "r1", "type": "take_over", "as": "bot", "title": "Take over: fix the Discord link", "recommended": true,
  "params": {
    "via": "api",
    "message": "docs: fix the Discord invite link",   // the commit message, one conventional commit line
    "edits": [                                         // the exact change, written out at review time
      { "path": "CONTRIBUTING.md", "original": "Join us on Discord: https://discord.gg/wrong", "replacement": "Join us on Discord: https://discord.gg/right" }
    ]
  },
  "text": "Is the old server gone for good?"          // optional: a note or question for the contributor, added to the comment
}
```

`original` is the exact text of whole lines of the file at `reviewedSha`, like the `original` of a review comment. `replacement` is their full replacement. Neither ends with a line break. The route exists only when every change we would make is such a replacement. It is offered only on PRs with sensitive files that are not ours alone. Every other PR keeps the checkout forms. The validator refuses the API form there.

Limits. The validator checks the ones that need no GitHub read. The code that commits checks all of them again:

- At most 5 edits in at most 3 files and at most 40 changed lines in total. An edit counts the larger of its replaced and its new line count. `original` and `replacement` have at most 4000 characters each. The numbers are `API_EDIT_LIMITS` in `scripts/lib/api-edit.mjs`.
- No path matches `sensitivePaths`, compared with and without regard to case. A path under `.github/` or `.git/` is refused whatever the profile lists. So is an absolute path, a path with `..`, `.`, an empty segment, a backslash or a control character.
- Every path is an existing regular file at the PR head, mode `100644`. A missing path, a symlink, a directory, a submodule, an executable file, a binary file and a file too large for the API to return as text are refused. So the commit creates, deletes and renames nothing and changes no mode.
- `original` occurs exactly once in the file at the head, as whole lines. Two edits of one file do not overlap. `replacement` is not empty and differs from `original`.
- No `replacement`, path, `message` or note contains a `botCommands` string.
- `message` matches `<type>(<scope>): <text>` with a type of `fix`, `docs`, `chore`, `feat`, `refactor`, `test`, `style` or `perf`, has at most 72 characters and one line, and holds no `@`, no marker that skips CI like `[skip ci]` and no closing keyword like `closes #12`.
- `reviewedSha` is a full 40-character SHA.

The click needs a second confirm and runs on the server, with no agent. The server first reads the thread like for every bot route that posts. A person's comment or review after `reviewedAt` is refused with "Post anyway". A head other than `reviewedSha` is refused. No force passes it. Then `runApiEdit` in `scripts/lib/api-edit.mjs`:

1. checks the pause, the account mode and all limits above,
2. reads the PR and refuses one that is not open, whose head differs from `reviewedSha`, whose head repository is gone, a fork PR without `maintainerCanModify`, and a PR of the repo whose head branch is the base repository's default branch or the PR's own base branch. The target is always the PR's `headRefName` in its `headRepository`, both read from the PR,
3. reads each file as text at that SHA with one GraphQL query (`Commit.file`) and compares the git blob hash of the text with the blob's id. A match proves that the text is the file byte for byte,
4. applies the replacements in memory,
5. sends one `createCommitOnBranch` mutation with `expectedHeadOid: reviewedSha`, the message and the full new content of each edited file as `additions`, and no `deletions`. GitHub creates the commit and moves the branch in one step. It refuses when the branch no longer points at that SHA. The mutation cannot force-push,
6. posts one comment on the PR: the profile's `templates/api-edit.md` or the default "I pushed a small text fix to this PR: {commit}", with `{commit}` and `{files}` filled in, then the route's `text`.

Nothing is checked out, no code from the PR runs and no formatter runs. Commit and comment go out as the bot, or under the maintainer's login in `own` mode. CI is not waited for.

`createCommitOnBranch` was chosen over the git data API (blob, tree, commit, ref update). It is one request where that needs four. Its `expectedHeadOid` is exactly the check "fail when the branch moved", built in. A refused commit leaves no objects behind. It takes only additions and deletions of files. It cannot move another ref or write a tree entry with a mode. One thing is not yet tried against GitHub: the mutation on a fork's branch with the bot's token, where the push right comes from `maintainerCanModify`.

After the commit the server:

- writes the action doc with `action: "take_over"` or `"revise"`, `via: "server"`, `status: "done"`, the commit URL as `result`, `resultParts: { commits: [url], threads: [] }` and `commentUrl`,
- sets `pushed: { action, sha, at }` on the item, adds the link "Our commit", and sets `takenOver: true` for a `take_over`. `reviewedSha` stays the old head. Every route that is bound to the reviewed code is therefore refused until the review ran,
- queues a `full_review` with `params: { repo, number, by: "api_edit", pushed: { action, sha } }`. The card that decides the PR on the new head then appears without waiting for the hourly run,
- marks the item handled.

A failed commit writes the doc with `status: "failed"` and changes nothing else. The button works again. A comment that fails after the commit keeps the click done and answers with a `warning`. With `--dry-run` the reads and checks run, the answer holds the two invocations, and neither the item nor the queue changes.

What makes this safe on a PR with sensitive files:

- No process ever has the PR's tree on disk. The danger of such a PR is an agent or a tool that loads its files. The API edit reads at most 3 files as text through the API and never the sensitive ones.
- The edits are untrusted. An agent that read the PR's content wrote them. That content may try to steer it. So the guard is the code: the path rules, the size caps and the exact-once match run in the validator and again right before the commit, on the files as they are at the head. The agent's judgement is no guard.
- The maintainer sees the exact diff on the card and confirms it. Nothing here runs without his click. No command line or MCP tool commits an API edit: `gary api-edit` only checks.
- The commit can only change text inside files that already exist outside the sensitive paths. It cannot touch a workflow, an agent instruction file, a manifest or a symlink. It cannot add a file an agent or a build would pick up.
- The branch is the PR's own head branch and never the default branch. It moves only from the reviewed commit.

What it does not do: it does not make the PR's sensitive changes safe. Those still need the maintainer's own review before a merge. After the API edit no agent may check out the branch either. A PR can also add a symlink that points to a file the API edit changes. The edit then shows up under that name too, with the text he confirmed.

### PRs that are ours alone

The push refusal exists because of content from outside accounts. A PR that only the maintainer and the bot wrote has none. Example: Gary finds a bug in `.github/bot-scripts/escalate.cjs` and recommends the fix. Its agent opens the fix PR as the bot. That PR touches `.github/`. Every line on its branch is ours.

A PR with sensitive files is ours alone when all of these hold. The snapshot computes them in code, in `oursAlone` in `scripts/lib/facts.mjs`. An agent's claim never counts.

1. The head branch is in the base repository (`isCrossRepository` is false). A fork PR is never ours.
2. The PR's author is the configured bot or the maintainer, the `me` of `config.json`. Other logins in the profile's `maintainers` do not count.
3. The commit list is complete. The snapshot reads the first 100 commits. A PR with more is not ours.
4. The bot or the maintainer authored every commit. The author is the account GitHub resolves for the commit.
5. The bot or the maintainer committed every commit. GitHub itself also counts as the committer: `GitHub <noreply@github.com>` with a valid signature that GitHub made (`signature.wasSignedByGitHub`). GitHub commits that way for what its API and its web pages create. The author is then the account that asked.
6. Every `Co-Authored-By` trailer names the maintainer, the bot, an AI agent or a bot. The test for an AI agent or a bot is the one of `facts.aiAuthored`. These are our own agents. Any other co-author makes the PR not ours. GitHub writes such a trailer when someone applies a contributor's suggestion.
7. A PR by the bot is recorded in `fixes.json`. That makes it a fix PR Gary opened. A PR by the maintainer needs only 1 to 6.

A trailer counts as the maintainer's or the bot's in three cases: its name is that login, its email is that login's GitHub noreply address, or a commit of this PR by that account carries its name or email.

`fixes.json` is the only record of the PRs Gary opens. `gary fix-record` writes it for the automatic fixes and for the fixes a click on an Implement card started. A replacement PR of a take-over is not in it. It carries the contributor's work anyway.

PRs by the Copilot coding agent and by dependency bots are not covered. Their content does not come from us. They keep the refusal and the API edit.

The snapshot sets `facts.sensitiveOurs: true` on such a PR. The stored entry keeps `sensitiveOurs: true` next to `sensitiveFiles`. A PR with sensitive files that fails a condition carries `facts.sensitiveNotOurs` with the reason, like `commit 3 of 3 was authored by hubot`. What changes on a PR that is ours alone:

- The push refusal does not apply. `sensitiveRefusal` returns null. The validator accepts `address_review`, `drive`, `format` and the checkout form of `revise`. The server accepts their clicks. The usual rules of each route still hold. `take_over` stays invalid, because we already control the PR.
- The validator refuses the API edit there. The PR gets the checkout forms like every other PR we control. That keeps one way to change it. The server still runs the click on an API edit that an older item holds, because it is the narrower push.
- Agents may work in a worktree of the PR's head, for the review and for the push.
- The `format` route and the autofix inside a `revise` run. The format check still takes its tools and every config from the base checkout. It copies none of the PR's sensitive files. So it formats only the PR's other files.

What stays as on every PR with sensitive files:

- The item goes to `review` at least and names the paths in `state`.
- The automatic first review skips it.
- The dialog shows the banner with the files.
- The maintainer reads the changes himself before he merges.

The conditions are checked again each time. The next snapshot after a commit by someone else drops `sensitiveOurs`. From then on the validator and the server refuse the pushing routes again. The snapshot can be an hour old. So the worker asks GitHub right before it acts, with `gary push-check --pr <n> --sha <head>`. The command fetches the PR and runs the same `oursAlone` on the live commit list and the complete file list. It exits 3 when the PR is not ours alone or its head is not `--sha`. The skills run it before they create a worktree of the head and again right before `git push`. A commit that lands after the second check moves the branch. Git then rejects the push. The push is never forced.

Why this is acceptable: the danger of a sensitive PR is an agent that loads instructions or runs code an outside account wrote. Here no outside account wrote anything on the branch. An agent in that checkout reads what our own agent or the maintainer wrote. It reads the same kind of content in the base checkout.

The risks that remain:

- A fix PR is derived from an issue or a discussion. That text is untrusted. It can lead the agent to write a harmful change to a workflow or an instruction file. So the maintainer's own review before the merge stays the guard. The rule for AI-written PRs already requires it: such a PR goes to `review`. Gary never merges or approves it.
- Git lets whoever pushes choose a commit's author and committer. So conditions 4 to 6 rest on condition 1: only accounts with write access can push to a branch of the repository. A collaborator who forges the bot's identity could pass the check. An outside contributor cannot.

## Board page

One page serves every instance. `GET /api/state` returns `{ board, items, proposals }`:

- `board`: `{ me: { login, avatarUrl }, dryRun, instances: [ { name, title, kind, repos, repoUrl, bot, accountMode, paused, relatedRepos, botCommands, escalateAs, reviewBots } ] }`. `title` is the profile's `name`, `bot` is `{ login, avatarUrl }` or `null`. The page takes links, avatars, bot names, bot commands and new-issue URLs from the item's own instance entry, never from one global repo.
- `items[]`: each with `instance`, `id`, `ref` (`owner/name#number`), `repo` and the stored fields, plus `working` and `fix` when there are any. A PR whose snapshot entry has `sensitiveFiles` carries `sensitive: { files, total }`, with the first 5 paths and their full count, plus `ours: true` when the entry has `sensitiveOurs`. A discussion without a stored `category` gets the one from the snapshot. Routes carry `actor`, `draftHash`, `done` and `refused`, and `labelDone` or `answerDone` when a second button ran.
- `proposals[]`: the open proposals, each with `instance`.

The page talks to the server only through `window.claude`, which the server injects into the page:

- `use("board")` returns the `board` object above plus `refresh({ instance, itemId })`, see `/api/refresh`, and `decision(body)`, which posts `{ instance, itemId, routeId, text }` to `/api/decision` when he uses a route he does on GitHub himself. It resolves quietly, also when the post fails.
- `use("db")` returns `collection("items" | "actions" | "proposals").orderBy(field, dir).limit(n).onSnapshot(cb)`, with the docs of all instances, each doc with `instance` and keyed `<instance>/<id>`, and `doc("meta/status").onSnapshot(cb)`. `doc(path).set(data)` and `doc(path).update(data)` write through `/api/db`, whose paths gain the instance. The event stream names the instance in every event, sends a `board` event with the full `board` object when a pause changes, and `reload` when `board.html` changed.
- `use("mcp")` returns `listTools("host:gary")` and `callTool("host:gary", tool, input)`. `callTool` posts `{ instance, action: tool, ...input }` to `/api/action`. For a route click `tool` is the route type and `input` is `{ instance, itemId, routeId, text, draftHash, force, input }`. The board-only calls are `dismiss_route` with `{ instance, itemId, routeId, text }`, and `accept_proposal` and `dismiss_proposal` with `{ instance, proposalId, text }`.

The page keeps filters and drafts in localStorage under keys prefixed `gary:<instance>:`, after a one-time move of the per-repo keys. Tabs, groups and header markers are described under "One server, one master".

## Day plan

The board shows three groups: "Quick & Easy" (`active`, `easy`), "Afterwards" (`almost`, `review`) and "When you have time" (`deferred`, `hardware`, snoozed items). A chip on each row names the section. The page shows at most the time budget (6 hours by default, set on the board), filled in group order by `priority`, using `effortMinutes`. An item that does not fit is skipped. Items handled today count as spent time. "Quick & Easy" shows at most 5 rows at a time. More rows appear only on click. The default view shows no backlog counts.

An issue or discussion whose served `fix` has `parked: true` is in no plan group and adds no minutes to the plan. The fix PR's own item, the one with `fixFor`, carries the work. Below the groups a quiet line "Has a fix in progress: N" lists these items. It expands to one row per item with the fix chip and an "Open" button, like the line "Handled, waiting for the next run". A handled item is listed only there.

A PR whose served `autoReview` has `waiting: true` is in no plan group and adds no minutes either. A third quiet line "Reviewed automatically, waiting: N" lists these PRs, each with an "Open" button. The dialog of a PR with an `autoReview` shows a tag in the meta row, "Reviewed automatically, waiting for the contributor" or "Reviewed automatically", and a block above the story: the same words, a link to the review, what it asked for, the state of the format offer, and once the wait ended what changed since, like "Since then the author pushed". The page keeps a parked item loaded also when it has no routes, so "Open on board" in the fix PR's dialog still opens it, and its dialog shows the fix banner.

A discussion shows its GitHub category, like "Feature Requests", as a quiet outlined chip: after the title on its list row, and in the dialog's meta row before the labels. The board's search matches it.

A PR with a served `sensitive` shows a warning block in the dialog above the verdict and the routes, in the callout colors: "Touches sensitive files: `.github/copilot-instructions.md`, `package.json` and 2 more. Gary does not push to this PR. It gets no take-over, no change and no format run. These files can change what agents do or run code with repo secrets." It appears on contributor PRs and on PRs we control alike. The push is refused on both, unless the PR is ours alone. The meta row carries a warning badge "Sensitive files", and the list row a warning icon whose tooltip names the files. When the item has an API edit route, the second and third sentence are "Gary only commits the text edits shown below, outside these files. It checks out nothing and runs nothing from this PR.", and the tooltip changes the same way. On a PR whose `sensitive` has `ours: true` they are "Only you and Gary have committed to this PR. Agents may push to it. Read the changes to these files with care.", followed by the same last sentence. The badge and the icon stay. The tooltip carries the first two of these sentences.

The card of an API edit shows each edit as a diff under its path, rendered like the suggestion of a review comment: the `original` lines removed, the `replacement` lines added. Below them it shows the commit message and the line "Commits through the GitHub API, without checking out the branch". Its text field is "Note for the contributor, added to the comment about the commit (optional)". Its button is "Commit the text edit", or "Commit the text edits" for more than one, with the bot's avatar, and a second click confirms: "Confirm: commit to the contributor's PR as widgets-bot", or "commit to the PR" on a change. The card has no thread switches. A done card says "Done · view on GitHub" with the commit.

## Validation

`gary put` and `gary validate` check an item against these rules. A broken rule refuses the write and lists every problem.

- The required fields are present and every enum holds one of its values: `kind`, `number`, `title`, `url`, `author`, `authorType`, `section`, `priority`, `effortMinutes`, `reviewDepth`, `state`, and where present `ci`, `mergeable`, `reviewDecision`, `classifiedBy`, thread verdicts and finding severities. `repo` is present and one of the instance's repos. The id matches the opaque id pattern. An item without routes needs no `priority`, because the routine ranks only items with routes.
- 0 to 4 routes with the ids `r1` to `r4`, each id once. With routes, exactly one is `recommended`, and `hint` equals its title and has at most 60 characters. An item without routes needs no hint.
- No routes while a thread is `unjudged`.
- Every route's `as` is allowed for its type and is not `unavailable` in the current account mode.
- A `review` route with a preset `event: "comment"` is a warning, except on a PR by a bot: a review with something for the contributor is a change request.
- `address_review` only when every thread has an id and a verdict, and only where `drive` would be accepted. `drive`, `take_over` and `revise` only where the server would accept them: `take_over` only on a contributor PR that is not taken over, `revise` only where `drive` is allowed, with a non-empty `text` and no params.
- On a PR whose snapshot entry lists `sensitiveFiles` and no `sensitiveOurs`: no `address_review`, `drive` or `format`, and `take_over` and `revise` only as an API edit. On a PR whose entry lists no sensitive files, no API edit. The same holds when the entry lists them with `sensitiveOurs`: no API edit, with the checkout routes under their usual rules. Without an entry neither is checked. An API edit passes the limits in "API edit" that need no GitHub read, has `as: "bot"`, and needs a 40-character `reviewedSha`. A `revise` as an API edit may have an empty `text`.
- `pushed` is `{ action, sha, at }` on a PR. While `pushed.sha` equals `reviewedSha`, the agent's push made the current head, and the item needs at least one route that decides the PR: `merge`, `review`, `revise`, `address_review` or `close`. A `reply` that reports the push is not one. This holds while CI still runs on the new head: the route then carries a callout that says so.
- An item with `blocked` has exactly one route, of type `open`. An `open` route has no text and no params, and is allowed without `blocked` too.
- No route whose type is in the item's `dismissedRoutes`. The message names the dismissed route and its reason. `move` targets are in `relatedRepos`. A `move` to `issue` needs a discussion that the refresh did not find closed, the profile's `botCommands.escalate`, and an `issueKind` of `bug` or `enhancement` when it has one. `category` is a non-empty string and only on a discussion. Chores name a chore action.
- No text the bot would post contains a `botCommands` string.
- Every `findings[].routeId` names a route of the item.
- `findings[].certain` is true or false. A finding with `certain: true` needs `evidence`, the concrete case that shows the problem, in at most 400 characters. A `question` or an `idea` is never certain.
- `effortMinutes` is required and one of 1, 2, 5, 10, 15, 30, 60 and 120. The message names the allowed values.
- `params.alsoAnswer` only on `close` routes of items with `kind: "discussion"`, with a node id, a `url` that starts with the item's `url` and `#`, and a `gist` of at most 200 characters.
- `handled` is `{ at, routeId, routeType, verified }` with a `verified` from its list. `fixFor` only on PRs, as `{ itemId, ref }`.
- No `follow_up` with `as: "agent"` while the item's fix state is `working`, `draft` or `open`. `gary put` and `gary validate` compute it like the server.
- `lastEventUrl`, when present, starts with the item's own `url` followed by `#`.
- `params.alsoLabel` only on `reply` and `request_logs`, as `{ add?, remove? }` with at least one label, every label in `autoLabels`, and no label in both lists.
- `autofix`, only on PRs, is `{ changes, files, lines, tools }` with `changes` true exactly when `files` is above 0. A `format` route needs `autofix.changes: true` and a `reviewedSha`, and has no text and no params.
- `wants` is `{ labels?: { add?, remove? }, assignees? }`. Every label in it is one of the profile's `autoLabels`, no label is both added and removed, and `wantsReason` is required with `wants` and refused without it.
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
  "effortMinutes": 5,              // estimated maintainer time to read up and decide: 1, 2, 5, 10, 15, 30, 60 or 120
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
  "autofix": { "changes": true, "files": 2, "lines": 14, "tools": ["eslint", "prettier"] },   // PRs, optional: what the project's autofix would change at reviewedSha. Formatting and lint are not findings
  "reviews": [                     // PRs: one per reviewer, copied from the snapshot's reviewSummary, plus one "pending" entry per requested reviewer
    { "author": "octocat", "isBot": false, "state": "approved", "submittedAt": "ISO", "url": "…", "openThreadCount": 0 }
  ],
  "threads": [                     // PRs: unresolved review threads with the agent's judgement
    { "id": "PRRT_…", "author": "copilot-pull-request-reviewer", "isBot": true, "path": "…", "line": 120, "url": "…",
      "summary": "One line: what the comment asks for.", "verdict": "valid", "note": "One sentence of reasoning." }
  ],                               // verdict: valid | optional | wrong | unjudged
  "reviewDecision": "pending",     // PRs, from the snapshot: approved | changes_requested | pending
  "isAnswered": false,             // discussions, from the snapshot
  "category": "Feature Requests",  // discussions, from the snapshot: the category's name on GitHub
  "solved": false,                 // issues and discussions: the agent thinks it is resolved
  "findings": [                    // optional, full reviews only
    { "severity": "blocker", "text": "…", "ref": "src/…:123", "routeId": "r2" },   // blocker | major | minor | idea | question. routeId is optional
    { "severity": "major", "text": "…", "ref": "…", "certain": true, "evidence": "The value 200 passes the range check and the device rejects it." }   // certain and evidence are optional. Only such a finding may go out in an automatic review
  ],
  "routes": [ … ],                // see Routes
  "pushed": { "action": "take_over", "sha": "…", "at": "ISO" },   // PRs: our last push and the head it made, by an agent or by an API edit. action is take_over, revise, address_review, drive or format
  "takenOver": false,              // PRs: true after a take_over ran, also as an API edit. Allows `drive`, `address_review` and `revise` on a contributor PR
  "lastEventUrl": "https://github.com/…/issues/12#issuecomment-123",   // optional, copied from the snapshot's facts.lastEventUrl. The board opens the thread there, at its bottom
  "classifiedBy": "fast",          // optional, the agent's: fast | standard | full, the tier that wrote this item
  "analyzedBy": "fallback",        // optional: a safety filter stopped the `review` model's triage and the fallback model did it, see "Models". Only value "fallback"
  "blocked": { "reason": "safety_filter", "at": "ISO" },   // optional: the agent could not analyze the item. reason: safety_filter | failed. A successful triage writes the item without it
  "rounds": [                      // PRs: written when a drive ended
    { "n": 1, "fixed": ["…"], "dismissed": [ { "summary": "…", "reason": "…" } ], "open": ["…"] }
  ],
  "links": [ { "label": "Draft fix", "url": "…" } ],
  "hidden": false,                 // set by dismiss, cleared by the routine when updatedAt changes
  "snoozedUntil": null,
  "dismissedRoutes": [             // set by dismiss_route, never cleared by the routine
    { "type": "close", "title": "Close: fixed in 2.3.1", "reason": "Not fixed for him yet", "at": "ISO" }
  ],
  "wants": { "labels": { "add": ["needs-info"], "remove": [] }, "assignees": ["octocat"] },   // optional, the agent's: labels and assignees it would set. Replaced with the doc
  "wantsReason": "One sentence.",  // required with wants
  "handled": { "at": "ISO", "routeId": "r1", "routeType": "reply", "verified": null },   // the maintainer's, see below
  "live": { "state": "closed", "checkedAt": "ISO" },   // set by a refresh that found the thread closed or merged. The next snapshot drops the item
  "fixFor": { "itemId": "issue-23", "ref": "acme/widgets#23" }   // code-owned, PRs: the item this Gary fix PR is for, with `ref` naming that item, from <state>/fixes.json
}
```

`handled` says the maintainer acted on the item. The server sets it when he reports a prefill button (`/api/decision`), when a bot route or a second button ran, and when an agent route was queued. `verified` is `null` (not checked), `"closed"`, `"merged"`, `"commented"` (a comment by `me`, a maintainer or the bot newer than `at`), `"labeled"` (the route's labels are on the thread) or `"unchanged"`. A posted text sets `"commented"`, a label `"labeled"`, a queued agent job `null`. It is a maintainer field like `hidden`: a replace keeps it, `gary put --merge` with `{ "handled": null }` clears it.

`POST /api/refresh` with `{ instance, itemId }` reads the item from GitHub, read-only, with the bot token or the own login without a bot, through the same fetch as `gary item`. It runs at most once per 20 seconds per item and 30 times a minute in total, and answers 429 with `retryAfter` in seconds beyond that. It sets `handled.verified`, `live` for a closed or merged thread, and the GitHub fields the page shows: `mergeable`, `ci` and `lastEventUrl`. It answers `{ ok, result: { state: "open" | "closed" | "merged", checkedAt, verified } }`. The shim offers it as `use("board").refresh({ instance, itemId })`.

The server serves derived state on items, never stored:

- `working: { kind: "fix" | "review" | "push", action, since }` while an unexpired claim, a queued or claimed agent request, or a drive that waits for its review bot (`<state>/drive/<itemId>.json` in the stage `review`) exists. A drive file in the stage `watch` is no work. Push work wins over other kinds, then the oldest. `action` is the agent action, missing for a bare claim.
- `fix` on issues and discussions: `{ state: "working" | "draft" | "open" | "merged" | "closed", pr: { number, url, title, isDraft, ci, author } | null, startedBy: "routine" | "maintainer" | "other", since, parked }`. `parked` says that the fix keeps the item out of the day plan: true for `working`, and for `draft` and `open` until the other side writes. That is the case when the snapshot entry's `lastThemAt` is later than `since`, the time Gary recorded the fix PR. A fix PR without a recorded time has no `since`, so it parks the item until it is merged or closed. `merged` and `closed` never park. Sources, strongest first: a `fix` claim or a queued `start_fix` request (`working`, the maintainer when a request is queued, else the routine), Gary's records in `fixes.json`, the snapshot's `closingPrs` of an issue in any state, and for a discussion the PRs that name it by URL or as `#<number>`. The PR's own snapshot entry gives its live fields. A recorded PR that no source shows counts as open. With several PRs an open or draft one wins, then merged, then closed.

- `autoReview` on PRs with a record in `<state>/auto-reviews.json`: `{ at, url, sha, event, count, asked, offer: { kind, state, at }, waiting, changed }`. `asked` holds the texts of the findings the last automatic review posted. `changed` lists what happened since it, from the snapshot entry: `pushed` (the head differs from the reviewed one and is not our own format commit), `replied` (the PR's author commented, replied or reviewed), `re-requested`, `formatted` (our format commit made the head of a PR whose review had no findings) and `maintainer` (a maintainer commented or reviewed). `waiting` is true while `changed` is empty. The reply that accepted the format offer is no `replied`.

#### Fix limit

`maxPendingAutoFixes` (default 10) limits the fixes the routine started on its own that are pending: a fix job of the routine that runs, or a fix PR recorded with `startedBy: "routine"` whose state is `draft` or `open`. A fix the maintainer started with a click never counts and is never refused by the limit. A merged or closed fix PR frees its slot. `gary claim <itemId> fix` without `--request` takes the claim, counts, and gives the claim back with exit 3 when the count is above the limit, so two runs that claim at once never pass it together. Per run the routine starts at most `min(maxAutoFixesPerRun, maxPendingAutoFixes - pending)` fixes. `0` turns automatic fixes off, like `maxAutoFixesPerRun: 0`. A pending fix of the routine is served with `fix.limit: { pending, max }`, and the line "Has a fix in progress" shows it as "automatic: 3 of 10".

#### Fix review rounds

A fix PR Gary opened goes through review rounds on its own, then it is marked ready and reviewed for the board. The rounds are a `drive` with `by: "fix"`: the same state file, push claim, push block and `rounds` records as a clicked drive.

1. Right after `gary fix-record`, the fix worker runs `gary fix-review start --pr <n> --sha <head> --run <run>`. It requests the review from `fixReview.reviewer` under the account in `requestAs` (`me`: the maintainer's stored login, `bot`: the bot's token), writes the drive's state to `<state>/drive/<pr item id>.json` with `by: "fix"`, `fixFor`, `maxRounds`, `markReady`, `lastPushedSha`, `reviewRequestedAt`, `stage: "review"`, `watch: true`, `copilotRounds: 1` and `seenAt`, and writes the drive's action doc, queued and already claimed. With `fixReview` off it does nothing and says why.
2. `gary watch-queue` reads the PR of every drive in the stage `review` once a minute. When the review bot reviewed or commented after `reviewRequestedAt`, it prints `{ instance, id, itemId, action: "drive", event: "review-arrived" }` once. After 30 minutes without one it prints `event: "review-timeout"`. The master starts a drive worker on that line. This holds for clicked drives too.
3. A round addresses the review by the agent's own verdicts, pushes, and requests the next review with `gary pr-watch review` while rounds remain. A review or comment by the maintainer since the last round goes into the round: it judges his threads too, by the rules of "Watched PRs", and ends nothing. A comment, review or push by another person since the drive started ends the rounds, and the item goes to the board with its usual routes.
4. The worker that ends a round runs `gary fix-review finish --pr <n> --outcome done|stopped --reason <text> [--seen-me <ISO>]`. `done` means the review bot has nothing open or `maxRounds` is reached: the PR is marked ready when `markReady` is true and Gary never marked it ready before, and its record in `fixes.json` gets `readyAt`. `stopped` means stuck or failed, like CI the agent cannot fix, a refused push or a review that never arrived: the PR stays a draft. Both queue a `full_review` action for the PR item with `params: { repo, number, by: "fix", fixFor, outcome, ready, rounds, lastPushedSha }`, plus `trigger` after a round for feedback, and the reason as `text`. They set the round's action doc to `done` and put the drive file into the stage `watch`, see "Watched PRs". The queue watcher prints the full review within seconds, and its worker writes the PR's item with the `rounds` and the reason.

While the rounds run, the fix PR has no board item. The issue's `fix` carries `review: { reviewer, round, maxRounds }` from a drive file in the stage `review`, where `round` is `copilotRounds`, the review bot rounds requested over the PR's whole life. The chip reads like "Fix: #9496 draft, Copilot round 2 of 3". In the stage `watch` there is no `review`. The server watches `fixes.json`, the drive files and the snapshot files, so each stage reaches the open page without a triage run.

No step waits for the hourly run:

| hand-off | trigger | worst-case delay |
| --- | --- | --- |
| fix PR recorded, first review requested | the fix worker calls `gary fix-review start` itself | none |
| review arrived, next round starts | the watcher's poll per waiting drive | 60 s for the poll, plus the worker start |
| review never arrives | the watcher's timeout line | 30 minutes after the request, plus 60 s |
| rounds ended, full review starts | the watcher prints the queued `full_review` | 5 s, the watcher's rescan |
| his review or comment, round starts | the watcher's poll per watched PR, then `gary pr-watch round` | 3 minutes for the poll, plus 5 s and the worker start |
| stage on the issue's chip | file watch on `fixes.json` and `drive/`, pushed over the event stream | under a second |
| PR item on the board | the review worker's `gary put`, pushed over the event stream | under a second after the write |

While the instance is paused none of this runs: no fix starts, `gary fix-review` and `gary pr-watch round` and `review` refuse with exit 4, the watcher prints nothing for the instance, and the worker records the step in `would-have.json`.

#### Watched PRs

The PRs we control stay watched until they are merged or closed: every open PR by the instance's bot (`bot.login`), Gary's fix PRs in `fixes.json` among them, and every PR whose item has `takenOver: true`. A bot PR counts while the snapshot lists it or its drive file exists, so a draft by the bot outside `fixes.json` is not watched. Two kinds of feedback start an agent round on them without a click:

- **The maintainer's.** A review or comment by `me` after our last push that no round handled yet. `gary watch-queue` reads at most 20 watched PRs per instance every 3 minutes, the first time right at its start. It prints `{ instance, id: "watch-<itemId>", itemId, action: "drive", event: "maintainer-feedback", pr, at }` once per piece of feedback, with `at` the time of his newest one. The master then runs `gary pr-watch round --pr <pr> --by me --at <at>`, which queues the round as a `drive` request, and the watcher prints that request a few seconds later like any other.
- **Other people's.** A review, review comment or comment by anyone else, co-maintainers included, starts nothing at once. The item goes to the board as usual. The hourly run lists them with `gary pr-watch list --json` and queues a round with `gary pr-watch round --pr <n> --by others --at <at> --run <run>`. That round judges them like any review.

Each piece of feedback starts at most one round. The drive file keeps `seenAt: { me, others }`, the time up to which a round handled each side. Feedback counts as handled when it is not later than the latest of `seenAt` for its side, `lastPushedAt`, the commit time of our newest commit on the PR, the item's `pushed.at`, and for a fix PR the time it was recorded. So feedback that came before the watcher existed starts a round too, when it came after our last push. `round` sets `seenAt` of its side to `at`, and the round's end moves it to the time the round read the PR. In the `own` mode the round's replies post under his login, so the end sets `seenAt.me` to the time it ends.

The drive file of a watched PR has `watch: true` and `stage`. `review` means a review bot round waits. It blocks his clicks like any push job, and `gary watch-queue` prints `review-arrived` and `review-timeout` for it. `watch` means only his feedback is awaited. It blocks nothing and gets no `working` chip. A watched PR without a drive file counts as `watch`, and `gary pr-watch round` writes the file on first use. The watcher removes a file in the stage `watch` once the PR is merged or closed.

`gary pr-watch`:

- `list [--json]`: every watched PR with `itemId`, `number`, `why` (`fix`, `bot` or `taken_over`), `fixFor`, `stage`, `pushWork`, `reviewRounds: { used, cap }` and the newest unhandled feedback per side as `me` and `others`, each an ISO time or null. It reads the staged snapshot, or the baseline when nothing is staged. Its PR entries keep `feedback: { lastMeAt, lastOthersAt, ourLastCommitAt, reviewBotReviews }` for this.
- `round --pr <n> --by me|others --at <ISO> [--run <run>]`: write a queued `drive` action doc with `params: { by: "fix" | "watch", fixFor, trigger: "maintainer" | "others", at, maxRounds }`, claimed by `--run` when given, and set the drive file's `actionId` and `seenAt`. It refuses with exit 3 when no account may push, while push work runs on the PR, when the snapshot lists sensitive files and the PR is not ours alone, and when a round already handled the feedback up to `at`.
- `review --pr <n> --sha <head> [--action <id>]`: request the next review bot round after a round pushed, under the fix PR's `requestAs` or the maintainer's login. The drive file goes to the stage `review` with `reviewRequestedAt` and `copilotRounds` one higher. It refuses with exit 3 when the PR had all its rounds: 3 per PR over its whole life, or `fixReview.maxRounds` on a fix PR when that is lower. The rounds used are the larger of `copilotRounds` and the review bot's reviews on GitHub.
- `done --pr <n> --sha <head>`: end a round without a next review bot round. The drive file goes to the stage `watch`.

`--seen-me <ISO>` and `--seen-others <ISO>` on `review`, `done` and `gary fix-review finish` move `seenAt` of a side to the time the round read the PR, never back. A round passes the side it judged.

A round for feedback is a `drive` round, see the review skill's `drive.md`. It holds every rule of a clicked drive: the push claim, the push block, the refusal for sensitive paths with the exception for a PR that is ours alone, never a force-push, never a merge, approval, close or ready mark beyond `fixReview.markReady`, never code from the PR branch. A bot PR can carry commits by other people, so it is ours alone only as `gary push-check` decides it. A round on a contributor PR needs `takenOver: true`. Rounds never open a fix PR, so `maxPendingAutoFixes` does not count them. The round fixes what holds, pushes, replies in each thread and resolves the threads it fixed. Questions get an answer in their thread, and a fix only when the answer shows one is needed. A request it finds wrong gets a reply that says why, and the thread stays open. His threads are judged less strictly than other reviewers': his request wins unless it is clearly wrong or the code shows he misread it. Anything that needs his decision, like a design question, a disagreement between him and another reviewer or a request outside the PR's scope, stays open and becomes a card on the board. When review bot rounds remain, the round may request the next one with `gary pr-watch review`. Its end reviews the PR item again for the board with the rounds recorded: a fix PR through `gary fix-review finish`, any other PR through the item the round returns.

#### Automatic first review

A contributor's PR can get one review without a click, so it had a review before the maintainer first looks at it. This is the only case where a review reaches a contributor without his click. It is off unless the instance's `autoReview.enabled` is true.

`gary auto-review post --pr <n> --sha <head> --run <run> --file <review.json> [--dry-run]` is the only way such a review goes out. The routine worker calls it after the full review of a PR, and the command enforces every rule itself. It reads the PR fresh from GitHub and refuses with exit 3 and `{ ok: false, posted: false, refused: <code>, result }`:

| code | rule |
| --- | --- |
| `off` | `autoReview` is not enabled, no account may post, or the profile names no paths for the kinds |
| `settings` | the instance runs on its last valid settings because the files on disk are broken |
| `not-open`, `draft` | the PR is closed, merged or a draft |
| `author` | the PR is by a maintainer, the bot, another bot or Copilot, or it is a fix PR of Gary. Only `authorType: "contributor"` qualifies, and only with an author association other than `OWNER`, `MEMBER` and `COLLABORATOR` |
| `ai-authored` | `facts.aiAuthored` is true |
| `sensitive` | the PR touches one of the profile's `sensitivePaths` |
| `kind` | not every changed file matches the `autoReviewPaths` of one of the `kinds`, or the PR changes more files than the snapshot lists |
| `head-moved` | the PR head is not `--sha` |
| `timeline-truncated` | the thread is longer than the snapshot reads, so nothing proves that no maintainer joined |
| `maintainer-active` | a maintainer commented or reviewed on the PR, at any time. From then on the thread is his. The automatic review itself does not count, also when it went out under his login in `own` mode. A comment among the PR's last 5 by an `OWNER`, `MEMBER` or `COLLABORATOR` the profile does not list counts too |
| `already-reviewed` | the PR has an automatic review, and its author did not re-request one since |
| `run-limit` | the run already posted `maxPerRun` automatic reviews. A paused or dry run counts the steps in its `would-have.json` |
| `invalid-review` | the review doc breaks a rule below. `problems` lists each one |
| `item` | the board item of the PR holds no full review of `--sha`. The item is written first |
| `clean` | the doc has no finding and there is no format offer to make. A clean PR gets no automatic review and goes to the plan with its decision route |
| `pushing`, `claimed` | an agent is changing the PR, or another run holds its `review` claim |

`gary auto-review check --pr <n> [--sha <head>] [--run <run>]` applies the same rules without a doc and writes nothing. It prints `{ ok: true, qualifies, refused, result }`, and for a PR that qualifies `reason`, `headSha`, `maintainerCanModify` and `offerMade`. `gary auto-review list [--json]` prints the records and, as `states`, the `autoReview` state the board serves per PR.

The command takes the item's `review` claim for the post. A claim the same run already holds stays, any other is released after the post.

The review doc is `{ summary, findings, comments }`:

- `findings` holds only what the agent is certain about and can show: `{ severity, text, ref, certain: true, evidence }`. `evidence` is the concrete case in one sentence, like an input that is accepted and should not be, a symbol without users, a doc comment that contradicts the code, or a violation of a project rule or tool. `severity` is `blocker`, `major` or `minor`. A finding without `certain: true` or without `evidence`, a `question`, an `idea`, a text that ends in a question mark, and wording of a guess like "I think", "maybe" or "probably" in a finding, the summary or a comment are refused.
- `comments` are inline comments like those of a `review` route, each with `finding`, the index of the finding it belongs to. Suggestions follow the rules of review comments.
- Questions about the approach, taste, specification questions and everything else the agent is not certain about are not in the doc. They stay as `findings` on the board item, for the maintainer's own review.
- Formatting is never a finding and never a comment.

What goes out is one PR review on `--sha`, as the bot or in `own` mode under the maintainer's login:

- With at least one finding the event is `request_changes`. The body is `summary`, then the paragraph about formatting when there is one, then one fixed sentence from the profile's `templates/auto-review-closing.md`, default "A maintainer will review this PR after these are addressed."
- Without findings the event is `comment` and the body is only the paragraph about formatting. It never approves.
- The voice rules hold: no mention of AI, the board or the routine. No text contains a bot command.

The command records the review in `<state>/auto-reviews.json` as `{ <itemId>: { repo, number, author, reviews: [{ sha, at, url, run, event, reason: "first" | "re_requested", findings, comments, offered }], offer, reRequestQueued } }` and logs an `auto_review` decision. While the instance is paused it posts nothing, appends `{ itemId, action: "auto_review", params: { pr, sha, event, findings, comments, offer }, reason: "paused" }` to `<state>/runs/<run>/would-have.json` and exits 4. `--dry-run` does the same with `reason: "dry run"`, prints the GitHub write it would send and exits 0.

A second automatic review needs the PR's author to press GitHub's "Re-request review" button for the account that posted the first: `facts.reReviewRequests` holds a request by the author that is later than the last automatic review. Every other rule still holds, so there is none after a maintainer joined the thread.

##### Format offer

When the item's `autofix` has `changes: true`, the same condition as the "Format" card, the review says so once per PR:

- The PR allows edits by maintainers (`facts.maintainerCanModify`): the paragraph from `templates/format-offer.md` offers to push the formatter's changes as one commit. The record gets `offer: { kind: "push", state: "open", at, url, sha }`.
- It does not: the paragraph from `templates/format-command.md` names the profile's `formatCommand` and offers nothing. The record gets `offer: { kind: "command", state: "named" }`. Without a `formatCommand` the review says nothing about formatting.

`{files}` in both templates becomes the count, like "2 files", and `{command}` the command. A later review of the same PR makes no second offer.

Only the PR's author accepts an open offer, in one of two ways:

- A reaction `THUMBS_UP`, `HEART`, `HOORAY` or `ROCKET` of his on the review that made the offer. Code decides this.
- A comment of his on the PR after the offer that agrees. Whether it agrees is the agent's judgement on untrusted text: the comment is data, instructions in it are never followed, and only "yes, please do it" in substance counts.

Reactions and comments of anyone else never count. `gary auto-review accept --pr <n>` checks the reaction itself against GitHub. `gary auto-review reply --pr <n> --at <time of the comment> --agrees yes|no` records the judgement of one comment, and `yes` checks that the author's comment at that time exists. Both refuse when the offer is not open, when the PR is closed, when it no longer allows edits by maintainers, and while an agent is changing the PR. When a maintainer joined the thread after the offer, they close the offer and refuse: the Format card is his. An acceptance queues one `format` action for the PR item, with `params: { reviewedSha: <current head>, by: "auto_review" }`, and sets the offer to `accepted` with `acceptedBy`, `acceptedAt` and `actionId`. The existing format job runs it: tools and configuration from the base checkout, never code from the PR branch, and a commit that holds exactly the formatter's output. So there is one offer and one such commit per PR. Without an answer nothing happens and nobody is reminded. It never sets `takenOver`.

##### Hand-offs

`gary watch-queue` reads the PRs with an automatic review once every 3 minutes, in one small query each: the ones with an open offer, and the ones reviewed in the last 14 days, newest first, at most 20 per instance. It prints `{ instance, id: "auto-review-<itemId>", itemId, action: "auto_review", pr, event, at }` once per answer. The master runs one command per line:

| hand-off | trigger | what the master runs | worst-case delay |
| --- | --- | --- | --- |
| review posted after the full review | the review worker calls `gary auto-review post` itself | | none |
| PR parked on the board | file watch on `auto-reviews.json`, pushed over the event stream | | under a second |
| the author reacted to the offer | watcher line `event: "offer-accepted"` | `gary auto-review accept --pr <n>` | 3 minutes for the poll |
| the author commented after the offer | watcher line `event: "offer-reply"` with the comment's `at` | a worker that judges the comment and runs `gary auto-review reply` | 3 minutes for the poll, plus the worker |
| format job starts after an acceptance | the watcher prints the queued `format` request | a format worker, as for a click | 5 s, the watcher's rescan |
| the author re-requested a review | watcher line `event: "re-requested"` with the request's `at` | `gary auto-review rerequest --pr <n>`, which queues a `full_review` with `params.by: "auto_review"` once per request | 3 minutes for the poll, 5 s for the queue |
| the author pushed or replied, the PR returns to the plan | the next snapshot | the hourly routine | up to an hour. A PR older than 14 days or beyond the 20 is polled no more, so its offer and re-request also wait for the hourly snapshot |

While the instance is paused or `autoReview` is off, the watcher prints none of these lines.

##### Board

A PR with a record is served with `autoReview`, see above. While it waits for the contributor it is out of the plan, in the line "Reviewed automatically, waiting: N". It returns when the snapshot shows that the author pushed, replied or re-requested, or that a maintainer joined. The item keeps all its findings and routes, so the maintainer's own review card holds the unposted findings too.

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
  "via": "server",                 // server for GitHub actions and API edits, queue for agent requests
  "createdAt": "ISO",
  "finishedAt": null,
  "result": ""                     // URL of the created comment, or the error message
}
```

The server writes an action file for every bot or agent click, and for the escalate button, whose doc has `action: "escalate"` and `as` with the maintainer's login. A GitHub action gets `status: "done"` or `"failed"` and `via: "server"`. A failed one stays failed: nothing retries it. Agent requests always get `status: "queued"` and `via: "queue"`. This gives the routine a log of what the maintainer decided.

The maintainer's fields in an item are `snoozedUntil`, `hidden` and `dismissedRoutes`. The routine keeps them when it rewrites an item, and `gary put` carries them over in replace mode. It clears `hidden` only when the item changed on GitHub since the last run, and it never clears `dismissedRoutes`.

### `meta.json`

```jsonc
{ "lastRunAt": "ISO", "lastRunSummary": "…", "pendingReviews": 12, "staleIssues": 240, "staleDiscussions": 500,
  "rulesHash": "…",                // optional: hash of the rules the last run read
  "rulesPending": ["pr-12"] }      // optional: item ids still to triage again under the current rules
```

`gary put meta` refuses a `rulesHash` that is not a non-empty string of at most 200 characters, and a `rulesPending` that is not a list of item ids.

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
| `request_review` | `reviewer` (`copilot`), `as` (`me`, default, or `bot`) | request a Copilot review on the PR. It runs under the maintainer's own login, after the check that the login is `me`, or with `as: "bot"` under the bot's token. It needs `copilot` in `reviewBots` |
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
| `accept_proposal`, `dismiss_proposal` | decide a proposal, see Learning. The server applies them through `/api/action` |

Agent requests. The server writes them as queued action docs when their route is clicked. The page writes only the `reanalyze` doc of "Analyze again". The master session watches the queue between runs (`gary watch-queue` under the Monitor tool) and starts them within seconds. If the master is not running, the next hourly run picks them up:

| action | effect |
| --- | --- |
| `full_review` | run the full review for this item, outside the budget. With `params: { repo, number, by: "auto_review", reRequestedAt }` the PR's author re-requested the automatic review, and the worker ends with the post step of "Automatic first review". After the review rounds of a fix PR it carries `params: { repo, number, by: "fix", fixFor, outcome, ready, rounds, lastPushedSha }` and the reason the rounds ended as `text`, plus `trigger` after a round for feedback, see "Watched PRs". The PR may have no board item yet then, so the worker reads repo and number from the params. With `params: { repo, number, by: "api_edit", pushed: { action, sha } }` the server committed an API edit, and the review looks at the new head and ends in a route that decides the PR |
| `reanalyze` | `text` holds an optional maintainer instruction for the agent |
| `start_fix` | attempt a fix with repro test and draft PR. Optional `text` holds instructions, `params.finding` the finding it came from. `params.askReporter` is true when he switched on "Ask the reporter to test": only then the PR body ends with one request to the reporter. A fix nobody clicked asks nobody |
| `address_review` | `params.decisions` as sent by the card. The agent fixes or dismisses each thread and pushes to the PR branch as the bot |
| `take_over` | `params.mode` `push` or `replace`, optional `params.decisions` as for `address_review`, optional `text` with instructions |
| `revise` | no params. `text` holds the instructions. The agent makes that change and pushes to the PR branch as the bot. It leaves the open review threads alone, never opens a replacement PR and never sets `takenOver` |
| `format` | `params.reviewedSha`, the head the autofix check ran on. `params.by: "auto_review"` marks the job the PR's author accepted, which `gary auto-review` queues and no click starts. The worker refuses when the PR head moved since, runs the profile's autofix and pushes only its changes. It never sets `takenOver` |
| `drive` | `params.maxRounds`. `params.by: "fix"` with `params.fixFor` marks the review rounds of a fix PR, which `gary fix-review start` writes and no click starts. `params.trigger` (`maintainer` or `others`) with `params.at` marks a round for feedback on a watched PR, which `gary pr-watch round` writes, with `params.by: "watch"` on a PR that is no fix PR. When it ends the agent writes `rounds: [{ n, fixed: ["…"], dismissed: [{ summary, reason }], open: ["…"] }]` into the item and the fitting routes: merge when nothing is open, otherwise a review or address_review card. The dialog shows the rounds as a short summary |

A worker that pushed writes `result`, the URL of its last commit, and `resultParts: { commits: [url], threads: [{ url, resolved }] }` into the action doc. The page shows a finished agent job by name, "Take-over done", "Change done", "Review addressed", "Drive done" or "Formatted", and its result as short text with links, like "Pushed 1 commit · replied in 1 thread, resolved". A doc without `resultParts` shows its `result` string, with GraphQL node ids removed. No text for the maintainer carries a node id.

Every action returns `{ ok, result }` and never throws past the entry point. `--dry-run` applies the account rules and the read-only lookups and returns the writes it would send instead.

## Learning

Gary learns from where the maintainer deviates from the agent's proposals. The server keeps a decision log. A daily skill turns patterns in it into rule proposals. The maintainer accepts or dismisses each proposal on the board, and an accepted one is appended to a rules file. A second kind, the setting proposal, changes one value in the instance config when he accepts it.

### Decision log

`<state>/decisions.jsonl`, append-only, one JSON object per line. The server writes it, one entry at a time, and `gary auto-review post` appends the `auto_review` entries. Every entry has these fields, plus the fields of its type:

```jsonc
{ "at": "ISO", "instance": "widgets", "instanceKind": "maintainer", "repo": "acme/widgets",
  "type": "chose_alternative", "itemId": "pr-512",
  "item": { "kind": "pr", "authorType": "contributor", "section": "easy", "labels": ["bug"], "title": "…", "classifiedBy": "fast", "reviewDepth": "quick" } }
```

`item` holds the item's fields at the time of the entry. `classifiedBy` and `reviewDepth` are `null` when the item has none. `repo` is the item's repo, `null` for entries without an item, like `dismissed_proposal`. The server writes every entry through `logDecision(instance, type, itemId, item, fields)`.

| type | fields | written when |
| --- | --- | --- |
| `dismissed_route` | `route: { type, title }`, `wasRecommended`, `reason` | `dismiss_route` ran |
| `chose_alternative` | `recommended: { type, title }`, `chosen: { type, title }` | the used route is not the recommended one |
| `edited_text` | `route: { type, title }`, `draft`, `final`, each cut at 8000 characters | the sent or copied text differs from the route's draft |
| `thread_override` | `route: { type }`, `thread: { summary, verdict }`, `decision`, `note` | a fix or dismiss switch differs from the default for the agent's verdict, or carries a note |
| `unchecked_comment` | `comment: { path, text }` | one entry per inline review comment the maintainer unchecked |
| `edited_comment` | `route: { type, title }`, `comment: { path, line }`, `draft`, `final`, each text cut at 8000 characters | one entry per checked inline review comment whose words the maintainer rewrote. `draft` is the agent's words without the suggestion block |
| `agent_note` | `text` | the note of "Analyze again", or the instruction text of an agent route |
| `snoozed` | `days`, or `untilActivity: true` | the maintainer snoozed or hid the item |
| `dismissed_proposal` | `proposal: { id, title, target, file }`, or `{ id, title, kind: "setting", setting }` for a setting proposal, `reason` | `dismiss_proposal` ran, so the pattern is not proposed again |
| `accepted_proposal` | `proposal: { id, title, kind: "setting", setting }`, `from` | `accept_proposal` changed a setting. `from` is the value before. An accepted rule proposal writes no entry |
| `changed_event` | `route: { type, title }`, `from`, `to` | a `review` ran with another event than the route's `params.event` |
| `auto_review` | `review: { url, sha, event, reason, comments, offer }`, `findings: [{ severity, text, ref }]` | `gary auto-review post` posted an automatic review. It is the agent's work, never the maintainer's decision. `triage-learn` compares it with what he does on the item afterwards |
| `escalated` | `route: { type, title }`, `issueKind`, `category` | the escalate button posted the profile's escalate command on a discussion. `issueKind` and `category` are `null` when the route or the item has none |
| `skipped_label` | `route: { type, title }`, `labels: { add, remove }` | a bot `reply` or `request_logs` with `alsoLabel` ran with `input.alsoLabel: false` |

The server derives these entries itself when a bot or agent route is clicked, and for `dismiss_route`, "Analyze again", snooze and hide. Routes with `as: "me"` never reach `/api/action`, except the escalate button. The page reports the use of a prefill to `POST /api/decision` with `{ itemId, routeId, text }`, under the same token, origin and JSON checks. The server then logs `chose_alternative` and `edited_text` from the item file. It writes nothing to GitHub and no action doc.

`gary decisions [--since <ISO>] [--json]` prints the entries. `--since` is exclusive: it prints entries whose `at` is later than the value.

### Proposals

`<state>/board/proposals/<id>.json`, one file per proposal. A doc without `kind` is a rule proposal:

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

### Setting proposals

A proposal with `kind: "setting"` changes one value in the instance's `config.json`. Only the settings in `PROPOSAL_SETTINGS` (`scripts/lib/learning.mjs`) can be proposed, each with a fixed list of values. Today that is `fastTier` with `on` or `shadow`.

```jsonc
{
  "id": "learn-2026-11-19-fast-tier-on",
  "createdAt": "ISO",
  "kind": "setting",
  "setting": { "key": "fastTier", "value": "on" },   // on | shadow
  "title": "Use the faster model for obvious items",  // for `gary proposals` and the log. The board has its own words
  "stats": {
    "pairs": 130, "handedUp": 76, "answered": 54,    // handedUp + answered = pairs
    "sameSection": 54, "sameRouteType": 51,          // of the answered pairs
    "recent": { "answered": 40, "sameSection": 30, "needed": 38 },   // required for the reason "agreement"
    "overrides": { "fast": { "items": 20, "changed": 8 }, "standard": { "items": 25, "changed": 2 } }   // required for the reason "overrides"
  },
  "reasons": ["agreement", "overrides"],             // only with value "shadow", at least one
  "differences": [                                    // at most 50, one per item and pair of answers
    { "itemId": "issue-9413", "number": 9413, "url": "https://github.com/…/issues/9413", "runs": 3,
      "fast": { "section": "deferred", "recommendedType": "follow_up" },
      "standard": { "section": "deferred", "recommendedType": null } }
  ],
  "status": "open", "decidedAt": null, "reason": "",
  "note": ""                                          // set by the server when the config already had the value
}
```

A setting proposal has no `why`, `evidence`, `target`, `file`, `heading` or `text`, and any field not listed here is refused. `number` and `url` of a difference are optional and come from the board item. The proposal carries numbers only. The board builds every sentence of the card from them, so no model writes its wording.

`gary shadow propose` is the only writer. It reads `fastTier` from the instance config:

- `shadow`: it proposes `on` when the report has at least 40 pairs and the section agreement over the answered pairs is at least 95 percent.
- `on`: it takes the report of the last 7 days and proposes `shadow` for one or both reasons. `agreement`: `recentSectionAgreement` has at least 20 pairs and a share below 95 percent. `recent.needed` is 95 percent of `recent.answered`, rounded up. `overrides`: both `decisions.fast` and `decisions.standard` have at least 20 items, and the `any` rate of `fast` is at least 0.1 above the one of `standard`. `overrides.<tier>.changed` is that tier's `any.count`.
- `off`: it writes nothing.

It writes nothing while a fast tier proposal is open. Once one was accepted or dismissed, the report starts at its `decidedAt`, so the next proposal rests only on pairs recorded since. The id is `learn-<YYYY-MM-DD>-fast-tier-<value>`, with `-2`, `-3` and so on when that id is taken.

`gary shadow convert <id>` rebuilds a fast tier proposal that an older version stored as a rule proposal: a doc without `kind` whose `text` names `` `fastTier` `` and the value in backticks. It keeps `id`, `createdAt`, `status`, `decidedAt` and `reason`, and takes the numbers from the report, the whole log for `on` and the last 7 days for `shadow`. Any other rule proposal is refused and stays as it is.

### Writing and listing

The skill writes rule proposals with `gary put proposals <id> <file>`, which validates them. `gary proposals [--json]` lists every proposal with its status and the dismissal reason. `/api/state` serves the open proposals as `proposals`, and the event stream pushes their changes.

### Accept and dismiss

Both go through `/api/action` with `{ proposalId, text }`.

- `accept_proposal` appends `text`, the edited rule, to the target file: under `heading` when the file has that heading, at the end of the file otherwise. The path must resolve inside the profile's `rules/` or `templates/` directory, or be exactly the shared `<root>/personal.md`. Symlinks that lead elsewhere are refused, and the write is atomic. When the profile directory is a git repository, the server commits that one file there with the message `Add rule: <title>` and does not push. Then it sets `status: "accepted"` and `decidedAt`.
- `accept_proposal` on a setting proposal ignores `text`. The server validates the stored proposal again, reads the instance's `config.json`, sets the one key and writes the file atomically. The other keys, their order and the indentation stay. The server answers `{ ok: true, result: <config file>, setting: { key, value }, changed: true }`, sets `status: "accepted"` and `decidedAt`, and logs an `accepted_proposal` entry. The config loader reads the file again on its next call, so the server and the next run use the new value without a restart. It refuses with `ok: false` and changes nothing when the proposal is invalid, when the config is not a JSON object, or when the config would have errors afterwards. When the config already has the value, it writes no config and no log entry, marks the proposal accepted with `note` and answers `changed: false`.
- `dismiss_proposal` sets `status: "dismissed"`, `decidedAt` and `reason` from `text`, and logs a `dismissed_proposal` entry.
- Only a click on the board sends either action. No skill and no `gary` command accepts a proposal.

Both run in dry-run mode too, because they change only local files and never GitHub.

### Cursor

`<state>/learn.json` is `{ "reviewedUntil": "ISO", "lastLearnAt": "ISO" }`. The skill writes it with `gary put learn <file>`. `reviewedUntil` is the `at` of the newest log entry it read, `lastLearnAt` the time of its last pass.

## MCP server

Name `gary`, stdio, for interactive Claude sessions and for the master session. A plugin install starts it from the `mcpServers` entry in `.claude-plugin/plugin.json`. Its tools are then named `mcp__plugin_gary_gary__<tool>`. A clone registers it in user scope with `claude mcp add --scope user gary -- node <core>/mcp-server/index.mjs`, and the tools are named `mcp__gary__<tool>`. Skills find it with ToolSearch by the tool name `board_start`.

One tool per GitHub action above, named like the action. Each takes `kind`, `number`, `params`, `text`, acts on the instance of the session's working directory and rejects anything outside the table. Three more tools control the one board server and work from any directory: `board_start` starts it inside the MCP process at the root port, or reports the one that already runs, with the instances it serves. `board_stop` stops it if this process started it. `board_status` returns `{ url, owner, portAnswers, instances, sessionInstance }`, plus `sessionInstanceError` when the session's directory resolves to no instance.

## Snapshot

```
gary snapshot            # prints JSON work list to stdout, stages <state>/snapshot.pending.json
gary snapshot --commit   # after a successful run: save the staged snapshot as the new baseline
```

Fetches with GraphQL: all open PRs that are not drafts, plus open issues and discussions updated within `activeWindowDays`. For each item it collects what classification needs without another call: author and author type, labels, draft flag, head SHA, CI rollup, review decision, the latest reviews, a summary per reviewer, requested reviewers, open review threads, changed file paths and `sensitiveFiles`, whether the head branch is in the repository, the first 100 commits with author, committer and signature, the PRs that would close an issue (`closingPrs`), last 5 comments with author and author association, comment count, updatedAt. Open review threads include unresolved threads that GitHub marks outdated, with `outdated: true`. It diffs against `<state>/snapshot.json`. The staged and the committed snapshot keep, per id, `updatedAt`, `headSha`, `lastReviewAt`, `openThreadCount`, `labels` and `assignees`, so `gary wants` can compare unchanged items too.

Every entry of the full snapshot and of `gary item` carries `facts`, computed by code:

```jsonc
"facts": {
  "timeline": [ { "at": "ISO", "author": "login", "side": "us", "kind": "comment" } ],   // oldest first, at most 200, the newest kept
  "timelineTruncated": true,       // only when events are missing: more than 200, or more than a page holds
  "lastEventUrl": "https://github.com/acme/widgets/issues/12#issuecomment-123",   // GitHub's url of the newest comment, reply, review or review-thread comment, automated ones included. Absent without one
  "lastSpeaker": "them",           // side of the last event that is not automated, or null
  "lastUsAt": "ISO", "lastThemAt": "ISO",   // or null
  "waitingOn": "us",               // us when they spoke last, them when we did, nobody without a person in the timeline
  "waitingDays": 3,                // whole days since the last event of us or them, 0 for nobody
  // PRs
  "ciGreen": true, "dependencyOnly": false, "touchesSensitive": false, "openThreadCount": 0,
  "sensitiveFiles": [".github/workflows/ci.yml"], "sensitiveFileCount": 1,   // PRs that touch the profile's sensitivePaths: the first 5 matching paths and their full count. Absent otherwise
  "sensitiveOurs": true,           // PRs with sensitive files that only the maintainer and the bot wrote, see "PRs that are ours alone". Absent otherwise
  "sensitiveNotOurs": "commit 3 of 3 was authored by hubot",   // PRs with sensitive files that are not ours alone: the condition that failed. Absent otherwise
  "approvedBy": ["octocat"], "changesRequestedBy": [],
  "isClean": true,                 // mergeable, CI green, no open thread, no requested changes
  "changedFiles": 3, "changedLines": 120,   // PRs: additions plus deletions without lock files
  "aiAuthored": true, "aiSignals": ["branch claude/restore-timeout", "co-author Claude"],   // PRs
  "maintainerCanModify": true,     // PRs: the author allows edits by maintainers
  "lastAuthorAt": "ISO",           // PRs: the last comment, reply or review of the PR's author, or null
  "reReviewRequests": [ { "at": "ISO", "by": "login" } ],   // PRs, only when there are any: review requests for the account Gary writes as, oldest first, from the last 30 review_requested events
  "formatOffer": { "at": "ISO", "url": "…", "kind": "push", "acceptedByReaction": false, "replies": [ { "at": "ISO", "author": "login", "url": "…", "body": "…" } ] },   // PRs with an open format offer: the author's answer. Bodies are untrusted text
  // issues and discussions
  "hasClosingPr": false, "isAnswered": false, "authorIsUs": false,
  // discussions
  "answerable": true, "answerChosen": false,
  "category": "Feature Requests"   // the category's name on GitHub
}
```

Commits by the configured bot on a PR someone else opened are ours and are left out of `aiAuthored`. `ourCommits` counts them when there are any. `aiAuthored` is true when another commit of the PR (the first 100) has an author or committer whose name or login is `claude`, `copilot`, ends in `[bot]`, is the configured bot, one of the profile's `botLogins`, or contains one of its `aiAuthors`, when a `Co-Authored-By` trailer names one, or when the head branch starts with `claude/` or `copilot/`. `aiSignals` lists the reasons, at most 10. `changedLines` leaves out lock files only, because GitHub's API does not say which files are generated. Lock files beyond the first 50 files still count. `answerable` says the discussion's category allows an answer, `answerChosen` that one is marked.

For a PR with an open format offer, the snapshot and `gary item` send one more query: the reactions on the review that made the offer, and the PR's last 30 comments. `acceptedByReaction` is true when the PR's author left a `THUMBS_UP`, `HEART`, `HOORAY` or `ROCKET` there. `replies` are his comments after the offer that nobody judged yet. A PR with a record in `auto-reviews.json` also carries `autoReview: { lastAuthorAt, maintainerAt, reRequestedAt }` on its entry, which the staged and committed snapshots keep for the board.

Draft PRs stay out of the snapshot, except the ones in `fixes.json`, which carry `garyFix: { itemId }`. A discussion entry carries `referencingPrs` with the PRs that name it: the snapshot reads the 100 most recently updated PRs of the repo in one search, because discussions have no cross-reference events in the API. The staged and committed entries keep `lastEventAt` and `lastThemAt`, and for the fix state `title`, `author`, `isDraft`, `ci` and `garyFix` of PRs, `closingPrs` of issues and `referencingPrs` of discussions. A PR's entry also keeps `sensitiveFiles` and `sensitiveOurs`. The validator and the board server read both from there. `gary item` sets `garyFix` too, for a PR of the instance's own repo.

`kind` is `opened`, `comment`, `reply` (discussion replies), `review` or `thread_comment`. `side` is `automated` when the body matches an `automatedComments` pattern, `us` for maintainers, `me` and the configured bot, `bot` for GitHub Apps, `[bot]` accounts and the Copilot agent, and `them` for everyone else. Only `us` and `them` decide `waitingOn`. The timeline reads the last 50 comments, the last 20 replies per discussion comment and the last 20 comments per review thread. A discussion comment with more replies gets them all, up to 300, through extra calls. `dependencyOnly` needs the complete file list and only manifests, lock files and version pin files in it. `hasClosingPr` counts closing PRs that are open or merged.

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

1. Run `gary paths` and `gary models`, and read `config.json` and the profile. Take the run lock. Check the profile's `requiredTools`.
2. Process queued action files in `<state>/board/actions/` that the master handed it. They are agent requests and go onto this run's work list. Write back status and result.
3. Run `gary snapshot`.
4. Delete the items for `closed` ids with `gary put items <id> --delete`. Queue a round for other people's feedback on each watched PR that has some no round handled, with `gary pr-watch list --json` and `gary pr-watch round --by others`, and take those PRs out of `changed` for this run, see "Watched PRs".
5. Quick-classify every `changed` item. Pick up to `maxFullReviewsPerRun` for a full review: first items that need analysis, then contributor PRs, then items in `active`, then the rest by updatedAt.
6. Run full reviews as parallel subagents on the `review` model. PRs use `triage-review-pr`, issues and discussions use `triage-issue`.
7. Attempt up to `maxAutoFixesPerRun` fixes that the issue triage marked as solvable.
8. Write each item as a complete doc with `repo`, with `gary put`, which keeps the maintainer's fields. Clear `hidden` on changed items with `gary put --merge`. Apply the autonomous label and assignment changes with `gary action --autonomous`.
9. Write `meta.json`. Run `gary snapshot --commit`. Write `summary.txt`.

## One server, one master (target design, supersedes conflicting text above)

This section is the contract for the single-server change. Where an older section disagrees, this one wins, and the older section gets rewritten to match.

### Processes

- One board server per machine serves every instance. One port, in `<root>/config.json` as `{ "port": 7878 }`. Instance configs have no port. The root config also holds the machine's `models`.
- One master Claude session owns the server and the one queue watcher. It starts one worker per instance for the hourly triage and one worker per agent request. A worker is a child session when the harness has tools for that, otherwise a headless run, otherwise the master does the job itself with subagents. The first two start on the instance's `worker` model.
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
  - `board`: `{ me: { login, avatarUrl }, dryRun, instances: [ { name, title, kind, repos: ["owner/name"], repoUrl, bot: { login, avatarUrl } | null, accountMode, paused, relatedRepos, botCommands, escalateAs, reviewBots } ] }`. `title` is the profile's `name`.
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
