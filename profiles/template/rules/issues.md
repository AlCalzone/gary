# <project>: issue triage rules

Rules here add to the core issue triage. Say which versions and environment details matter, how to read the logs reporters attach and with which tools, what the test setup can reproduce, and the commands a fix needs: setup, running one test, checks before pushing.

<!--
Example rules to adapt:

- Note the app version, the OS and the browser. The issue template asks for all three.
- Logs come as `debug.log` from Settings > Export. Search them for `ERROR` and the request ID first.
- A bug can be reproduced when the test harness in `test/fixtures/` can replay the request. Hardware faults cannot.
- Setup in a new worktree: `npm ci`. One test: `npm test -- <path>`. Before pushing: `npm run lint` and `npm test`.
- The analyzer MCP server holds one loaded file per session, so issue triages run one at a time.
-->
