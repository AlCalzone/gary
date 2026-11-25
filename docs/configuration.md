# Configuration

Gary has three layers. Each kind of change has one place.

- **Core**: this repository. It holds no repo name, no account name and no path of one machine. Nobody edits it to adapt the tool.
- **Profile**: one directory per project, named by `profile` in the instance's `config.json`. It can live in its own repo or inside your project.
- **Home**: `~/.config/gary/` or `$GARY_HOME`.

```
~/.config/gary/
  config.json                 the board's port, default models
  personal.md                 your rules and writing style, for all projects
  instances/<name>/
    config.json               this project on this machine
    personal.md               optional, your rules for this project
    state/                    the board's data
```

The agents read a rule in this order: core, the profile file of the same topic, the shared `personal.md`, the instance's `personal.md`. A later file wins.

The limits in [safety.md](safety.md) cannot be changed by a profile or by `personal.md`.

## The profile

`profiles/template/` is the skeleton. The `triage-setup` skill fills it from your repo.

`profiles/gary/` is the profile Gary uses for its own repository. It is a small real example.

- `profile.json`: project facts, see below.
- `rules/classification.md`: what goes into which category.
- `rules/voice.md`: the project's texts, like canned requests and their links. How you write goes into `personal.md`.
- `rules/review.md`: how PRs are reviewed, the CI jobs that fail on formatting.
- `rules/issues.md`: how issues and discussions are triaged.
- `templates/*.md`: canned texts, like a request for logs.

`profile.json` may carry `//` comments and trailing commas. The template explains every field in a comment.

Fields of `profile.json`:

| Field | Meaning |
| --- | --- |
| `name`, `repo` | The project's name and its `owner/name` |
| `maintainers` | Logins that count as "us" |
| `botLogins` | Bots whose posts count as automated |
| `reviewBots` | Review bots Gary may request, today only `copilot`. Empty means no review bot rounds |
| `relatedRepos` | Repos an item can be moved to |
| `sensitivePaths` | Globs no agent may touch in someone else's PR, like `.github/**` |
| `autoLabels` | Labels Gary may set without a click |
| `botCommands` | Commands your bot understands, like `escalate` |
| `escalateResult` | Pattern of the comment your bot posts after it turned a discussion into an issue |
| `automatedComments` | Patterns of bot comments that are noise |
| `aiAuthors` | Logins whose PRs count as AI-written |
| `autoReviewPaths` | Paths the automatic first review may cover |
| `formatCommand` | The command a contributor runs to format, named by the automatic review when Gary cannot push |
| `autofixCommands` | Formatter and lint autofix commands with the placeholder `{files}`, default `[]`, see below |
| `autofixSetup` | One command that prepares a fresh worktree of the base branch, default `null`, see below |
| `mergeMethod` | `squash`, the default, `merge` or `rebase`. How Gary merges, and whether the PR title becomes the commit message |
| `commitFormat` | `"conventional"` when the repo uses conventional commits, or `null`, the default. Sets the format of the commit message of an API edit |
| `requiredTools` | Tools the agents need, like an MCP server for logs |
| `dueDateFields` | GitHub Project fields read as due dates |

### Format check

```json
{
  "autofixCommands": [
    "npx prettier --write --ignore-unknown {files}",
    { "run": "npx eslint --fix {files}", "files": ["**/*.ts", "**/*.js"] }
  ],
  "autofixSetup": "ln -s {checkout}/node_modules node_modules"
}
```

Each review runs these commands on the PR's changed files, in a fresh worktree of the base branch. Gary never reviews style. It shows a badge and a "Format" card that commits exactly what the commands change.

- `{files}` becomes the changed paths.
- The form `{ "run", "files" }` limits a command to the changed files that match its globs.
- A command without `{files}`, like `yarn lint --fix`, runs on the whole project. Only its changes to the PR's files count.
- `autofixSetup` runs first, in that worktree. `{checkout}` becomes the instance's checkout. Use it to install or link the tools, like `npm ci`.
- Setup and commands use the base branch's tools and configuration, never code from the PR.

With an empty `autofixCommands`, the default, there is no format check, no badge, no "Format" card and no format offer.

## An instance's config.json

| Field | Default | Meaning |
| --- | --- | --- |
| `profile` | | Path of the profile directory |
| `me` | | Your GitHub login |
| `checkout` | | Local checkout of the repo |
| `bot` | `null` | `{ "login", "tokenFile" }` of the bot account |
| `allowOwnTokenPushes` | `false` | Without a bot, run writes under your own login |
| `activeWindowDays` | `30` | Issues and discussions without activity for longer are left out |
| `maxFullReviewsPerRun` | `10` | Full reviews per hourly run |
| `maxAutoFixesPerRun` | `2` | Fixes Gary starts on its own per run. `0` turns them off |
| `maxPendingAutoFixes` | `10` | Open automatic fixes at a time |
| `fixReview` | | Review rounds on Gary's own fix PRs, see below |
| `autoReview` | off | The one review without a click, see [safety.md](safety.md#the-automatic-first-review) |
| `escalateAs` | `prefill` | `me` posts the escalate command under your login after your click |
| `fastTier` | `off` | A faster model for obvious items, see below |
| `models` | | Models per role, see below |
| `tab` | | The project's look on the board, see below |

`gary doctor` and `gary setup` refuse unknown fields, so typos get caught.

### Tab

```json
{ "tab": { "icon": "zap", "color": "#0071bc", "background": true, "favorite": true } }
```

- `icon`: an image file, or one of `zap`, `home`, `star`, `globe`, `heart`, `user`, `shield`, `bot`, `sparkles`, `wrench`, `lightbulb`, `plug`, `eye`, `pr`, `issue`, `discussion`, `commit`, `comments`.
- `color`: a hex color, or one of `orange`, `blue`, `green`, `purple`, `rose`, `gray`.
- `background`: tint the whole page in that color while the tab is open. The board derives every surface, line and accent from the one color.
- `favorite`: show this tab before the others.

### Models

By default the master and the workers run on Sonnet. Every review, fix and push runs on Opus. The quick classification runs on Sonnet.

```json
{ "models": { "master": "sonnet", "worker": "sonnet", "review": "opus", "standard": "sonnet", "fast": "haiku" } }
```

Set it in `~/.config/gary/config.json` for the machine, or in an instance's `config.json` for one project. `gary models` prints what applies.

The master's own model is set on the scheduled task. The `triage-setup` skill does that or tells you where.

### Fast tier

Obvious items, like a green dependency update, can be classified by a smaller model. `fastTier` controls it:

- `off`: the default.
- `shadow`: the fast model runs next to the standard one, without effect. Gary compares both.
- `on`: the fast model decides obvious items.

Gary suggests switching to `on` once both agree on at least 95 percent of 40 or more comparisons. In `on` mode it keeps checking a sample. It suggests going back when the fast model does worse.

Both suggestions are cards on the board. Your click changes the setting. `gary shadow report --week` shows the numbers.

### Review rounds on fix PRs

```json
{ "fixReview": { "reviewer": "copilot", "requestAs": "me", "maxRounds": 3, "markReady": true } }
```

On its own fix PRs Gary requests a review from the review bot, pushes fixes for its comments, and marks the PR ready. `"reviewer": "off"` turns that off. Without a review bot in the profile's `reviewBots`, a fix PR skips the rounds: Gary marks it ready and puts it on your board right after it opens.

## Your contributions elsewhere

A contributions instance follows your own threads in repos outside your projects:

- your open PRs, issues and discussions
- the PRs that wait for your review
- the threads you commented on, reviewed or were mentioned in

```sh
gary setup --kind contributions --exclude "your-name/*"
gary --instance contributions doctor
```

It is its own tab. It needs no profile, bot or checkout. Gary posts nothing to GitHub for it. A reply card copies the text and opens the thread.

On a PR you opened, a requested code change gets a "Drive" card. Your click lets an agent make the change and push it to the PR's branch under your login. Such a PR also has "Focus". Both need a clone of the repo. Gary looks for one in the directories of `checkoutRoots`, by the git remotes of their direct children, and clones the repo fresh under the instance's state directory when it finds none. It works in a new worktree of its own and never touches your working tree. See [safety.md](safety.md#pushes-to-your-own-prs).

Next to Act, Unblock, Land and Decide it has a fifth category, **FYI**: something new and relevant happened, and there is nothing to do. Examples are a maintainer's decision, a release with your fix, or your PR merged by someone else.

A PR that requests your review can get a review draft: findings, inline comments you can uncheck or edit, and a short walkthrough of the PR for a reader who has not seen it. "Prepare pending review on GitHub" turns the draft into a pending review under your login, which only you see. You pick the verdict and submit it on GitHub. Drafts start only on your click ("Prepare review") unless `maxAutoReviewDraftsPerRun` is above 0. The card says why a draft did not start by itself.

"Got it" hides an FYI item until there is news again. With `"clearNotifications": true` it also marks the thread's notification as done in your GitHub inbox. A new comment brings the notification back. Noise like "+1" comments, bot posts, label changes and CI reruns never shows up.

Its `config.json`:

| Field | Default | Meaning |
| --- | --- | --- |
| `kind` | | `"contributions"` |
| `me` | | Your GitHub login |
| `include`, `exclude` | `[]` | Repos as `owner/name` or `owner/*` |
| `maxItems` | `150` | Cap of one snapshot. The snapshot says when the cap cuts |
| `activeWindowDays` | `30` | Threads without activity for longer are left out |
| `mergeReminderDays` | `14` | Quiet days before an approved PR you cannot merge gets a reminder for the repo's maintainers |
| `mergeReminderDaysFor` | `{}` | The same per repo, like `{ "acme/*": 30 }`. An exact `owner/name` wins over `owner/*` |
| `clearNotifications` | `false` | "Got it" also marks the thread's notification as done in your GitHub inbox |
| `maxAutoReviewDraftsPerRun` | `0` | Review drafts Gary starts on its own per run, for PRs that request your review. `0` turns them off. A click always works |
| `maxPendingAutoReviewDrafts` | `5` | Automatic review drafts that may wait for you at once. A draft waits until you prepared its pending review, used another card, snoozed or dismissed it, or the PR closed or stopped requesting your review |
| `reviewDraftMaxLines` | `800` | A PR with more changed lines never gets a review draft without your click |
| `checkoutRoots` | `[]` | Directories whose direct children Drive and Focus search for a clone of your PR's repo, like `["~/repositories"]`. At most 20, each absolute or starting with `~/` |
| `models`, `tab` | | As above |
