  // ---------- round 4 ----------
  {
    const rows = (g) => [...document.querySelectorAll("#group-" + g + " .row")].map((r) => r.dataset.id);
    // A finished re-analysis hands the item back: it keeps its place by priority
    const eight = Array.from({ length: 8 }, (_, i) => ["r4-" + (i + 1), simple(i + 1, "easy", 10, i + 1)]);
    items(eight); await wait(10);
    window.__subs["actions"](__mkSnap([["widgets/a-1", { instance: "widgets", itemId: "r4-2", action: "reanalyze", status: "done", via: "queue", createdAt: new Date().toISOString() }]])); await wait(10);
    ok("a finished re-analysis keeps the item at its place by priority", rows("quick").join() === "r4-1,r4-2,r4-3,r4-4,r4-5");
    items(eight.map(([k, d]) => [k, k === "r4-2" ? { ...d, handled: { at: new Date().toISOString(), routeId: "r0", routeType: "chore", verified: null } } : d])); await wait(10);
    ok("a handled item still makes room", !rows("quick").includes("r4-2") && rows("quick").length === 5);
    items(eight); await wait(10);
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
    cardBtn("Copy again").click(); await wait(20);
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
    ok("no bot and no own mode: no label button", !lb() && !!cardBtn("Copy again"));
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

  // ---------- round 5 ----------
  // Answer button next to the copy button of a discussion's close
  {
    items(F); await wait(5);
    await openItem("disc-9492");
    const ab = () => [...cards()[0].querySelectorAll(".card-actions .answer-btn")][0];
    ok("answer: a quieter Mark answer button with the bot's avatar next to Copy", !!cardBtn("Copy reply, open GitHub to close", cards()[0]) && ab()?.textContent === "Mark answer" && avatarOf(ab(), "widgets-bot") && !ab().classList.contains("primary"));
    const view = cards()[0].querySelector(".card-actions a.part-view");
    ok("answer: a small view link to the proposed answer in a new tab", view?.textContent === "view" && view.href === "https://github.com/acme/widgets/discussions/9492#discussioncomment-77" && view.target === "_blank");
    ok("answer: the gist as a quiet line under the buttons", /^Proposed answer: Run widgets backup before every update\.$/.test(cards()[0].querySelector(".part-gist")?.textContent ?? ""));
    let c = __calls.length;
    ab().click(); await wait(20);
    ok("answer: one call with part answer, no confirm", __calls.length === c + 1 && JSON.stringify(__calls.at(-1)) === JSON.stringify({ tool: "close", instance: "widgets", itemId: "disc-9492", routeId: "r1", input: { part: "answer" } }));
    ok("answer: done reads Answer marked with the check mark", ab().textContent === "Answer marked" && ab().disabled && !!ab().querySelector(".part-check"));
    items(F); await wait(5);
    await openItem("disc-9492");
    window.__reply = () => ({ ok: false, result: "Already marked.", duplicate: true });
    ab().click(); await wait(20);
    ok("answer: a 409 reads as done", ab().textContent === "Answer marked");
    window.__reply = () => ({ ok: true, result: { dryRun: true } });
    items(routeMap("disc-9492", "r1", (r) => ({ ...r, answerDone: { status: "done", result: "" } }))); await wait(10);
    await openItem("disc-9492");
    ok("answer: the server's answerDone shows as done", ab().textContent === "Answer marked");
    items(routeMap("disc-9492", "r1", (r) => ({ ...r, params: { ...r.params, alsoLabel: { add: ["answered"], remove: [] } } }))); await wait(10);
    await openItem("disc-9492");
    ok("a close does not grow a label button, the answer stays", !cards()[0].querySelector(".label-btn") && !!ab());
    items(F); await wait(5);
    const W = window.__board.instances[0];
    window.__board.instances[0].paused = true; window.dispatchEvent(new Event("board:info")); await wait(10);
    await openItem("disc-9492");
    ok("answer: paused hint", !!cards()[0].querySelector(".card-actions .paused-hint"));
    window.__board.instances[0].paused = false;
    window.__board.instances = [{ ...W, bot: null, accountMode: "own" }]; window.dispatchEvent(new Event("board:info")); await wait(10);
    await openItem("disc-9492");
    ok("answer: own mode carries his avatar", avatarOf(ab(), "octocat"));
    window.__board.instances = [{ ...W, bot: null, accountMode: "none" }]; window.dispatchEvent(new Event("board:info")); await wait(10);
    await openItem("disc-9492");
    ok("answer: hidden without bot and own mode", !ab());
    window.__board.instances = [W]; window.dispatchEvent(new Event("board:info")); await wait(10);
    document.getElementById("d-close").click(); await wait(5);
  }

  // A fix or a push in flight: obvious, and nothing starts it twice
  {
    items(F); await wait(5);
    localHandled.clear();
    for (let i = 0; i < 4; i++) for (const b of document.querySelectorAll(".show-all")) if (!b.hidden && !/less/i.test(b.textContent)) b.click();
    await wait(5);
    const chipOf = (k) => document.querySelector('.row[data-id="' + k + '"] .r-titleline .agent-chip');
    const filled = (el) => getComputedStyle(el).backgroundColor !== "rgba(0, 0, 0, 0)" && !el.classList.contains("quiet");
    ok("row chip: Fix running, filled teal on the title line", chipOf("issue-9494")?.textContent === "Fix running" && filled(chipOf("issue-9494")));
    ok("row chip: Fix: #9496 draft with a CI dot", chipOf("issue-9495")?.textContent === "Fix: #9496 draft" && chipOf("issue-9495").querySelector(".ci-dot.ci-pending") && filled(chipOf("issue-9495")));
    ok("row chip: Fix: #9498 open with a failing CI dot", chipOf("issue-9497")?.textContent === "Fix: #9498 open" && !!chipOf("issue-9497").querySelector(".ci-dot.ci-failing"));
    ok("row chip: a quiet Fixed by #9500", chipOf("issue-9499")?.textContent === "Fixed by #9500" && chipOf("issue-9499").classList.contains("quiet"));
    ok("row chip: Agent working on a PR the agent is changing", chipOf("pr-9493")?.textContent === "Agent working" && filled(chipOf("pr-9493")));
    ok("the row hint does not point at a hidden fix route", !/Start fix/.test(document.querySelector('.row[data-id="issue-9495"] .r-hint')?.textContent ?? ""));
    // A fix in progress takes its issue out of the plan, the fix PR's item carries the work
    {
      const park = (ids, extra = () => ({})) => F.map(([k, d]) => [k, ids.includes(k) ? { ...d, fix: { ...d.fix, parked: true }, ...extra(k, d) } : d]);
      const inGroups = (k) => !!document.querySelector('#board .group .row[data-id="' + k + '"]');
      const parkedRow = (k) => document.querySelector('#fix-parked .handled-row[data-id="' + k + '"]');
      const line = document.getElementById("fix-parked");
      ok("no fix line while no fix parks an item", line.hidden && inGroups("issue-9495"));
      const spentBefore = document.querySelector("#plan .sum").textContent;
      items(park(["issue-9494", "issue-9495"])); await wait(10);
      for (let i = 0; i < 4; i++) for (const b of document.querySelectorAll(".show-all")) if (!b.hidden && !/less/i.test(b.textContent)) b.click();
      await wait(5);
      ok("parked: the issues leave every plan group", !inGroups("issue-9494") && !inGroups("issue-9495"));
      ok("parked: the fix PR's own item stays in the plan", inGroups("pr-9496"));
      ok("parked: a quiet line counts them and folds the rows", !line.hidden && line.querySelector("summary").textContent === "Has a fix in progress: 2" && !line.querySelector("details").open
        && line.previousElementSibling === document.getElementById("handled"));
      ok("parked: the rows carry the fix chip", parkedRow("issue-9494")?.querySelector(".agent-chip")?.textContent === "Fix running" && parkedRow("issue-9495")?.querySelector(".agent-chip")?.textContent === "Fix: #9496 draft");
      ok("parked: no minutes count as spent", document.querySelector("#plan .sum").textContent === spentBefore);
      ok("a fix that does not park keeps its row and chip", inGroups("issue-9497") && chipOf("issue-9497")?.textContent === "Fix: #9498 open");
      line.querySelector("details").open = true;
      [...parkedRow("issue-9495").querySelectorAll("button")].find((b) => b.textContent === "Open").click(); await wait(20);
      ok("parked: Open shows the dialog with the fix banner", dlgR.open && detail.id === "issue-9495" && /^Draft fix #9496 is open/.test(document.getElementById("d-fix").textContent));
      await openItem("pr-9496");
      [...document.getElementById("d-fix-for").querySelectorAll("button")].find((b) => b.textContent === "Open on board").click(); await wait(20);
      ok("parked: the fix PR's dialog still opens the issue", dlgR.open && detail.id === "issue-9495");
      document.getElementById("d-close").click(); await wait(5);
      // Without routes the parked item stays loaded for that link
      items(park(["issue-9495"], () => ({ routes: [], hint: undefined }))); await wait(10);
      ok("parked without routes: listed in the fix line, not in the plan", !!parkedRow("issue-9495") && !inGroups("issue-9495") && line.querySelector("summary").textContent === "Has a fix in progress: 1");
      await openItem("pr-9496");
      [...document.getElementById("d-fix-for").querySelectorAll("button")].find((b) => b.textContent === "Open on board").click(); await wait(20);
      ok("parked without routes: the dialog opens with the banner and no cards", dlgR.open && detail.id === "issue-9495" && !document.getElementById("d-fix").hidden && cards().length === 0);
      document.getElementById("d-close").click(); await wait(5);
      items(F.map(([k, d]) => [k, k === "issue-9495" ? { ...d, handled: { at: new Date().toISOString(), routeId: "r2", routeType: "reply", verified: null }, fix: { ...d.fix, parked: true } } : d])); await wait(10);
      ok("a handled item with a parked fix is listed once, as handled", !!document.querySelector('#handled .handled-row[data-id="issue-9495"]') && !parkedRow("issue-9495"));
      items(F); await wait(10);
      for (let i = 0; i < 4; i++) for (const b of document.querySelectorAll(".show-all")) if (!b.hidden && !/less/i.test(b.textContent)) b.click();
      await wait(5);
      ok("when the fix no longer parks the item, the row is back with its chip", inGroups("issue-9495") && chipOf("issue-9495")?.textContent === "Fix: #9496 draft" && line.hidden);
    }
    state.reveal.clear(); render();
    // Dialog banners
    await openItem("issue-9494");
    const ban = document.getElementById("d-fix");
    ok("fix running: teal banner under the meta row, above the story", !ban.hidden && /^A fix is running\. The agent started it at \d\d:\d\d\.$/.test(ban.textContent)
      && document.getElementById("d-meta").nextElementSibling === ban && !!(ban.compareDocumentPosition(document.getElementById("d-story")) & Node.DOCUMENT_POSITION_FOLLOWING));
    ok("fix running: no Start fix card at all, the rest stays", !cards().some((c) => /Start fix/.test(c.textContent)) && cards().length === 1 && /Reply/.test(cards()[0].textContent));
    await openItem("issue-9495");
    ok("draft fix: the banner names the PR, its title and CI", /^Draft fix #9496 is open: fix: stop retrying on a 413\. CI running\./.test(ban.textContent)
      && ban.querySelector("a.btn")?.href === "https://github.com/acme/widgets/pull/9496" && ban.querySelector("a.btn").textContent === "Open PR");
    ok("draft fix: no fix route", !cards().some((c) => /Start fix/.test(c.textContent)));
    [...ban.querySelectorAll("button")].find((b) => b.textContent === "Open on board").click(); await wait(20);
    ok("Open on board switches to the fix PR's dialog", dlgR.open && detail.id === "pr-9496");
    const ff = document.getElementById("d-fix-for");
    ok("the fix PR says what it fixes, with the source title", !ff.hidden && ff.textContent.startsWith("Fix for acme/widgets#9495: Uploader retries forever on a 413"));
    [...ff.querySelectorAll("button")].find((b) => b.textContent === "Open on board").click(); await wait(20);
    ok("and back to the issue", dlgR.open && detail.id === "issue-9495");
    await openItem("issue-9497");
    ok("open fix: the banner with CI failing", /^Fix #9498 is open: fix: store the theme\. CI failing\./.test(ban.textContent) && !ban.querySelector("button"));
    await openItem("issue-9499");
    ok("merged: a quiet line, and fixing again is possible", ban.textContent === "Fixed by #9500" && ban.classList.contains("quiet") && cards().some((c) => /Start fix/.test(c.textContent)));
    // A race: the server already has a fix
    items(F.map(([k, d]) => [k, k === "issue-9494" ? { ...d, fix: undefined } : d])); await wait(10);
    await openItem("issue-9494");
    window.__reply = () => ({ ok: false, result: "A fix is already running for this item.", duplicate: true });
    cardBtn("Start fix").click(); await wait(20);
    ok("a fix 409 shows the server's message as information", /A fix is already running for this item\./.test(openCard().querySelector(".status.info")?.textContent ?? "") && !openCard().querySelector(".status.failed"));
    window.__reply = () => ({ ok: true, result: { dryRun: true } });
    items(F); await wait(5);
    // The agent is changing a PR
    await openItem("pr-9493");
    ok("push: the banner says what runs and to decide after", /^The agent is changing this PR \(take over, started \d\d:\d\d\)\. Decide after it is done\.$/.test(ban.textContent));
    const titles = cards().map((c) => c.querySelector(".card-head .r-hint").textContent);
    for (const hidden of ["Approve", "Merge", "Close", "Mark ready", "Take over", "Change", "Address review", "Drive", "Format"]) {
      ok("push: hides " + hidden, !titles.some((t) => t.startsWith(hidden)));
    }
    ok("push: reply and label stay", titles.some((t) => t.startsWith("Reply")) && titles.some((t) => t.startsWith("Label")));
    ok("push: Snooze and Analyze again stay", !document.querySelector('#d-foot [aria-label="Snooze 1 day"]').disabled && !!document.querySelector("#d-foot .foot-analyze"));
    items(F.map(([k, d]) => [k, k === "pr-9493" ? { ...d, working: { kind: "push", action: "revise", since: iso(60000) } } : d])); await wait(10);
    await openItem("pr-9493");
    ok("push: a running revise names itself in the banner and hides the pushing routes", /^The agent is changing this PR \(your requested change, started \d\d:\d\d\)\./.test(ban.textContent)
      && !cards().some((c) => /^(Change|Take over|Drive|Approve)/.test(c.querySelector(".card-head .r-hint").textContent)));
    items(F.map(([k, d]) => [k, k === "pr-9493" ? { ...d, working: undefined } : d])); await wait(10);
    await openItem("pr-9493");
    window.__reply = () => ({ ok: false, result: "The agent is changing this PR. Decide after it is done.", duplicate: true });
    cardBtn("Approve").click(); await wait(5);
    [...openCard().querySelectorAll(".card-actions button")].find((b) => /^Confirm/.test(b.textContent)).click(); await wait(20);
    ok("push 409 shows as information", /The agent is changing this PR\. Decide after it is done\./.test(openCard().querySelector(".status.info")?.textContent ?? ""));
    window.__reply = () => ({ ok: true, result: { dryRun: true } });
    items(F.map(([k, d]) => [k, k === "pr-9493" ? { ...d, working: undefined, reviewedAt: new Date().toISOString() } : d])); await wait(10);
    ok("when the job finishes the item arrives rewritten with the update line", !document.getElementById("d-updated").hidden && ban.hidden);
    // A review in progress keeps the quiet line and Analyzing…
    items(F.map(([k, d]) => [k, k === "issue-9471" ? { ...d, working: { kind: "review", since: iso(60000) } } : d])); await wait(10);
    await openItem("issue-9471");
    ok("review running: quiet line and Analyzing…", /reviewing this/.test(document.getElementById("d-working").textContent) && document.querySelector("#d-foot .foot-analyze").textContent === "Analyzing…");
    document.getElementById("d-close").click(); await wait(5);
    items(F); await wait(5);
  }

  // Order comes from the stored priority only, never from the author
  {
    const mk = (n, authorType, priority) => ["o-" + n, simple(n, "easy", 5, priority, { authorType, author: authorType === "bot" ? "widgets-bot" : authorType === "maintainer" ? "octocat" : "someone" })];
    items([mk(1, "maintainer", 1), mk(2, "bot", 2), mk(3, "contributor", 3)]); await wait(10);
    const order = () => [...document.querySelectorAll("#group-quick .row")].map((r) => r.dataset.id).join();
    ok("guard: with lower priorities the maintainer's and the bot's rows come first", order() === "o-1,o-2,o-3");
    items([mk(1, "maintainer", 3), mk(2, "bot", 2), mk(3, "contributor", 1)]); await wait(10);
    ok("guard: the contributor comes first only through its priority", order() === "o-3,o-2,o-1");
    items(F); await wait(5);
  }

  // Handled items leave the plan until the next run
  {
    const H = (minAgo, extra = {}) => ({ at: new Date(Date.now() - minAgo * 60000).toISOString(), routeId: "r1", routeType: "reply", verified: null, ...extra });
    const hset = (map) => items(F.map(([k, d]) => [k, Object.hasOwn(map, k) ? { ...d, handled: map[k] } : d]));
    localHandled.clear();
    hset({}); await wait(10);
    const sec = document.getElementById("handled");
    ok("no handled items: no line at the bottom", sec.hidden);
    const spentBefore = document.querySelector("#plan .sum").textContent;
    hset({ "issue-9471": H(2), "pr-9473": H(30, { routeId: "r2", routeType: "merge", verified: "merged" }), "issue-9472": H(12, { verified: "unchanged" }) }); await wait(10);
    ok("handled items are not in the three groups", !document.querySelector('#board .group .row[data-id="issue-9471"]') && !document.querySelector('#board .group .row[data-id="pr-9473"]'));
    ok("a quiet disclosure at the bottom counts them", !sec.hidden && !sec.querySelector("details").open && sec.querySelector("summary").textContent === "Handled, waiting for the next run: 3");
    ok("their effort counts as spent", document.querySelector("#plan .sum").textContent !== spentBefore);
    const hrow = (k) => sec.querySelector('.handled-row[data-id="' + k + '"]');
    ok("a handled row: number, title, what was done", /#9471/.test(hrow("issue-9471").textContent) && /Node 52 shows/.test(hrow("issue-9471").textContent) && /Reply: a PR is welcome/.test(hrow("issue-9471").textContent));
    ok("verified merged: the row says so and shows GitHub's merged icon", /merged on GitHub/.test(hrow("pr-9473").textContent) && hrow("pr-9473").querySelector(".h-kind svg").getAttribute("aria-label") === "Pull request, merged");
    ok("unchanged after 10 minutes: a quiet warning", hrow("issue-9472").querySelector(".h-check.tone-warn")?.textContent === "nothing changed on GitHub yet");
    ok("unchanged just now: no warning yet", (hset({ "issue-9472": H(2, { verified: "unchanged" }) }), await wait(10), !hrow("issue-9472").querySelector(".h-check")));
    hset({ "issue-9471": H(2), "pr-9474": { ...H(3), routeType: "close" } }); await wait(10);
    items(F.map(([k, d]) => [k, k === "pr-9474" ? { ...d, handled: H(3), live: { state: "closed", checkedAt: new Date().toISOString() } } : k === "issue-9471" ? { ...d, handled: H(2) } : d])); await wait(10);
    ok("item.live closed: closed icon and closed on GitHub", /closed on GitHub/.test(hrow("pr-9474").textContent) && hrow("pr-9474").querySelector(".h-kind svg").getAttribute("aria-label") === "Pull request, closed");
    // Bring back
    const wB = __writes.length;
    [...hrow("issue-9471").querySelectorAll("button")].find((b) => b.textContent === "Bring back").click(); await wait(10);
    ok("Bring back clears the mark with a merge write, no confirm", __writes.slice(wB).some((w) => w[0] === "update" && w[1] === "items/widgets/issue-9471" && w[2].handled === null));
    // The dialog of a handled item
    openDetail("pr-9474"); await wait(10);
    const hl = document.getElementById("d-handled");
    ok("dialog: one calm line on top, the cards stay usable", !hl.hidden && /^You handled this at \d\d:\d\d\. It returns after the next run if something is left to do\.$/.test(hl.textContent) && cards().length > 0 && !cards()[0].querySelector("button:disabled.card-head"));
    window.__refreshes.length = 0;
    document.getElementById("d-close").click(); await wait(10);
    ok("closing a handled item's dialog asks the server to check GitHub", window.__refreshes.some((b) => b.instance === "widgets" && b.itemId === "pr-9474"));
    // A prefill click: the item stays while the dialog is open, leaves when it closes
    hset({}); await wait(10);
    localHandled.clear();
    await openItem("issue-9477");
    ok("not handled yet: not in the handled line", !document.querySelector('#handled .handled-row[data-id="issue-9477"]'));
    cardBtn("Open GitHub to convert", cards()[0]).click(); await wait(20);
    ok("after the click nothing moves while the dialog is open", !document.querySelector('#handled .handled-row[data-id="issue-9477"]') && !!cards()[0].querySelector(".status.opened") && !!cardBtn("Open again", cards()[0]));
    document.getElementById("d-close").click(); await wait(10);
    ok("closing the dialog moves it to the handled line", !document.querySelector('#board .group .row[data-id="issue-9477"]') && !!document.querySelector('#handled .handled-row[data-id="issue-9477"]'));
    // Focus: refresh recent, unverified items once per focus, quietly on 429
    window.__refreshes.length = 0;
    hset({ "issue-9471": H(5), "issue-9472": H(5, { verified: "unchanged" }), "pr-9473": H(5, { verified: "merged" }), "pr-9474": H(40) }); await wait(10);
    localHandled.clear();
    window.dispatchEvent(new Event("focus")); await wait(10);
    const ids = window.__refreshes.map((b) => b.itemId).sort().join();
    ok("focus: refresh items handled in the last 15 minutes that are not verified yet", ids === "issue-9471,issue-9472");
    window.__refreshFails = true;
    document.dispatchEvent(new Event("visibilitychange")); await wait(10);
    ok("a rate-limited refresh is quiet", !document.querySelector(".status.failed") && document.getElementById("notice").textContent === "");
    window.__refreshFails = false;
    // The item's handled mark names one route. It marks no card
    hset({ "issue-9471": H(5) }); await wait(10);
    localOpened.clear();
    openDetail("issue-9471"); await wait(10);
    ok("a handled item alone marks no card as opened", !cards()[0].querySelector(".status.opened") && cards()[0].querySelector(".card-head .head-opened").hidden);
    document.getElementById("d-close").click(); await wait(5);
    items(F); await wait(5);
  }
