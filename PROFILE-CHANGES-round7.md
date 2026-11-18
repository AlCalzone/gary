# Profile changes for round 7: the automatic first review

Nothing here is applied. The live profile and the live instance config are untouched. The feature stays off until step 3 is done.

## 1. `profile.json`: two new fields

```json
"autoReviewPaths": { "config": ["packages/config/config/devices/**"] },
"formatCommand": "yarn fmt"
```

- `autoReviewPaths.config` decides which PRs are of the kind `config`: every changed file must match one of the globs. The glob above also covers `packages/config/config/devices/templates/**`. A PR that changes a shared template then counts as a config PR too. Use `packages/config/config/devices/0x*/**` to keep template changes for yourself: it matches only the manufacturer folders. It also covers each manufacturer's own `templates/` folder.
- `formatCommand` is the command the review names when a PR does not allow edits by maintainers. `yarn fmt` is what the repo's own instructions tell contributors to run. Use `null` to say nothing about formatting on such PRs.
- None of the profile's `sensitivePaths` lies under the config path, so the two lists do not overlap. A PR that touches both kinds of path gets no automatic review.

## 2. `templates/`: three new files

All three are optional. Without a file, or with a file that holds only its comment, Gary uses the default below. Each file starts with an HTML comment like the existing templates. Gary's code strips it and appends the rest as it stands.

`templates/auto-review-closing.md`, the last sentence of a review with findings:

```
<!-- The last sentence of an automatic review that has findings. Appended by Gary's code as it stands. -->
A maintainer will review this PR after these are addressed.
```

`templates/format-offer.md`, the paragraph that offers the format commit. `{files}` becomes a count like "2 files":

```
<!-- The paragraph in an automatic review that offers to push the formatter's changes. Appended by Gary's code. {files} becomes the count. -->
The project's formatter would change {files} in this PR. I can push that as one commit to your branch. React to this review with a thumbs-up or reply here, and I will do it.
```

`templates/format-command.md`, the paragraph for a PR that does not allow edits by maintainers. `{command}` becomes `formatCommand`:

```
<!-- The paragraph in an automatic review on a PR that does not allow edits by maintainers. Appended by Gary's code. {files} becomes the count, {command} the profile's formatCommand. -->
The project's formatter would change {files} in this PR. Please run `{command}` and push the result.
```

The texts above are the core defaults. Edit them to your wording. Keep the offer's two ways to accept, because the code accepts exactly those: a thumbs-up, heart, hooray or rocket on the review, or a reply that says yes.

## 3. Instance `config.json`: the switch

```json
"autoReview": { "enabled": true, "kinds": ["config"], "maxPerRun": 3 }
```

- Without the field the feature is off.
- `maxPerRun` is the number of automatic reviews one run may post. `3` is the default. Start with `1` to watch the first ones go out.
- `gary doctor` shows the setting and warns when it is on and cannot run.
- `gary pause` stops it like every other write. A paused run records each review it would have posted in its `would-have.json`.

## 4. `rules/review.md`: what counts as certain for config PRs

Optional, but it decides what goes out. The core rule is: a finding is certain only when it names a concrete case. For config PRs a paragraph like this under "Device config PRs" makes it concrete:

```
A finding on a device config file is certain (`certain: true`) only when the `review-config-pr` skill reports it as a violation of `.agents/instructions/config-files.md`, or when the value contradicts the manual or the device database entry that the PR itself links. The evidence names the rule or the page. Whether a parameter is worth exposing, how a label reads, and anything that needs the device on the desk are not certain.
```

## 5. To check once on the real repo

- The "Re-request review" button for `zwave-js-bot`: after its first automatic review, press it on a test PR as the PR author and run `gary item pr <n>`. `facts.reReviewRequests` must list the request. I could not verify against GitHub that a PR author without write access gets this button for a user account, and that the event names the bot as `requestedReviewer`.
- A thumbs-up on the review summary: `gary item pr <n>` must show `facts.formatOffer.acceptedByReaction: true`. The query reads `reactions` on the `PullRequestReview` node, and I could not verify it against GitHub.
