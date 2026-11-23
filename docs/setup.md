# Setup

## Requirements

- Node 24 or newer
- the `gh` CLI, logged in as you
- Claude Code, in any harness that can run a scheduled session every hour
- optional: a bot account with a token file

## Install

As a Claude Code plugin:

```sh
claude plugin marketplace add AlCalzone/gary
claude plugin install gary@gary
gary setup
```

From a clone:

```sh
git clone https://github.com/AlCalzone/gary.git
cd gary && npm install
bin/gary setup --register-mcp
```

`gary setup` asks for your GitHub login, the first repo, its local checkout and the account setup. It creates `~/.config/gary/` with an empty `personal.md` and one instance in `instances/<name>/`.

It never overwrites an existing `config.json` without `--force`. It never touches an existing `personal.md`.

From a clone it also links the skills into `~/.claude/skills` and the `gary` command into `~/.local/bin`. That folder must be on your `PATH`.

A plugin install puts `gary` on the `PATH` inside Claude Code sessions only. There you type `! gary pause`, or you ask Claude to run it.

## Accounts

Pick one of three setups:

- **With a bot account**: replies, reviews, labels and pushes that you approve go out as the bot. `setup` asks for its login and a file with its token. This setup has the most one-click actions.
- **Without a bot**: Gary prepares texts and you post them on GitHub. Actions without a text, like a label or a transfer, are not offered. Agents push nothing.
- **Without a bot, own token allowed**: like the first setup, but everything runs under your own `gh` login. Set `allowOwnTokenPushes` in the instance's `config.json`.

## Create the profile

Start a Claude session and ask it to set up Gary. The `triage-setup` skill reads your repo, read-only: labels, CODEOWNERS, the contributing guide, issue templates, workflows and your recent replies.

It drafts the profile for you to review:

- `profile.json`: the repo, maintainers, bot logins, related repos, sensitive paths, labels Gary may set on its own, bot commands.
- `rules/*.md`: how items are classified, how you write, how PRs and issues are reviewed.
- `templates/*.md`: canned texts, like a request for logs.

It asks only what it cannot read: your login, whether a bot posts for you, and your writing preferences.

Then it runs `gary doctor` and creates the hourly scheduled task. It never writes to GitHub.

## How it runs

One master Claude session runs everything. One scheduled task starts it every hour.

1. The master starts the board server.
2. It starts one worker per project for the triage.
3. It watches the queue and starts a worker for each agent request you click. A request starts within seconds.

A worker is a child session where the harness supports it. Otherwise it is a headless `claude -p` run. Otherwise the master does the job itself.

## More projects

Ask Claude to set up Gary for the next repo. The skill creates a new instance next to the existing ones.

The board picks it up without a restart, and the next hourly run includes it. Each instance has its own settings, pause switch and decision log.

## Commands you run

Run these in any terminal. Every other `gary` command is for the agents, see [internals.md](internals.md).

- `gary setup`: install or reconfigure. `--instance <name>` adds a project. `--kind contributions` adds the tab for your threads in other repos.
- `gary doctor`: check the installation without changing anything.
- `gary instances`: list the projects on this machine.
- `gary pause` and `gary resume`: stop and allow writes to GitHub.
- `gary models`: print which model runs which role.
- `gary decisions --since <date>`: show the log of your decisions that Gary learns from.
- `gary proposals`: list the rule proposals and their status.
- `gary reconcile`: ask Gary to check its rules now.
- `gary validate`: check the stored items against the rules, read-only.
- `gary auto-review list`: show the reviews Gary posted without a click.
- `gary focus list` and `gary focus end <itemId>`: show and end focus sessions.
- `gary serve`: start the board server without a Claude session.

With one project, the current folder does not matter. With several, `gary` picks the project from the folder you are in: its checkout or one of its worktrees.

Elsewhere, name it with `--instance <name>`. `pause`, `resume` and `doctor` also take `--all`. When `gary` cannot tell which project you mean, it lists them and does nothing.

## Pause

`gary pause` stops every write to GitHub at once. The board stays up and nothing needs a restart.

While paused:

- A click that would post, review, label or transfer is refused with "Gary is paused. Nothing was sent."
- Agent requests queue and start after `gary resume`.
- Snoozing, dismissing a suggestion and deciding proposals keep working.
- The hourly run still triages. It records what it would have labeled, fixed or reviewed.
