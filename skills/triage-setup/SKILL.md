---
name: triage-setup
description: Set up the triage board for a maintainer's own GitHub project, or add another project as a new Gary instance, or add a contributions instance for his own threads in other repos. Runs gary setup, drafts a project profile (profile.json and rules files) by reading the repo's labels, CODEOWNERS, contributing guide, issue templates and workflows, runs gary doctor and creates the hourly scheduled triage task. Use when a maintainer wants to start using the triage board, add a project to it, or create or redo a triage profile.
---

# Set up the triage board

You walk a maintainer through setting up the triage board for his repo. You read his repo and draft the profile. He reviews every file before it is used. You never write to GitHub: no labels, no comments, no settings, no pushes.

Ask one question at a time, and only for facts you cannot read from the repo or the local machine.

## 1. Install and instance

Gary runs one instance per repo. Each instance has its own config, state, pause switch and decision log, and its own tab on the one board, under `~/.config/gary/instances/<name>/`. The shared `~/.config/gary/personal.md` holds his rules for all projects.

Run `gary instances` first. When one exists already, this is a second project: create a new instance, and leave the existing ones alone.

Choose the instance name with him: short, lowercase, after the repo, like `widgets` for `acme/widgets`. Run `gary setup --instance <name>`. It creates the instance directory with `config.json` and `state/`, and links the launcher when the tool runs from a clone. Then run `gary --instance <name> paths` and note `<core>`, `<home>`, `<profile>` and `<config>`. Pass `--instance <name>` on every later `gary` command in this setup.

Ask for:

- the repo, as `owner/name`,
- his GitHub login, to check against `gh api user --jq .login`,
- whether a bot account posts for him. If yes: its login and the path of a file with its token. The token file stays on his machine. Never print it.
- without a bot: whether agents may push and post under his own `gh` login (`allowOwnTokenPushes`). Explain the tradeoff in one sentence: with it, agents can open fix PRs and address reviews, without it every bot route becomes text he posts himself.

Write these into `<config>` (SPEC.md "Home"). Leave the limits at their defaults.

## 1a. A contributions instance

A contributions instance follows his own GitHub activity outside the repos of his maintainer instances: his own open PRs, his issues and discussions, the PRs that wait for his review, and the threads he commented on, reviewed or was mentioned in. It shows as its own tab on the board. It has no profile, no bot and no checkout, and Gary writes nothing to GitHub for it: every reply is a text the board copies for him. Offer it once his maintainer instances exist, and set it up only when he wants it.

Ask for the repos to leave out beyond his maintainer instances, like his own personal projects that are really maintainer work, as `owner/name` or `owner/*`. Then run:

```bash
gary setup --kind contributions --me <login> [--exclude "<owner>/*,<owner>/<name>"] [--include …] [--title "Contributions"] [--max-items 150]
```

The instance is called `contributions` unless `--instance` names another. Skip steps 2 and 3 for it: there is no profile to draft, and his personal rules apply as they are. Run `gary --instance contributions doctor`. It checks his `gh` login and its scopes, names the maintainer repos and the `exclude` list it leaves out, and states the cap. With `repo` in the scopes the searches find private repos too. The first snapshot says when `maxItems` cuts it. Then he narrows `include`, adds to `exclude` or raises `maxItems` in its `config.json`. The hourly master task picks the instance up without a change.

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

1. `profile.json` with the SPEC.md shape. `sensitivePaths` starts with `.github/**`, the agent instruction files and the dependency manifests and lock files the repo uses. `botCommands` lists only commands the workflows really react to. `escalateResult` is the regular expression for the comment the bot posts after it turned a discussion into an issue, with the issue number as its one group, like `^Escalated to an issue: #(\\d+)` in JSON. Take the text from the workflow's source. Set it only when the bot account itself posts that comment. Leave `reviewBots` empty unless a review bot already reviews PRs in the repo. `autoReviewPaths.config` names the globs of the project's data or config files when it has such a category with its own rules, and `formatCommand` the one command a contributor runs to format. Both only matter once the maintainer turns `autoReview` on in his `config.json`. Never turn it on for him: it lets a review reach contributors without his click, so he sets it himself.
2. `rules/classification.md`, `rules/voice.md`, `rules/review.md` and `rules/issues.md`, following the guide in each template file. Write only rules you found evidence for, and quote that evidence in your summary to him.
3. `templates/request-logs.md` when the project asks reporters for logs, with the logging guide the issue templates already link. `templates/reopen-elsewhere.md` when `relatedRepos` is not empty.

Show him a short summary per file and let him edit before you go on. He owns the wording.

## 3. Personal rules

Ask whether he has writing rules or personal preferences for replies. Put rules for all his projects, or a pointer to a file that holds them, into the shared `~/.config/gary/personal.md`. Rules for this one project's instance only go into `<home>/personal.md`, which is read after the shared one. Both are read last and win over the profile.

## How Gary learns

Tell him this in two or three sentences. The board logs his decisions locally: dismissed cards, alternatives he picks over the recommendation, drafts he rewrites, thread verdicts he flips, notes to the agent. Once a day, the `triage-learn` skill looks for recurring patterns and proposes up to three small rules for the profile or `personal.md`. Once a week, the `triage-reconcile` skill proposes changes to rules that repeat, conflict or name things that no longer exist. He accepts or dismisses each proposal on the board, and nothing changes in his rules without that.

## 4. Check

Run `gary --instance <name> doctor` and fix what it reports together with him. `gary doctor --all` checks every instance. It checks the config, the profile, the tools in `requiredTools`, `gh` access and the bot token.

## 5. Schedule

One scheduled task runs Gary for the whole machine. It runs the `triage-master` skill every hour, which starts a worker per instance and serves one board on the root port (`<root>/config.json`, set with `gary setup --port`). Check with the harness's scheduling tool whether that task exists. If it does, adding a project needed only the new instance: the next hourly run picks it up, and the board shows its tab without a restart. If it does not, create it with the prompt below and any project directory, then start the first run, so he sees the board fill.

```
Run the triage-master skill. Models come from `gary models`.
```

The prompt names no model. Which model does what is the `models` setting (SPEC.md "Models"): the root `config.json` sets it for the machine, and an instance's `config.json` overrides `worker`, `review`, `standard` and `fast` for its project. Leave it at the defaults unless he asks for other models. `gary --instance <name> models` prints what applies.

The master session's own model is `master` in that output. No skill can change the model of a running session, so set it here, on the task or on the thread it posts into:

- When the host has a tool that sets a thread's or a task's model, use it. In T3 Code that is `t3_thread_configure` with `modelSelection.model` on the task's thread. Take the host's name for the model from its own list, like `orchestrator_capabilities`.
- Otherwise tell him which model to pick for the task, and where the host has that setting.

Do the same when he changes `models.master` later. `gary doctor` prints `master` in its `models` line and cannot check it, because it does not see the master session.
