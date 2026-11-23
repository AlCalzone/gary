# Format check

Formatting, indentation, import order, trailing commas and everything else the project's formatter or lint autofix corrects is never a finding, never a word in `state` or `story`, and never an inline comment. Machines fix it. This check only asks whether they would change anything.

The commands come from the profile. Read `autofixCommands` and `autofixSetup` in `<profile>/profile.json`. A missing field has its default: `[]` and `null`.

```json
"autofixCommands": ["npx prettier --write --ignore-unknown {files}", "npx eslint --fix {files}"],
"autofixSetup": "ln -s {checkout}/node_modules node_modules"
```

When `autofixCommands` is empty, skip the check and leave `autofix` out. Then the item has no `format` route, and the automatic first review makes no format offer.

## Rules

- Tools, their versions and every configuration come from `<checkout>` at the base branch, never from the PR. Lint configs are code, and the PR's code is never executed. `autofixSetup` and the commands run only in the worktree of the base branch below. The setup runs before the PR's files are copied in.
- The PR's files are data. Copy them in as text. Never copy a file that a tool loads as configuration or code, like a lint or formatter config, a plugin or a `package.json`. Such files match the profile's `sensitivePaths`, and a PR touching them gets no format check.
- A PR with `facts.sensitiveOurs` gets the check for its other files. Leave out every changed file that matches `sensitivePaths`: do not copy it and do not pass it to a command. The tools and configs still come from the base branch, also when the PR is ours. When one of the PR's sensitive files is a config of the formatter or the linter itself, skip the check and leave `autofix` out, because the base branch's config would judge the files by rules the PR changes.
- Run the commands on exactly the files the PR changed and still has (added or modified, not deleted).

## Steps

1. Create a throwaway worktree of the base branch:
   ```bash
   git -C <checkout> fetch origin <base branch>
   git -C <checkout> worktree add --detach <scratch>/format-<number> origin/<base branch>
   ```
   When `autofixSetup` is set, run it in the worktree before step 2, with `{checkout}` replaced by `<checkout>`. It installs or links the tools, like `npm ci` or `ln -s {checkout}/node_modules node_modules`. When it fails, stop as described under "Result".
2. For each changed file, write the PR's version into the worktree at the same path: `gh api "repos/<owner>/<repo>/contents/<path>?ref=<sha>" -H "Accept: application/vnd.github.raw" > <worktree>/<path>`. `<sha>` is the head you check, `reviewedSha` in a review.
3. Stage that state: `git -C <worktree> -c core.hooksPath=/dev/null add -A`. It is the PR's version of those files.
4. Run each command of `autofixCommands` in the worktree, in the listed order, with `{files}` replaced by the changed paths, each quoted for the shell. Every command gets every path. A command that handles only some file types needs its own option to skip the others, like `--ignore-unknown` for prettier. Pass `-c core.hooksPath=/dev/null` to every git call.
5. Read the result: `git -C <worktree> diff --numstat`. Any line means the autofix changes something. Count the files and the added plus removed lines.
6. Keep the patch when the caller needs it: `git -C <worktree> diff > <scratch>/format.patch`. Then remove the worktree with `git -C <checkout> worktree remove --force <worktree>`.

## Result

```json
"autofix": { "changes": true, "files": 2, "lines": 14, "tools": ["oxfmt", "oxlint --fix"] }
```

`tools` lists the commands that changed something. Without changes: `{ "changes": false, "files": 0, "lines": 0, "tools": [] }`. `changes` is true exactly when `files` is above 0.

When the setup or a command fails, leave `autofix` out and say so in a finding of severity `question`, with the command and its error line. A failing formatter is no verdict on the PR.
