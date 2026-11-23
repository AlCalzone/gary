# <project>: PR review rules

Rules here add to the core PR review. Name the project's instruction files, any special file types with their own rules or tools, the specification the project implements, where tests go, known flaky CI jobs, and the commit and PR title format.

<!--
Example rules to adapt:

- Read `CONTRIBUTING.md` and `docs/style.md` before reviewing code.
- Files under `data/` follow `data/README.md`. Check them with the `acme-lint` MCP tool, read-only.
- A bug fix needs a unit test next to the code, named `<file>.test.ts`.
- The job `e2e (macos)` fails randomly on timeouts. A failure there alone is not the PR's fault.
- The job `lint` fails when the formatter would change a file. A red `lint` alone is fixed by the format commit.
- PR titles and commit messages are conventional commits, like `fix(parser): handle empty input`.
-->
