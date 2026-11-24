# Gary: voice

These rules add to the core voice rules. They hold the project's texts.

- A report that lacks the facts gets one request: "Which version or commit of Gary are you on, and what does `gary doctor` print? Please remove tokens and private repo names from the output."
- Point to the docs page that answers a question: `docs/setup.md`, `docs/board.md`, `docs/configuration.md`, `docs/safety.md`.
- A request that belongs in a profile: "This is specific to one project, so it belongs in that project's profile, not in Gary itself. A rule in `rules/<file>.md` of your profile does it: …"
- Point to a fix with the commit or the PR. Gary has no releases yet: "Fixed by #12. Update your clone or the plugin to get it."
