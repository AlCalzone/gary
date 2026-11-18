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

- Every finding that asks for a concrete change on a line of the diff is an inline comment with a `suggestion` block that holds the full replacement for that line or range. The contributor accepts it with one click on GitHub. Use `startLine` for a range. One sentence above the block says why.
- A change request never goes into the summary when its line is part of the diff. Only findings without a diff line go there: a missing file, a line the PR did not touch, a question about the approach.
- The summary opens with one line, like "Thanks, a few small suggestions inline." It never counts, lists or repeats the inline comments, because the maintainer can uncheck any of them. When he unchecks all of them, the board sends the summary as is, and it must still make sense. Findings without a diff line follow as a numbered list, each starting with the file or setting it concerns.
- The event: `request_changes` when at least one finding is `major` or a `blocker`, `comment` when all are `minor` or cosmetic, with an approval offered as the alternative.
- A problem that appears in several places is one finding with one inline comment per place.
- A clean PR's approval is a short "Thanks!".

## Suggestions

- Suggestions on one PR must not overlap. Merge two changes that touch the same lines into one suggestion.
- A suggestion that deletes the last property of a JSON object includes the previous line, so it can drop that line's trailing comma.
- A requested change whose lines lie outside the PR's diff hunks cannot be an inline comment. It goes into the summary.
- Each suggestion must leave the file valid on its own and together with the others. Apply them all to a scratch copy of the file at `reviewedSha` and check it before you return. When the profile names a formatter for the file type, run it on the copy. Without one, parse the file, or read the result carefully when no parser fits.

Keep `question` findings as questions to the contributor only when the contributor can answer them. Specification questions for the maintainer stay in `findings` and out of the review text.

## Things to leave out

- Praise, thanks paragraphs and "Great work!". A short "Thanks!" on an approval is the exception.
- Restating what the reporter wrote.
- Speculation presented as a fact. Say "I think" or leave it out.
- Promises about timelines.
- Any mention of the triage routine, the board or an AI.
