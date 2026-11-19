  // ---------- round 8 ----------
  // The discussion category, the escalate button in both config modes, and the sensitive files warning
  {
    const base = "https://github.com/acme/widgets";
    const common = { author: "someone", authorType: "contributor", section: "easy", effortMinutes: 5, priority: 1, updatedAt: iso(1000), reviewDepth: "full" };
    const move = (extra) => ({ id: "r2", type: "move", as: "me", title: "Accept: track as an enhancement issue", params: { to: "issue", issueKind: "enhancement" }, draftHash: "h2", ...extra });
    const reply = { id: "r1", type: "reply", as: "me", title: "Reply: thanks for the idea", text: "Thanks!", recommended: true, draftHash: "h1" };
    const r8 = (m = move()) => [
      ["disc-9801", { ...common, kind: "discussion", number: 9801, title: "Support scene activation", url: base + "/discussions/9801", category: "Feature Requests", labels: ["zwave"], routes: [reply, m] }],
      ["disc-9802", { ...common, kind: "discussion", number: 9802, title: "Reports the wrong power", url: base + "/discussions/9802", category: "Request Support / Investigate Issue",
        routes: [{ id: "r1", type: "move", as: "me", title: "Move: escalate to a bug issue", params: { to: "issue", issueKind: "bug" }, recommended: true, draftHash: "h1" }] }],
      ["disc-9803", { ...common, kind: "discussion", number: 9803, title: "No category", url: base + "/discussions/9803", routes: [{ id: "r1", type: "move", as: "me", title: "Move: escalate to an issue", params: { to: "issue" }, recommended: true, draftHash: "h1" }] }],
      ["issue-9804", { ...common, kind: "issue", number: 9804, title: "An issue", url: base + "/issues/9804", category: "Ideas", routes: [reply] }],
      ["pr-9805", { ...common, kind: "pr", number: 9805, title: "Update the agent instructions", url: base + "/pull/9805", sensitive: { files: [".github/copilot-instructions.md", "package.json"], total: 4 },
        routes: [{ id: "r1", type: "review", as: "bot", title: "Request changes: one fix", text: "One thing.", params: { event: "request_changes" }, recommended: true, draftHash: "h1" }] }],
      ["pr-9806", { ...common, kind: "pr", number: 9806, title: "A plain PR", url: base + "/pull/9806", routes: [{ id: "r1", type: "merge", as: "me", title: "Merge: ready", recommended: true, draftHash: "h1" }] }],
      ["pr-9807", { ...common, kind: "pr", number: 9807, title: "Our own workflow change", url: base + "/pull/9807", authorType: "maintainer", sensitive: { files: [".github/workflows/ci.yml"], total: 1 },
        routes: [{ id: "r1", type: "merge", as: "me", title: "Merge: ready", recommended: true, draftHash: "h1" }] }],
    ];
    const rowOf = (id) => document.querySelector('.row[data-id="' + id + '"]');
    const metaText = () => document.getElementById("d-meta").textContent;
    const setMode = async (escalateAs, extra = {}) => { applyBoardInfo({ ...window.__board, instances: [window.__instanceInfo("widgets", "widgets", { escalateAs, ...extra })] }); await wait(10); };
    items(r8()); await wait(10);
    await openAll();

    // Category
    ok("category: the row shows the discussion's category as a quiet chip", rowOf("disc-9801").querySelector(".r-dcat")?.textContent === "Feature Requests" && getComputedStyle(rowOf("disc-9801").querySelector(".r-dcat")).backgroundColor === "rgba(0, 0, 0, 0)");
    ok("category: a discussion without one and an issue show none", !rowOf("disc-9803").querySelector(".r-dcat") && !rowOf("issue-9804").querySelector(".r-dcat"));
    await openItem("disc-9801");
    const catTag = document.querySelector("#d-meta .tag.category");
    ok("category: the dialog's meta row shows it before the labels", catTag?.textContent === "Feature Requests" && catTag.nextElementSibling?.textContent === "zwave" && catTag.classList.contains("label"));
    await openItem("issue-9804");
    ok("category: an issue's meta row has none", !document.querySelector("#d-meta .tag.category"));

    // Default: prefill only
    await openItem("disc-9801");
    const moveCard = () => cards().find((c) => /Accept/.test(c.querySelector(".card-head").textContent));
    ok("prefill: the accept row has only the copy button", [...moveCard().querySelectorAll(".card-actions button")].map((b) => b.textContent).join() === "Copy escalate command, open GitHub");
    ok("prefill: the row says what the discussion becomes", moveCard().querySelector(".escalate-note")?.textContent === "The discussion becomes an enhancement issue once you post @widgets-bot escalate there.");
    ok("the title's verb Accept is set apart like other verbs", moveCard().querySelector(".h-act")?.textContent === "Accept");
    let n = __calls.length;
    cardBtn("Copy escalate command, open GitHub", moveCard()).click(); await wait(20);
    ok("prefill: the click copies the command and calls no action", window.__clip === "@widgets-bot escalate" && __calls.length === n && window.__opened.at(-1) === base + "/discussions/9801#issue-comment-box");
    localOpened.clear();
    await openItem("disc-9802");
    ok("a bug escalation names a bug issue", cards()[0].querySelector(".escalate-note")?.textContent === "The discussion becomes a bug issue once you post @widgets-bot escalate there.");
    await openItem("disc-9803");
    ok("without issueKind the row names a plain issue", /^The discussion becomes an issue once/.test(cards()[0].querySelector(".escalate-note")?.textContent ?? ""));

    // escalateAs "me": the primary button posts, the copy button stays
    await setMode("me");
    items(r8()); await wait(10);
    await openItem("disc-9802");
    const btns = () => [...cards()[0].querySelectorAll(".card-actions button")];
    ok("me: a recommended escalation has a primary post button and a quiet copy button", btns().map((b) => b.textContent).join() === "Escalate to an issue,Copy command, open GitHub" && btns()[0].classList.contains("primary") && btns()[1].classList.contains("quiet") && !btns()[1].classList.contains("primary"));
    ok("me: the post button shows his avatar", avatarOf(btns()[0], "octocat"));
    ok("me: the row says who posts what", cards()[0].querySelector(".escalate-note")?.textContent === "The discussion becomes a bug issue. The button posts @widgets-bot escalate under your GitHub login.");
    n = __calls.length;
    btns()[0].click(); await wait(10);
    ok("me: the first click only asks to confirm, with the exact command", __calls.length === n && !!cardBtn("Confirm: post @widgets-bot escalate as you", cards()[0]));
    cardBtn("Cancel", cards()[0]).click(); await wait(10);
    ok("me: cancel sends nothing", __calls.length === n && btns()[0].textContent === "Escalate to an issue");
    cardBtn("Copy command, open GitHub", cards()[0]).click(); await wait(20);
    ok("me: the copy button still copies and opens, without a server action", window.__clip === "@widgets-bot escalate" && __calls.length === n && /^Copied and opened on GitHub/.test(cards()[0].querySelector(".status.opened")?.textContent ?? ""));
    localOpened.clear();

    await openItem("disc-9801");
    ok("me: an enhancement is accepted", [...moveCard().querySelectorAll(".card-actions button")].map((b) => b.textContent).join() === "Accept as an issue,Copy command, open GitHub" && !moveCard().querySelector(".card-actions .primary"));
    // A refusal keeps the copy button
    window.__reply = () => ({ ok: false, result: 'Your gh login octocat may not comment on discussions of acme/widgets. Nothing was posted. "Copy command, open GitHub" still works.' });
    cardBtn("Accept as an issue", moveCard()).click(); await wait(10);
    cardBtn("Confirm: post @widgets-bot escalate as you", moveCard()).click(); await wait(20);
    ok("me: a refused post says why and keeps both buttons", /may not comment on discussions/.test(document.getElementById("detail").textContent) && !!cardBtn("Accept as an issue", moveCard()) && !cardBtn("Copy command, open GitHub", moveCard()).disabled);
    window.__reply = () => ({ ok: true, result: base + "/discussions/9801#discussioncomment-900" });
    n = __calls.length;
    cardBtn("Accept as an issue", moveCard()).click(); await wait(10);
    cardBtn("Confirm: post @widgets-bot escalate as you", moveCard()).click(); await wait(20);
    const sent = __calls.at(-1);
    ok("me: the confirmed click sends one move action with the escalate mode and no text", __calls.length === n + 1 && sent.tool === "move" && sent.itemId === "disc-9801" && sent.routeId === "r2" && sent.text === "" && JSON.stringify(sent.input) === '{"mode":"escalate"}' && sent.draftHash === "h2" && sent.force === false);
    ok("me: the request carries no command", !/escalate/.test(JSON.stringify({ ...sent, input: undefined })));
    ok("me: the click shows the inline confirmation", /Done: Accept: track as an enhancement issue/.test(document.getElementById("detail").textContent) && !cardBtn("Accept as an issue", moveCard()));
    // The server's done state
    items(r8(move({ done: { status: "done", result: base + "/discussions/9801#discussioncomment-900", finishedAt: new Date().toISOString(), via: "server" } })).map(([k, d]) => [k, k === "disc-9801" ? { ...d, handled: { at: new Date().toISOString(), routeId: "r2", routeType: "move", verified: "commented" } } : d])); await wait(10);
    ok("done: the row leaves the plan", !rowOf("disc-9801"));
    openDetail("disc-9801"); await wait(10);
    const doneCard = moveCard();
    ok("done: the row is settled, says Done with a link to the comment and has no buttons", doneCard.classList.contains("settled") && doneCard.querySelector(".card-actions .step-done")?.textContent === "Doneview on GitHub" && doneCard.querySelector(".card-actions a")?.href === base + "/discussions/9801#discussioncomment-900" && !doneCard.querySelector(".card-actions button"));
    document.getElementById("d-close").click(); await wait(5);
    window.__reply = () => ({ ok: true, result: { dryRun: true } });

    // Paused and closed
    items(r8()); await wait(10);
    await setMode("me", { paused: true });
    await openItem("disc-9802");
    ok("me: a paused instance marks the post button", /paused/.test(cards()[0].querySelector(".card-actions .paused-hint")?.textContent ?? ""));
    await setMode("me");
    items(r8().map(([k, d]) => [k, k === "disc-9802" ? { ...d, live: { state: "closed", checkedAt: new Date().toISOString() } } : d])); await wait(10);
    openDetail("disc-9802"); await wait(10);
    ok("a closed discussion offers no escalate button", !cards()[0]?.querySelector(".card-actions button") && /The discussion is closed/.test(cards()[0]?.textContent ?? ""));
    document.getElementById("d-close").click(); await wait(5);
    await setMode("me", { botCommands: {} });
    items(r8()); await wait(10);
    await openItem("disc-9801");
    ok("me without an escalate command: no such route", cards().length === 1 && !/Accept/.test(cards()[0].textContent));
    await setMode("prefill");
    items(r8()); await wait(10);

    // Sensitive files
    await openAll();
    const banner = () => document.getElementById("d-sensitive");
    ok("sensitive: the row carries a warning icon", [...rowOf("pr-9805").querySelectorAll(".r-meta svg")].some((s) => /^Touches sensitive files: \.github\/copilot-instructions\.md, package\.json and 2 more\. Gary does not push/.test(s.getAttribute("aria-label") ?? "")) && ![...rowOf("pr-9806").querySelectorAll(".r-meta svg")].some((s) => /sensitive/.test(s.getAttribute("aria-label") ?? "")));
    await openItem("pr-9805");
    ok("sensitive: the banner names the files and says that nothing pushes", !banner().hidden && banner().textContent === "Touches sensitive files: .github/copilot-instructions.md, package.json and 2 more. Gary does not push to this PR. It gets no take-over, no change and no format run. These files can change what agents do or run code with repo secrets." && banner().querySelectorAll("code").length === 2);
    ok("sensitive: the banner sits above the verdict and the routes", !!(banner().compareDocumentPosition(document.getElementById("d-verdict")) & Node.DOCUMENT_POSITION_FOLLOWING) && banner().parentElement === document.getElementById("d-routes").parentElement && getComputedStyle(banner()).display !== "none");
    ok("sensitive: the banner uses the warning colors of the theme", getComputedStyle(banner()).backgroundColor === getComputedStyle(document.documentElement).getPropertyValue("--warn-soft").trim().replace(/^#(..)(..)(..)$/, (m, r, g, b) => "rgb(" + [r, g, b].map((x) => parseInt(x, 16)).join(", ") + ")"));
    ok("sensitive: the meta row has a warning tag", [...document.querySelectorAll("#d-meta .sbadge.tone-warn")].some((b) => b.textContent === "Sensitive files"));
    await openItem("pr-9807");
    ok("sensitive: a PR we control gets the banner too", !banner().hidden && /ci\.yml\. Gary does not push/.test(banner().textContent) && !/more/.test(banner().textContent));
    await openItem("pr-9806");
    ok("sensitive: a plain PR has no banner and no tag", banner().hidden && banner().textContent === "" && !/Sensitive files/.test(metaText()));
    await openItem("disc-9801");
    ok("sensitive: a discussion has no banner", banner().hidden);
    document.getElementById("d-close").click(); await wait(5);
    applyBoardInfo(window.__board);
    items(F); await wait(5);
  }
