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
</script>
