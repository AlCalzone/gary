<script>
// Route fixtures shared by the mocked suite and the screenshots. Texts read like real widgets cases.
window.makeRouteFixtures = (iso) => {
  const REPO = "https://github.com/acme/widgets";
  const base = (kind, n, extra) => ({
    kind, number: n, url: REPO + (kind === "pr" ? "/pull/" : kind === "discussion" ? "/discussions/" : "/issues/") + n,
    authorType: "contributor", section: "easy", effortMinutes: 5, priority: 1, updatedAt: iso(n * 1000), reviewDepth: "full", ...extra,
  });
  const issue = (n, extra) => ["issue-" + n, base("issue", n, extra)];
  const pr = (n, extra) => ["pr-" + n, base("pr", n, extra)];
  const disc = (n, extra) => ["disc-" + n, base("discussion", n, extra)];
  const hunk1 = "@@ -38,7 +38,7 @@\n \t\t\t\"label\": \"Motion sensor reset time\",\n \t\t\t\"valueSize\": 2,\n-\t\t\t\"defaultValue\": 240,\n+\t\t\t\"defaultValue\": 24,\n \t\t\t\"unit\": \"seconds\",\n \t\t\t\"minValue\": 10,";
  const hunk2 = "@@ -1207,9 +1207,12 @@ export class Device extends DeviceMixins {\n \tpublic get canSleep(): boolean | undefined {\n-\t\treturn !this.isListening && !this.isFrequentListening;\n+\t\tconst isListening2 = this.isListening ?? false;\n+\t\tif (isListening2) return false;\n+\t\treturn !this.isFrequentListening;\n \t}";
  return [
    issue(9471, {
      title: "Node 52 shows as battery-powered after replacing the stick",
      author: "c0coco",
      story: "After moving to a new Acme hub, node 52 reports as battery-powered and asleep. The driver log shows the controller answering GetNodeProtocolInfo for node 52 with all zeros.",
      state: "The reporter offered to send a fix and asked where the check belongs.",
      findings: [
        { severity: "idea", routeId: "r3", text: "The controller answered GetNodeProtocolInfo with all zeros for node 52. The driver should detect this response and warn that the stored node data looks corrupted." },
        { severity: "minor", text: "The reporter runs driver 15.3.0, two releases behind. The NVM restore fix landed in 15.4.0." },
      ],
      routes: [
        { id: "r1", type: "reply", as: "me", title: "Reply: a PR is welcome", why: "He already found the cause and only asked where the check belongs.", text: "Thanks for digging into this! A PR is welcome. The check belongs in `Controller.getNodeProtocolInfo()`, right after the response is parsed.", recommended: true, draftHash: "h1" },
        { id: "r2", type: "close", as: "me", title: "Close: the restore fixed it", params: { reason: "completed" }, text: "", draftHash: "h2" },
        { id: "r3", type: "follow_up", as: "agent", title: "Start fix: warn on empty protocol info", text: "", draftHash: "h3" },
        { id: "r4", type: "move", as: "bot", title: "Move to widgets-desktop", why: "The second half of the report is about the UI's network graph.", params: { to: "widgets-desktop" }, text: "Thanks for the report! The graph part of this looks like a Widgets Desktop problem. Please open a new issue in acme/widgets-desktop with your UI version and a screenshot of the network graph.", draftHash: "h4" },
      ],
    }),
    issue(9472, {
      title: "Aeotec ZW100 stops reporting motion after an hour",
      author: "jbarreiros",
      story: "The sensor reports motion for about an hour after a re-interview and then goes quiet. The attached log is on loglevel info and does not show the wakeup traffic.",
      state: "Without a debug log we cannot tell whether the node or the driver stops.",
      routes: [
        { id: "r1", type: "request_logs", as: "bot", title: "Ask: driver log on debug", text: "Please make a driver log, loglevel `debug` and attach it here as a file. Cover at least one hour, so it includes the moment the sensor goes quiet.\n\nYou can find instructions here: https://widgets.github.io/widgets/#/troubleshooting/connectivity-issues", recommended: true, draftHash: "h1" },
        { id: "r2", type: "close", as: "me", title: "Close: duplicate of #9312", params: { reason: "duplicate", duplicateOf: 9312 }, text: "Thanks for the report. This is the same problem as #9312, so I'm closing this one. Please follow that issue for updates.", draftHash: "h2" },
        { id: "r3", type: "follow_up", as: "bot", title: "File issue: wakeup interval lost on re-interview", params: { title: "Wakeup interval resets to the default after a re-interview" }, text: "A re-interview of the ZW100 sets the wakeup interval back to 3600 seconds.\nThe driver should restore the interval the user configured before.", draftHash: "h3" },
        { id: "r4", type: "follow_up", as: "me", title: "File issue: document the reset", params: { title: "Docs: soft reset after restoreNVM" }, text: "The docs for `restoreNVM` do not mention the soft reset afterwards.\nApps should wait for the driver ready event again.", draftHash: "h4" },
      ],
    }),
    pr(9473, {
      title: "fix(config): correct ZW100 motion reset default",
      author: "AMThie",
      story: "The PR changes the default of the motion reset parameter and adds a getter to the node class. The config part is a one-line fix, the getter duplicates existing logic.",
      state: "Two small problems need changes before this can go in.",
      threads: [
        { id: "t1", author: "copilot-pull-request-reviewer", path: "packages/widgets/src/lib/node/Node.ts", line: 1214, summary: "The new getter returns `false` for nodes whose listening state is still unknown.", verdict: "valid", note: "Unknown should stay unknown until the interview finishes." },
        { id: "t2", author: "someone", path: "packages/config/config/devices/0x0086/zw100.json", summary: "Add `allowManualEntry: false` to the parameter.", verdict: "wrong" },
      ],
      routes: [
        { id: "r1", type: "review", as: "bot", title: "Request changes: default and getter", params: { event: "request_changes", comments: [
          { id: "c1", path: "packages/config/config/devices/0x0086/zw100.json", line: 41, text: "The manual lists 240 seconds as the default. `24` looks like a typo.", diffHunk: hunk1 },
          { id: "c2", path: "packages/widgets/src/lib/node/Node.ts", startLine: 1210, line: 1212, text: "This changes the result for nodes whose listening state is unknown. Please keep returning `undefined` there.", diffHunk: hunk2 },
        ] }, text: "Thanks for the fix! Two small things before we can merge, see the inline comments.", recommended: true, draftHash: "h1" },
        { id: "r2", type: "merge", as: "me", title: "Merge: after the fixes", draftHash: "h2" },
        { id: "r3", type: "chore", as: "bot", title: "Update branch: 14 commits behind", params: { action: "update_branch" }, draftHash: "h3" },
        { id: "r4", type: "take_over", as: "agent", title: "Take over: replace the PR", params: { mode: "replace" }, callout: "The fork does not allow edits from maintainers, so the bot cannot push to this branch.", draftHash: "h4" },
      ],
    }),
    pr(9474, {
      title: "feat: expose the controller's background RSSI history",
      author: "c0bra99",
      story: "The PR adds an API that returns the last 24 hours of background RSSI per channel. Copilot left four comments, the agent judged each of them.",
      state: "The review comments are judged. Decide which ones the agent fixes.",
      threads: [
        { id: "t1", author: "copilot-pull-request-reviewer", path: "packages/widgets/src/lib/controller/Controller.ts", line: 4410, summary: "The history buffer grows without a limit.", verdict: "valid", note: "At one sample per minute this reaches 1440 entries per channel a day." },
        { id: "t2", author: "copilot-pull-request-reviewer", path: "packages/widgets/src/lib/controller/Controller.ts", line: 4432, summary: "Use `Array.prototype.at()` to read the last sample.", verdict: "wrong", note: "The project still supports Node.js versions where this is fine either way. It is a style preference." },
        { id: "t3", author: "copilot-pull-request-reviewer", path: "docs/api/controller.md", line: 812, summary: "Mention the unit of the returned values.", verdict: "optional" },
        { id: "t4", author: "octocat", path: "packages/widgets/src/lib/controller/Controller.ts", line: 4398, summary: "Store the samples per channel, not per call.", verdict: "valid" },
      ],
      routes: [
        { id: "r1", type: "address_review", as: "agent", title: "Address review: cap the history, store per channel", text: "", recommended: true, draftHash: "h1" },
        { id: "r2", type: "review", as: "bot", title: "Approve: good to go after the fixes", params: { event: "approve", comments: [] }, text: "Looks good, thanks!", draftHash: "h2" },
        { id: "r3", type: "reopen", as: "bot", title: "Reopen: closed by mistake", text: "Reopening, this was closed together with the stale PRs by mistake.", draftHash: "h3" },
        { id: "r4", type: "take_over", as: "agent", title: "Take over: finish the PR", params: { mode: "push" }, draftHash: "h4" },
      ],
    }),
    pr(9475, {
      title: "fix: soft-reset the controller after restoreNVMRaw",
      author: "widgets-bot",
      authorType: "bot",
      story: "The bot's PR soft-resets the controller after `restoreNVMRaw`. The agent drove it through two rounds of Copilot review.",
      state: "One Copilot point is still open after two rounds.",
      rounds: [
        { n: 1, fixed: ["Guard against an empty `nodeIds` array in `getNodesToInterview()`.", "Wait for the `driver ready` event before resuming the interview."], dismissed: [{ summary: "Use optional chaining on `node.deviceConfig`.", reason: "`deviceConfig` is always set here, the interview checks it first." }], open: [] },
        { n: 2, fixed: ["Log the soft reset on loglevel `info`."], dismissed: [], open: ["Copilot asks for a test that covers the timeout branch in `waitForWakeup()`."] },
      ],
      routes: [
        { id: "r1", type: "drive", as: "agent", title: "Drive: finish the last round", why: "Only the missing test is open, the agent can write it.", params: { maxRounds: 3 }, recommended: true, draftHash: "h1" },
        { id: "r2", type: "merge", as: "me", title: "Merge: without the extra test", draftHash: "h2" },
        { id: "r3", type: "reopen", as: "bot", title: "Reopen", draftHash: "h3" },
      ],
    }),
    pr(9480, {
      title: "feat(config): add Acme ZEN52 relay",
      author: "kpine",
      story: "A first-time contributor adds the ZEN52 double relay. Copilot left two comments and the contributor has not answered in three weeks.",
      state: "The PR is close. We can fix the remaining comment ourselves and merge.",
      threads: [
        { id: "t1", author: "copilot-pull-request-reviewer", path: "packages/config/config/devices/0x027a/zen52.json", line: 18, summary: "Parameter 2 is called `ledIndicator` in the manual, the file says `ledMode`.", verdict: "valid", note: "The manual and the other Acme files use the manual's name." },
        { id: "t2", author: "copilot-pull-request-reviewer", path: "packages/config/config/devices/0x027a/zen52.json", line: 31, summary: "Add `unsigned: true` to parameter 5.", verdict: "wrong", note: "The value range fits a signed byte, so the flag changes nothing." },
      ],
      routes: [
        { id: "r1", type: "take_over", as: "agent", title: "Take over: fix the parameter name", why: "The contributor has been quiet for three weeks and only one comment needs a change.", params: { mode: "push" }, recommended: true, draftHash: "h1" },
        { id: "r2", type: "review", as: "bot", title: "Comment: ask the contributor", params: { event: "comment", comments: [] }, text: "Thanks! Could you rename parameter 2 to match the manual?", draftHash: "h2" },
      ],
    }),
    pr(9484, {
      title: "Support the Gadget Mini in the device list",
      author: "someone",
      story: "A device config from a first-time contributor. The content is right, but the file is not formatted and one lint rule fails.",
      state: "Only formatting and lint are left.",
      autofix: { changes: true, files: 3, lines: 41, tools: ["prettier", "eslint --fix"] },
      routes: [
        { id: "r1", type: "format", as: "agent", title: "Format: fix formatting and lint", recommended: true, draftHash: "h1" },
        { id: "r2", type: "merge", as: "me", title: "Merge: after the formatting", draftHash: "h2" },
      ],
    }),
    pr(9485, {
      title: "Clean config for the Gadget Max",
      author: "someone",
      autofix: { changes: false, files: 0, lines: 0, tools: ["prettier"] },
      routes: [{ id: "r1", type: "merge", as: "me", title: "Merge: clean", recommended: true, draftHash: "h1" }],
    }),
    issue(9486, {
      title: "Hub loses the network key after a power cut",
      author: "someone",
      story: "The agent read the attached log and found the cause.",
      routes: [{ id: "r1", type: "reply", as: "bot", title: "Post analysis: the key is written after the reboot", recommended: true, draftHash: "h1",
        text: "## What happened\n\nThe hub rebooted while it wrote the network key, so the key on disk is empty.\n\n## Why\n\nThe write is not atomic. A power cut between truncate and write leaves an empty file.\n\n## What you can do\n\n1. Restore the key from your backup.\n2. Update to 4.2, which writes the key atomically.\n\n## What we change\n\nWe add a check at startup that warns about an empty key file." }],
    }),
    issue(9490, {
      title: "Hub does not wake the thermostat for a setpoint change",
      author: "someone",
      story: "The reporter attached no log, and the setting he changed is not in the summary.",
      state: "We need a debug log before anyone can look.",
      routes: [{ id: "r1", type: "request_logs", as: "me", actor: "me", title: "Ask: driver log on debug", recommended: true, draftHash: "h1",
        text: "Please make a driver log on loglevel `debug` and attach it here.", params: { alsoLabel: { add: ["waiting for info ⏳"], remove: [] } } }],
    }),
    issue(9491, {
      title: "Scene button triggers twice",
      author: "someone",
      state: "A log will show whether the device sends the event twice.",
      routes: [{ id: "r1", type: "request_logs", as: "bot", title: "Ask: driver log on debug", recommended: true, draftHash: "h1",
        text: "Please make a driver log on loglevel `debug` and attach it here.", params: { alsoLabel: { add: ["waiting for info ⏳"], remove: [] } } }],
    }),
    disc(9492, {
      title: "How do I back up the hub before an update?",
      author: "someone",
      state: "A reply already answers it with the backup command.",
      routes: [{ id: "r1", type: "close", as: "me", actor: "me", title: "Close: answered", recommended: true, draftHash: "h1",
        text: "Thanks, the reply below answers this.", params: { alsoAnswer: { commentId: "DC_c1", url: "https://github.com/acme/widgets/discussions/9492#discussioncomment-77", gist: "Run `widgets backup` before every update." } } }],
    }),
    pr(9493, {
      title: "Fix the retry loop in the uploader",
      author: "someone",
      working: { kind: "push", route: "take_over", since: iso(12 * 60000) },
      routes: [
        { id: "r1", type: "review", as: "bot", title: "Approve: as is", params: { event: "approve", comments: [] }, text: "Thanks!", recommended: true, draftHash: "h1" },
        { id: "r2", type: "merge", as: "me", title: "Merge: as is", draftHash: "h2" },
        { id: "r3", type: "close", as: "me", title: "Close: superseded", draftHash: "h3" },
        { id: "r4", type: "chore", as: "bot", title: "Mark ready", params: { action: "ready" }, draftHash: "h4" },
        { id: "r5", type: "take_over", as: "agent", title: "Take over: finish it", params: { mode: "push" }, draftHash: "h5" },
        { id: "r6", type: "address_review", as: "agent", title: "Address review: the two comments", text: "", draftHash: "h6" },
        { id: "r7", type: "drive", as: "agent", title: "Drive: the review rounds", params: { maxRounds: 3 }, draftHash: "h7" },
        { id: "r8", type: "format", as: "agent", title: "Format: fix formatting and lint", draftHash: "h8" },
        { id: "r9", type: "reply", as: "me", title: "Reply: thanks for the patience", text: "Thanks, we are on it.", draftHash: "h9" },
        { id: "r10", type: "chore", as: "bot", title: "Label: needs review", params: { action: "label", add: ["needs review"] }, draftHash: "h10" },
        { id: "r11", type: "revise", as: "agent", title: "Change: rename the option", text: "Rename the option to retryLimit.", draftHash: "h11" },
      ],
    }),
    issue(9494, {
      title: "Sensor reports 0 °C after a battery change",
      author: "someone",
      fix: { state: "working", pr: null, startedBy: "routine", since: iso(3 * 60000) },
      routes: [
        { id: "r1", type: "follow_up", as: "agent", title: "Start fix: keep the last value", text: "", recommended: true, draftHash: "h1" },
        { id: "r2", type: "reply", as: "me", title: "Reply: a fix is on the way", text: "A fix is on the way.", draftHash: "h2" },
      ],
    }),
    issue(9495, {
      title: "Uploader retries forever on a 413",
      author: "someone",
      fix: { state: "draft", pr: { number: 9496, url: "https://github.com/acme/widgets/pull/9496", title: "fix: stop retrying on a 413", isDraft: true, ci: "pending", author: "widgets-bot" }, startedBy: "maintainer", since: iso(20 * 60000) },
      routes: [
        { id: "r1", type: "follow_up", as: "agent", title: "Start fix: stop on 413", text: "", recommended: true, draftHash: "h1" },
        { id: "r2", type: "reply", as: "me", title: "Reply: fix in review", text: "A fix is in review.", draftHash: "h2" },
      ],
    }),
    pr(9496, {
      title: "fix: stop retrying on a 413",
      author: "widgets-bot",
      authorType: "bot",
      fixFor: { itemId: "issue-9495", ref: "acme/widgets#9495" },
      routes: [{ id: "r1", type: "merge", as: "me", title: "Merge: when CI passes", recommended: true, draftHash: "h1" }],
    }),
    issue(9497, {
      title: "Dark mode toggle forgets its state",
      author: "someone",
      fix: { state: "open", pr: { number: 9498, url: "https://github.com/acme/widgets/pull/9498", title: "fix: store the theme", isDraft: false, ci: "failing", author: "widgets-bot" }, startedBy: "routine", since: iso(60 * 60000) },
      routes: [{ id: "r1", type: "follow_up", as: "agent", title: "Start fix: store the theme", text: "", recommended: true, draftHash: "h1" }, { id: "r2", type: "reply", as: "me", title: "Reply: fix is open", text: "See the PR.", draftHash: "h2" }],
    }),
    issue(9499, {
      title: "Typo in the setup guide",
      author: "someone",
      fix: { state: "merged", pr: { number: 9500, url: "https://github.com/acme/widgets/pull/9500", title: "docs: fix typo", isDraft: false, ci: "passing", author: "widgets-bot" }, startedBy: "routine", since: iso(86400000) },
      routes: [{ id: "r1", type: "close", as: "me", title: "Close: fixed", recommended: true, draftHash: "h1" }, { id: "r2", type: "follow_up", as: "agent", title: "Start fix: a second typo", text: "", draftHash: "h2" }],
    }),
    issue(9481, {
      title: "Hub crashes when a sensor reports a negative temperature",
      author: "someone",
      story: "",
      state: "",
      blocked: { reason: "safety_filter", at: iso(3600000) },
      routes: [{ id: "r1", type: "open", as: "me", title: "Open: Read it yourself on GitHub", recommended: true, draftHash: "h1" }],
    }),
    issue(9483, {
      title: "Lock reports jammed after a firmware update",
      author: "someone",
      story: "After updating the lock to firmware 2.4 it reports jammed after every unlock. The reporter attached a log of one unlock.",
      state: "Looks like the new firmware sends a different notification event.",
      analyzedBy: "fallback",
      routes: [{ id: "r1", type: "reply", as: "me", title: "Reply: ask for the old firmware's log", text: "Could you post a log from before the update?", recommended: true, draftHash: "h1" }],
    }),
    issue(9482, {
      title: "Pairing fails with a 0x0E status on the third attempt",
      author: "someone",
      story: "",
      state: "",
      blocked: { reason: "failed", at: iso(7200000) },
      routes: [{ id: "r1", type: "open", as: "me", title: "Open: Read it yourself on GitHub", recommended: true, draftHash: "h1" }],
    }),
    disc(9476, {
      title: "Fibaro FGS-223 reports wrong power after a firmware update",
      author: "memphi2",
      story: "Since firmware 3.3 the switch reports power in kW instead of W. Two other users confirmed it with the same firmware.",
      state: "This is a config problem and belongs in an issue.",
      routes: [
        { id: "r1", type: "move", as: "me", title: "Move: escalate to an issue", params: { to: "issue" }, recommended: true, draftHash: "h1" },
        { id: "r2", type: "reply", as: "me", title: "Reply: ask for the firmware version", text: "Which firmware version does your switch report in the node info? Please post a screenshot of the device page.", draftHash: "h2" },
        { id: "r3", type: "chore", as: "bot", title: "Mark as answer: the second reply", params: { action: "answer_discussion", commentId: "DC_1" }, draftHash: "h3" },
      ],
    }),
    issue(9477, {
      title: "How do I exclude a node that no longer exists?",
      author: "someone",
      story: "The reporter asks how to remove a dead node from the network. This is a usage question.",
      state: "A usage question, better kept as a discussion.",
      routes: [
        { id: "r1", type: "move", as: "me", title: "Move to a discussion", params: { to: "discussion" }, recommended: true, draftHash: "h1" },
        { id: "r2", type: "reply", as: "bot", title: "Reply: point to the docs", text: "You can remove a failed node with `controller.removeFailedNode()`. The docs explain the steps: https://widgets.github.io/widgets/#/api/controller?id=removefailednode", draftHash: "h2" },
        { id: "r3", type: "chore", as: "bot", title: "React: thumbs up", params: { action: "react", content: "THUMBS_UP" }, draftHash: "h3" },
      ],
    }),
  ];
};
// Rule proposals the server derives from his deviations
window.makeProposalFixtures = (iso) => [
  ["p1", {
    title: "Do not suggest closing feature requests the maintainer asked for",
    why: "Three times the agent suggested closing a feature request you had invited yourself, and three times you dismissed it.",
    evidence: [
      { at: iso(6 * 86400000), itemId: "issue-9471", type: "dismissed", gist: "Close: not planned, on a request you asked the reporter to write up." },
      { at: iso(4 * 86400000), itemId: "issue-9302", type: "dismissed", gist: "Close: stale, on the bulk QR import request." },
      { at: iso(2 * 86400000), itemId: "issue-9288", type: "dismissed", gist: "Close: not planned. Your reason: \"I asked for this one.\"" },
    ],
    target: "profile", file: "rules/classification.md", heading: "## Feature requests",
    text: "Never suggest closing a feature request when a maintainer asked for it in the thread. Classify it as `later` instead.",
  }],
  ["p2", {
    title: "Drop the opening thanks in log requests",
    why: "You removed the opening \"Thanks for the report!\" from the last four debug log requests before posting them.",
    evidence: [
      { at: iso(9 * 86400000), itemId: "issue-9472", type: "edited", gist: "Removed \"Thanks for the report!\" before posting." },
      { at: iso(7 * 86400000), itemId: "issue-9260", type: "edited", gist: "Removed the opening thanks and shortened the link sentence." },
      { at: iso(3 * 86400000), itemId: "issue-9311", type: "edited", gist: "Removed \"Thanks for the report!\" before posting." },
      { at: iso(1 * 86400000), itemId: "issue-9330", type: "edited", gist: "Removed the opening thanks." },
    ],
    target: "personal", file: "personal.md", heading: "Voice",
    text: "In log requests, start with the request itself. No opening thanks.",
  }],
];
// Two instances on one board: the same number in both repos, so only the instance tells them apart
window.makeTwoInstanceFixtures = (iso) => {
  const item = (instance, kind, n, extra) => [instance + "/" + (kind === "pr" ? "pr-" : "issue-") + n, {
    instance, kind, number: n, url: "https://github.com/" + (instance === "widgets" ? "acme/widgets" : "contoso/gadgets") + (kind === "pr" ? "/pull/" : "/issues/") + n,
    author: "someone", authorType: "contributor", section: "easy", effortMinutes: 5, priority: 1, updatedAt: iso(n * 60000), reviewDepth: "full", ...extra,
  }];
  const reply = (title, text) => [{ id: "r1", type: "reply", as: "me", title, text, recommended: true, draftHash: "h1" }];
  return [
    item("widgets", "pr", 12, { title: "Retry the firmware upload after a timeout", state: "Ready apart from a short changelog line.", routes: [{ id: "r1", type: "review", as: "bot", actor: "bot", title: "Approve: ready after the changelog line", params: { event: "approve", comments: [] }, text: "Thanks!", recommended: true, draftHash: "h1" }] }),
    item("gadgets", "pr", 12, { title: "Add the Gadget Pro 2 to the device list", state: "A config-only PR from a first-time contributor.", routes: [{ id: "r1", type: "review", as: "bot", actor: "bot", title: "Request changes: missing manual link", params: { event: "request_changes", comments: [] }, text: "Please add the link to the manual.", recommended: true, draftHash: "h1" }] }),
    item("widgets", "issue", 31, { title: "Dashboard shows the wrong battery level", routes: reply("Reply: ask for the firmware version", "Which firmware does the sensor run?") }),
    item("widgets", "issue", 32, { title: "Docs link to the old forum", routes: reply("Reply: thanks, fixed", "Thanks, the link is fixed.") }),
    item("widgets", "issue", 33, { title: "Export loses the room names", routes: reply("Reply: a PR is welcome", "A PR is welcome!") }),
    item("gadgets", "issue", 41, { title: "Pairing button does nothing on Android 15", routes: reply("Reply: ask for a log", "Could you attach a log?") }),
    item("gadgets", "issue", 42, { title: "Gadget clock drifts by a minute a day", routes: reply("Reply: known issue", "This is a known issue, see #12.") }),
    item("gadgets", "issue", 43, { title: "Translation missing for Dutch", routes: reply("Reply: a PR is welcome", "A PR is welcome!") }),
  ];
};

window.makeTwoInstanceProposals = (iso) => [
  ["widgets/learn-1", { instance: "widgets", id: "learn-1", title: "Approve changelog-only fixes without a summary", why: "You cleared the summary on three approvals.", evidence: [{ at: iso(86400000), itemId: "pr-12", type: "edited_text", gist: "Cleared the summary." }], target: "profile", file: "rules/review.md", heading: "", text: "Approve changelog-only fixes without a summary." }],
  ["gadgets/learn-1", { instance: "gadgets", id: "learn-1", title: "Ask for the manual link on device PRs", why: "You asked for it twice by hand.", evidence: [{ at: iso(86400000), itemId: "pr-12", type: "edited_text", gist: "Added the manual link request." }], target: "profile", file: "rules/review.md", heading: "", text: "Ask for the manual link on every device PR." }],
];
</script>
