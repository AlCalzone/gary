---
name: triage-setup
description: Set up the triage board for a maintainer's own GitHub project, or add another project as a new Gary instance. Runs gary setup, drafts a project profile (profile.json and rules files) by reading the repo's labels, CODEOWNERS, contributing guide, issue templates and workflows, runs gary doctor and creates the hourly scheduled triage task. Use when a maintainer wants to start using the triage board, add a project to it, or create or redo a triage profile.
---

# Set up the triage board

You walk a maintainer through setting up the triage board for his repo. You read his repo and draft the profile. He reviews every file before it is used. You never write to GitHub: no labels, no comments, no settings, no pushes.

Ask one question at a time, and only for facts you cannot read from the repo or the local machine.

## 1. Install and instance

Gary runs one instance per repo. Each instance has its own config, board and port, state, pause switch, decision log and scheduled task, under `~/.config/gary/instances/<name>/`. The shared `~/.config/gary/personal.md` holds his rules for all projects.

Run `gary instances` first. When one exists already, this is a second project: create a new instance, and leave the existing ones alone.

Choose the instance name with him: short, lowercase, after the repo, like `widgets` for `acme/widgets`. Run `gary setup --instance <name>`. It creates the instance directory with `config.json` and `state/`, gives the instance its own port, and links the launcher when the tool runs from a clone. Then run `gary --instance <name> paths` and note `<core>`, `<home>`, `<profile>` and `<config>`. Pass `--instance <name>` on every later `gary` command in this setup.

Ask for:

- the repo, as `owner/name`,
- his GitHub login, to check against `gh api user --jq .login`,
- whether a bot account posts for him. If yes: its login and the path of a file with its token. The token file stays on his machine. Never print it.
- without a bot: whether agents may push and post under his own `gh` login (`allowOwnTokenPushes`). Explain the tradeoff in one sentence: with it, agents can open fix PRs and address reviews, without it every bot route becomes text he posts himself.

Write these into `<config>` (SPEC.md "Home"). Leave the limits at their defaults.

## 2. Draft the profile

Create `profiles/<name>/` as a copy of `<core>/profiles/template/`, in a place he chooses. The profile can live in its own repo or in his project, so his team can share it. Instances of the same project on different machines can share one profile, for example as a git repo each machine clones. Set `profile` in the instance's `config.json` to that directory. When a profile for this project exists already, point to it and skip the drafting.

Read the repo with `gh` and from a local clone, read-only:

- `gh label list --repo <repo> --limit 200 --json name,description`: candidates for `autoLabels` and for label rules.
- `CODEOWNERS`, `CONTRIBUTING.md`, `AGENTS.md`, `CLAUDE.md`, `.github/copilot-instructions.md`: maintainers, standards, the commit format.
- `.github/ISSUE_TEMPLATE/` and `.github/DISCUSSION_TEMPLATE/`: what reporters must provide, where support happens, links to logging guides.
- `.github/workflows/`: bot commands the automation reacts to, review bots, known CI jobs.
- `gh repo list <owner> --json name,hasIssuesEnabled,isArchived`: candidates for `relatedRepos`.
- The last 20 closed issues and merged PRs with the maintainer's comments: how he replies, which labels he sets when, what he asks for.

Draft from that:

1. `profile.json` with the SPEC.md shape. `sensitivePaths` starts with `.github/**`, the agent instruction files and the dependency manifests and lock files the repo uses. `botCommands` lists only commands the workflows really react to. Leave `reviewBots` empty unless a review bot already reviews PRs in the repo.
2. `rules/classification.md`, `rules/voice.md`, `rules/review.md` and `rules/issues.md`, following the guide in each template file. Write only rules you found evidence for, and quote that evidence in your summary to him.
3. `templates/request-logs.md` when the project asks reporters for logs, with the logging guide the issue templates already link. `templates/reopen-elsewhere.md` when `relatedRepos` is not empty.

Show him a short summary per file and let him edit before you go on. He owns the wording.

## 3. Personal rules

Ask whether he has writing rules or personal preferences for replies. Put rules for all his projects, or a pointer to a file that holds them, into the shared `~/.config/gary/personal.md`. Rules for this one project's instance only go into `<home>/personal.md`, which is read after the shared one. Both are read last and win over the profile.

## How Gary learns

Tell him this in two or three sentences. The board logs his decisions locally: dismissed cards, alternatives he picks over the recommendation, drafts he rewrites, thread verdicts he flips, notes to the agent. Once a day, the `triage-learn` skill looks for recurring patterns and proposes up to three small rules for the profile or `personal.md`. He accepts or dismisses each proposal on the board, and nothing changes in his rules without that.

## 4. Check

Run `gary --instance <name> doctor` and fix what it reports together with him. `gary doctor --all` checks every instance. It checks the config, the profile, the tools in `requiredTools`, `gh` access and the bot token.

## 5. Schedule

Create one hourly scheduled task per instance. It runs the `triage-routine` skill in one master session, with the repo's local clone (`<checkout>`) as the session's project directory, and its prompt names the instance, like `Run the triage routine for Gary instance widgets.` Use the scheduling tool the harness offers. Then start the first run, so he sees the board fill.
