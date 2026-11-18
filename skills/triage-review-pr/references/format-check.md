# Format check

Formatting, indentation, import order, trailing commas and everything else the project's formatter or lint autofix corrects is never a finding, never a word in `state` or `story`, and never an inline comment. Machines fix it. This check only asks whether they would change anything.

The profile's `rules/review.md` names the autofix commands per file type, with a `{files}` placeholder. When it names none, skip the check and leave `autofix` out.

## Rules

- Tools, their versions and every configuration come from `<checkout>` at the base branch, never from the PR. Lint configs are code, and the PR's code is never executed.
- The PR's files are data. Copy them in as text. Never copy a file that a tool loads as configuration or code, like a lint or formatter config, a plugin or a `package.json`. Such files match the profile's `sensitivePaths`, and a PR touching them gets no format check.
- Run the commands on exactly the files the PR changed and still has (added or modified, not deleted).

## Steps

1. Create a throwaway worktree of the base branch and give it the checkout's installed tools:
   ```bash
   git -C <checkout> fetch origin <base branch>
   git -C <checkout> worktree add --detach <scratch>/format-<number> origin/<base branch>
   ln -s <checkout>/node_modules <scratch>/format-<number>/node_modules
   ```
   The profile may name another way to provide the tools.
2. For each changed file, write the PR's version into the worktree at the same path: `gh api "repos/<owner>/<repo>/contents/<path>?ref=<sha>" -H "Accept: application/vnd.github.raw" > <worktree>/<path>`. `<sha>` is the head you check, `reviewedSha` in a review.
3. Stage that state: `git -C <worktree> -c core.hooksPath=/dev/null add -A`. It is the PR's version of those files.
4. Run each command from the profile in the worktree, with `{files}` replaced by the changed paths of its file type. Pass `-c core.hooksPath=/dev/null` to every git call.
5. Read the result: `git -C <worktree> diff --numstat`. Any line means the autofix changes something. Count the files and the added plus removed lines.
6. Keep the patch when the caller needs it: `git -C <worktree> diff > <scratch>/format.patch`. Then remove the worktree with `git -C <checkout> worktree remove --force <worktree>`.

## Result

```json
"autofix": { "changes": true, "files": 2, "lines": 14, "tools": ["oxfmt", "oxlint --fix"] }
```

`tools` lists the commands that changed something. Without changes: `{ "changes": false, "files": 0, "lines": 0, "tools": [] }`. `changes` is true exactly when `files` is above 0.

When a command fails, leave `autofix` out and say so in a finding of severity `question`, with the command and its error line. A failing formatter is no verdict on the PR.
