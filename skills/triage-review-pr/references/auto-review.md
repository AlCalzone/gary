# The automatic first review doc

A contributor's PR of a kind the instance names can get one review without the maintainer's click (SPEC.md, "Automatic first review"). You write the doc. The routine posts it with `gary auto-review post`, and that command refuses a doc that breaks a rule here. The maintainer agreed to this for certain findings only, so when in doubt, leave a finding out. It stays on the board item for his own review.

Write `<scratch>/auto-review.json` only when the brief says the PR may get one:

```json
{
  "summary": "The value range of parameter 3 does not match the manual.",
  "findings": [
    { "severity": "major", "text": "Parameter 3 allows 0 to 255, but the manual lists 0 to 99.", "ref": "config/devices/acme/w1.json:12", "certain": true, "evidence": "The value 200 passes the range check and the device rejects it." }
  ],
  "comments": [
    { "path": "config/devices/acme/w1.json", "line": 12, "text": "The manual lists 0 to 99.", "original": "\t\t\"maxValue\": 255,", "suggestion": "\t\t\"maxValue\": 99,", "finding": 0 }
  ]
}
```

## What goes in

- `findings`: copies of the item's findings that have `certain: true` and `evidence`, with `severity`, `text`, `ref`, `certain` and `evidence` and no other field. Each names what is wrong and the concrete case that shows it: an input that is accepted and should not be, a symbol without users, a doc comment that contradicts the code, a violation of a rule from the project's rule files or tools.
- `comments`: the inline comments for those findings, built like the comments of a `review` route (`voice.md`, "Reviews" and "Suggestions"), each with `finding`, the index of its finding in this doc. A comment without a certain finding has no place here.
- `summary`: what is wrong, as plain facts, for the findings without a diff line. One short line when every finding is inline. It follows `voice.md`, "Automatic first review".

## What stays out

- Questions about the approach, taste, naming preferences and specification questions.
- Anything you would phrase with "I think", "maybe", "probably" or as a question. The command refuses such wording.
- Formatting and lint. The command adds the offer to push the formatter's changes itself, from the item's `autofix`.
- The closing sentence. The command appends it.
- Any mention of the routine, the board or an AI, and every bot command of the profile.

## No doc

Write no file when no finding is certain. The routine then posts only the format offer when the item's `autofix` has changes, and nothing for a clean PR. Never invent a finding so that a review goes out.
