  // ---------- round 4 ----------
  {
    const rows = (g) => [...document.querySelectorAll("#group-" + g + " .row")].map((r) => r.dataset.id);
    // A finished re-analysis hands the item back: it keeps its place by priority
    const eight = Array.from({ length: 8 }, (_, i) => ["r4-" + (i + 1), simple(i + 1, "easy", 10, i + 1)]);
    items(eight); await wait(10);
    window.__subs["actions"](__mkSnap([["widgets/a-1", { instance: "widgets", itemId: "r4-2", action: "reanalyze", status: "done", via: "queue", createdAt: new Date().toISOString() }]])); await wait(10);
    ok("a finished re-analysis keeps the item at its place by priority", rows("quick").join() === "r4-1,r4-2,r4-3,r4-4,r4-5");
    window.__subs["actions"](__mkSnap([["widgets/a-1", { instance: "widgets", itemId: "r4-2", action: "comment", status: "done", via: "server", createdAt: new Date().toISOString() }]])); await wait(10);
    ok("a handled item still makes room", !rows("quick").includes("r4-2") && rows("quick").length === 5);
    window.__subs["actions"](__mkSnap([])); await wait(10);

    // The list stays still while a dialog is open and marks what moved when it closes
    openDetail("r4-3"); await wait(10);
    const moved = eight.map(([k, d]) => [k, k === "r4-1" ? { ...d, section: "deferred" } : d]);
    items(moved); await wait(10);
    ok("an open dialog freezes the list", rows("quick")[0] === "r4-1" && !rows("later").includes("r4-1"));
    document.getElementById("d-close").click(); await wait(10);
    ok("closing applies the changes", rows("later").includes("r4-1") && rows("quick")[0] === "r4-2");
    const mv = document.querySelector('.row[data-id="r4-1"]');
    ok("a row that moved is marked briefly with a soft fade", mv.classList.contains("moved") && /moved/.test(getComputedStyle(mv).animationName));
    ok("rows that only shifted up are not marked", ["r4-2", "r4-3", "r4-4", "r4-5"].every((k) => !document.querySelector('.row[data-id="' + k + '"]').classList.contains("moved")));
    openDetail("r4-3"); await wait(10);
    items(eight.map(([k, d]) => [k, k === "r4-1" ? { ...d, section: "deferred" } : k === "r4-4" ? { ...d, priority: 0 } : d])); await wait(10);
    document.getElementById("d-close").click(); await wait(10);
    ok("a row that moved up within its group is marked", rows("quick")[0] === "r4-4" && document.querySelector('.row[data-id="r4-4"]').classList.contains("moved")
      && !document.querySelector('.row[data-id="r4-2"]').classList.contains("moved"));
    items(F); await wait(10);
  }

  // Label button next to a prefill
  {
    await openItem("issue-9490");
    const lb = () => [...openCard().querySelectorAll(".card-actions .label-btn")][0];
    ok("prefill: a quieter label button with the bot's avatar next to Copy", !!cardBtn("Copy request, open GitHub") && lb()?.textContent === "Add label: waiting for info ⏳" && avatarOf(lb(), "widgets-bot") && !lb().classList.contains("primary"));
    let c = __calls.length;
    lb().click(); await wait(20);
    ok("label: one call with part label, no confirm", __calls.length === c + 1 && JSON.stringify(__calls.at(-1)) === JSON.stringify({ tool: "request_logs", instance: "widgets", itemId: "issue-9490", routeId: "r1", input: { part: "label" } }));
    ok("label: afterwards it reads Label added and is disabled", lb().textContent === "Label added" && lb().disabled);
    c = __calls.length;
    cardBtn("Copy request, open GitHub").click(); await wait(20);
    ok("label first, copy after: the copy still works", /loglevel/.test(window.__clip) && __calls.length === c);
    items(F); await wait(5);
    await openItem("issue-9490");
    cardBtn("Copy request, open GitHub").click(); await wait(20);
    window.__reply = () => ({ ok: false, result: "This route already ran.", duplicate: true });
    lb().click(); await wait(20);
    ok("copy first, label after; a 409 reads as already done", lb().textContent === "Label added" && lb().disabled && !openCard().querySelector(".status.failed"));
    window.__reply = () => ({ ok: true, result: { dryRun: true } });
    items(routeMap("issue-9490", "r1", (r) => ({ ...r, labelDone: { status: "done", result: "" } }))); await wait(10);
    await openItem("issue-9490");
    ok("label: the server's labelDone shows as done", lb().textContent === "Label added" && lb().disabled);
    items(F); await wait(5);
    window.__board.instances[0].paused = true; window.dispatchEvent(new Event("board:info")); await wait(10);
    await openItem("issue-9490");
    ok("paused: the label button carries the paused hint", !!openCard().querySelector(".card-actions .paused-hint"));
    window.__board.instances[0].paused = false; window.dispatchEvent(new Event("board:info")); await wait(10);
    const W = window.__board.instances[0];
    window.__board.instances = [{ ...W, bot: null, accountMode: "own" }]; window.dispatchEvent(new Event("board:info")); await wait(10);
    await openItem("issue-9490");
    ok("own mode: the label button carries his avatar", avatarOf(lb(), "octocat"));
    window.__board.instances = [{ ...W, bot: null, accountMode: "none" }]; window.dispatchEvent(new Event("board:info")); await wait(10);
    await openItem("issue-9490");
    ok("no bot and no own mode: no label button", !lb() && !!cardBtn("Copy request, open GitHub"));
    window.__board.instances = [W]; window.dispatchEvent(new Event("board:info")); await wait(10);

    // As the bot: a checkbox under the editor
    await openItem("issue-9491");
    const al = openCard().querySelector(".also-label input");
    ok("bot: the label is a checkbox under the editor, on by default", !!al && al.checked && openCard().querySelector(".also-label").textContent === "Also add label: waiting for info ⏳"
      && !!(openCard().querySelector("textarea").compareDocumentPosition(al) & Node.DOCUMENT_POSITION_FOLLOWING));
    cardBtn("Ask for a debug log").click(); await wait(5);
    window.__reply = () => ({ ok: true, result: "Posted. The label could not be set: label \"waiting for info ⏳\" does not exist." });
    cardBtn("Confirm: ask for a debug log as widgets-bot").click(); await wait(20);
    ok("bot: the post sends alsoLabel true", __calls.at(-1).input.alsoLabel === true);
    ok("bot: a label failure is a soft warning, the post counts as done", /Done/.test(openCard().textContent) && /The label could not be set/.test(openCard().querySelector(".status.soft-warn")?.textContent ?? "") && !openCard().querySelector(".status.failed"));
    window.__reply = () => ({ ok: true, result: { dryRun: true } });
    items(F); await wait(5);
    await openItem("issue-9491");
    openCard().querySelector(".also-label input").click();
    cardBtn("Ask for a debug log").click(); await wait(5);
    cardBtn("Confirm: ask for a debug log as widgets-bot").click(); await wait(20);
    ok("bot: unchecked sends alsoLabel false", __calls.at(-1).input.alsoLabel === false);
    document.getElementById("d-close").click(); await wait(5);
  }

  // Analyze again while an analysis runs
  {
    items(F); await wait(5);
    window.__subs["actions"](__mkSnap([["widgets/q1", { instance: "widgets", itemId: "issue-9471", action: "reanalyze", status: "queued", via: "queue", createdAt: new Date().toISOString() }]])); await wait(10);
    await openItem("issue-9471");
    const fa = document.querySelector("#d-foot .foot-analyze");
    ok("analyzing: the footer button reads Analyzing…", fa.textContent === "Analyzing…" && !fa.disabled);
    ok("analyzing: snooze stays enabled", !document.querySelector('#d-foot [aria-label="Snooze 1 day"]').disabled);
    fa.click(); await wait(5);
    const panel = document.getElementById("d-analyze");
    const send = [...panel.querySelectorAll("button")].find((b) => b.textContent === "Send to the agent");
    ok("analyzing: the panel adds a note to the running analysis, sending needs a note", /Add a note to the running analysis/.test(panel.textContent) && send.disabled);
    const before = __writes.length;
    send.click(); await wait(10);
    ok("analyzing: an empty note sends nothing", __writes.length === before);
    const ta = panel.querySelector("textarea");
    ta.value = "Also check the second log."; ta.dispatchEvent(new Event("input"));
    ok("analyzing: a typed note enables sending", !send.disabled);
    send.click(); await wait(20);
    const w = __writes.slice(before).filter((x) => /^actions\//.test(x[1]));
    ok("analyzing: the note goes out as one reanalyze request", w.length === 1 && w[0][2].action === "reanalyze" && w[0][2].text === "Also check the second log.");
    window.__subs["actions"](__mkSnap([])); await wait(10);
    ok("finished: the button reads Analyze again", document.querySelector("#d-foot .foot-analyze").textContent === "Analyze again");
    document.getElementById("d-close").click(); await wait(5);
  }

  // The agent rewrites the open item
  {
    items(F); await wait(5);
    await openItem("issue-9471");
    const ta = openCard().querySelector("textarea");
    ta.value = "My own reply that I wrote by hand."; ta.dispatchEvent(new Event("input"));
    ok("no update line before a rewrite", document.getElementById("d-updated").hidden);
    items(with_("issue-9471", (d) => ({ ...d, reviewedAt: new Date().toISOString(), hint: "Close: fixed in 15.4.0",
      routes: d.routes.map((r) => (r.id === "r1" ? { ...r, text: "Thanks! This is fixed in 15.4.0.", draftHash: "h1-new" } : r)) }))); await wait(10);
    const up = document.getElementById("d-updated");
    ok("a rewrite shows one calm line with what it suggested before", !up.hidden && /Updated by the agent just now/.test(up.textContent) && /Before: Reply: a PR is welcome/.test(up.textContent));
    const card0 = cards()[0];
    ok("the rewritten draft shows the new text", card0.querySelector("textarea").value === "Thanks! This is fixed in 15.4.0.");
    const prev = card0.querySelector("details.prev-draft");
    ok("his edited draft stays available, collapsed", !!prev && !prev.open && prev.querySelector("summary").textContent === "Your previous draft" && prev.querySelector("pre").textContent === "My own reply that I wrote by hand.");
    items(with_("issue-9471", (d) => ({ ...d, reviewedAt: new Date().toISOString(), hint: "Close: fixed in 15.4.0" }))); await wait(10);
    ok("the line stays until the dialog closes", !up.hidden);
    document.getElementById("d-close").click(); await wait(5);
    items(F); await wait(5);
    await openItem("issue-9471");
    ok("a new dialog starts without the line", document.getElementById("d-updated").hidden);
    document.getElementById("d-close").click(); await wait(5);
  }

  // Prefill buttons open the thread at its comment box
  {
    const base = "https://github.com/acme/widgets";
    items([...F,
      ["issue-9601", { kind: "issue", number: 9601, title: "With comments", url: base + "/issues/9601#old-fragment", author: "someone", authorType: "contributor", section: "easy", effortMinutes: 5, priority: 1, updatedAt: iso(1000), reviewDepth: "full",
        facts: { lastEventUrl: base + "/issues/9601#issuecomment-123" },
        routes: [{ id: "r1", type: "reply", as: "me", title: "Reply: thanks", text: "Thanks!", recommended: true, draftHash: "h1" }, { id: "r2", type: "close", as: "me", title: "Close: done", params: { reason: "completed" }, draftHash: "h2" }] }],
      ["pr-9602", { kind: "pr", number: 9602, title: "PR without lastEventUrl", url: base + "/pull/9602", author: "someone", authorType: "contributor", section: "easy", effortMinutes: 5, priority: 1, updatedAt: iso(1000), reviewDepth: "full",
        routes: [{ id: "r1", type: "reply", as: "me", title: "Reply: thanks", text: "Thanks!", recommended: true, draftHash: "h1" }, { id: "r2", type: "merge", as: "me", title: "Merge: ready", draftHash: "h2" }] }],
      ["disc-9603", { kind: "discussion", number: 9603, title: "Discussion", url: base + "/discussions/9603", author: "someone", authorType: "contributor", section: "easy", effortMinutes: 5, priority: 1, updatedAt: iso(1000), reviewDepth: "full",
        routes: [{ id: "r1", type: "move", as: "me", title: "Move: escalate to an issue", params: { to: "issue" }, recommended: true, draftHash: "h1" }] }],
    ]); await wait(10);
    await openItem("issue-9601");
    cardBtn("Copy reply, open GitHub").click(); await wait(20);
    ok("with lastEventUrl: the prefill opens the newest comment, the old fragment replaced", window.__opened.at(-1) === base + "/issues/9601#issuecomment-123");
    cardBtn("Open GitHub to close", cards()[1]).click(); await wait(20);
    ok("close opens at the comment box too", window.__opened.at(-1) === base + "/issues/9601#issuecomment-123");
    await openItem("pr-9602");
    cardBtn("Copy reply, open GitHub").click(); await wait(20);
    ok("a PR without lastEventUrl opens at #issue-comment-box", window.__opened.at(-1) === base + "/pull/9602#issue-comment-box");
    cardBtn("Open GitHub to merge", cards()[1]).click(); await wait(20);
    ok("merge keeps the plain PR URL", window.__opened.at(-1) === base + "/pull/9602");
    await openItem("disc-9603");
    cardBtn("Copy escalate command, open GitHub", cards()[0]).click(); await wait(20);
    ok("a discussion's escalate command opens at #issue-comment-box", window.__opened.at(-1) === base + "/discussions/9603#issue-comment-box");
    ok("no #issuecomment-new anywhere", !window.__opened.some((u) => /#issuecomment-new/.test(u)));
    document.getElementById("d-close").click(); await wait(5);
    items(F); await wait(5);
  }
