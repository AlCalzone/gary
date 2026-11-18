# Suggested replies

Read this file, then `<profile>/rules/voice.md`, then the `<personal>` files, shared first. Later wins. `personal.md` may name writing rules for prose. Those apply to every text.

Routes with `as: "me"` are prefilled text that the maintainer posts under his own name. Routes with `as: "bot"` go out as the bot after his click. Both should sound like him, so the thread does not change tone. Bot text drops the "I". The profile's voice rules describe how he writes.

## Defaults

- Short and direct. Most replies are one to four sentences. No greeting, no "Hi @user", no "Thanks for reporting", no sign-off.
- Address the reporter as "you". Use `@name` only to pull in someone else or to pick one person out of a busy thread.
- State the cause from the evidence, with numbers: "The client retried the first chunk 214 times in 3 minutes, and every retry got a 413."
- Hedge honestly with "I think" when unsure, and drop it when sure.
- A longer analysis uses one bold lead-in sentence per finding, followed by the evidence.
- Explain a design preference once, with the reason, then ask the question that decides it.
- To invite a contribution, say "I'll accept a PR that …" and list the requirements as a numbered list.
- Point to the fix and the release: "Fixed by #431", "4.2.1 should fix this."
- Name a fault outside the project plainly, with the evidence, and say whom to contact.

## Templates

Canned texts live in `<profile>/templates/<name>.md`. Copy everything below the template's leading comment and adapt only the bracketed parts.

## Reviews

A `review` route posts one review: the summary `text` as the body and `params.comments` inline.

- Every finding that asks for a concrete change on a line of the diff is an inline comment with a replacement. The comment carries `original`, the exact text of lines `startLine` to `line` at `reviewedSha`, and `suggestion`, the full replacement text without a fence. The board turns them into a suggestion the contributor accepts with one click. `text` is prose only: one sentence on why, never a suggestion fence.
- A change request never goes into the summary when its line is part of the diff. Only findings without a diff line go there: a missing file, a line the PR did not touch, a question about the approach.
- The summary opens with one line, like "Thanks, a few small suggestions inline." It never counts, lists or repeats the inline comments, because the maintainer can uncheck any of them. When he unchecks all of them, the board sends the summary as is, and it must still make sense. Findings without a diff line follow as a numbered list, each starting with the file or setting it concerns.
- The event: `request_changes` whenever the review has something for the contributor, whatever its severity. `approve` when the PR is clean. Never preset `comment`: the maintainer picks it on the card when he wants it. A PR by the bot itself is the one exception, because GitHub lets the bot only comment there.
- A problem that appears in several places is one finding with one inline comment per place.
- A clean PR's approval is a short "Thanks!".

## Suggestions

- The range covers exactly the lines the replacement replaces, no more and no fewer. `original` holds those lines, and `suggestion` replaces all of them.
- A replacement that only adds lines still covers the one line it attaches to. `original` is that line, and `suggestion` repeats it plus the new lines.
- Suggestions on one PR must not overlap. Merge two changes that touch the same lines into one suggestion.
- A suggestion that deletes the last property of a JSON object includes the previous line, so it can drop that line's trailing comma.
- A requested change whose lines lie outside the PR's diff hunks cannot be an inline comment. It goes into the summary.
- Each suggestion must leave the file valid on its own and together with the others. Apply each `suggestion` over its `original` range to a scratch copy of the file at `reviewedSha`, all of them together, and check the result before you return. When the profile names a formatter for the file type, run it on the copy. Without one, parse the file, or read the result carefully when no parser fits.

Keep `question` findings as questions to the contributor only when the contributor can answer them. Specification questions for the maintainer stay in `findings` and out of the review text.

## Things to leave out

- Praise, thanks paragraphs and "Great work!". One exception: a short thanks at the start of a closing message or an approval is fine when the person did something for us, like confirming a fix, testing a build or sending the log that settled it. "Thanks for confirming! Closing this."
- Restating what the reporter wrote.
- Speculation presented as a fact. Say "I think" or leave it out.
- Promises about timelines.
- In a fix PR's body: an @-mention of the reporter, and any request to test, check or confirm the fix. The body describes the change and its evidence. A doubt goes to the maintainer in one sentence under the evidence.
- Any mention of the triage routine, the board or an AI.
