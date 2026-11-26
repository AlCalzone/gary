  // ---------- round 24 ----------
  // A review draft: the walkthrough, the verdict that picks the body, the editable comments, the pending review button,
  // and the line with "Prepare review" when no draft started by itself
  {
    const base = "https://github.com/acme/widgets";
    const dlg = document.getElementById("detail");
    const shut = async () => { if (dlg.open) { document.getElementById("d-close").click(); await wait(5); } };
    const bodies = { request_changes: "Two things before this can go in.", approve: "Thanks, this works.", comment: "A few notes." };
    const route = { id: "r1", type: "review", as: "me", actor: "me", title: "Request changes: two comments", recommended: true, draftHash: "h24", text: bodies.request_changes,
      params: { pending: true, event: "request_changes", bodies, comments: [{ id: "c1", path: "src/a.js", line: 12, text: "This grows without a limit.", diffHunk: "@@ -10,3 +10,4 @@\n a\n+c" }] } };
    const walkthrough = {
      why: "The capture drops frames when the buffer fills.", what: "The PR grows the buffer on demand.",
      how: [{ text: "`Buffer.grow` doubles the size.", path: "src/a.js", line: 12, url: base + "/pull/2401/files#diff-abc R12".replace(" ", "") }, { text: "A test fills it twice.", path: "test/a.test.js", url: base + "/pull/2401/files#diff-def" }],
    };
    const common = { kind: "pr", author: "alice", authorType: "contributor", category: "unblock", effortMinutes: 5, priority: 1, updatedAt: iso(1000), reviewDepth: "full", reviewedAt: iso(2000), reviewedSha: "c".repeat(40), state: "Two changes before it is ready." };
    items([
      ["pr-2401", { ...common, number: 2401, title: "Fix the debug capture", url: base + "/pull/2401", walkthrough, hint: route.title, routes: [route], reviewDraft: { state: "ready", sha: "c".repeat(40), headMoved: false, canPrepare: false } }],
      ["pr-2402", { ...common, number: 2402, title: "Rewrite the parser", url: base + "/pull/2402", reviewDepth: "quick", hint: "Open: review the parser", routes: [{ id: "r1", type: "open", as: "me", actor: "me", title: "Open: review the parser", recommended: true, draftHash: "h1" }],
        reviewDraft: { state: "held", code: "size", message: "PR #2402 changes 1,240 lines, more than the limit of 800 in reviewDraftMaxLines.", canPrepare: true } }],
    ]);
    await wait(10);
    await openAll();
    window.__opened = [];
    window.open = (url) => { window.__opened.push(url); return null; };

    openDetail("pr-2401"); await wait(10);
    const walk = document.getElementById("d-walk");
    ok("draft: the walkthrough shows why, what and how, each step linked into the diff", !walk.hidden && /^Why:/.test(walk.children[0].textContent) && /^What:/.test(walk.children[1].textContent)
      && walk.querySelectorAll("ol li").length === 2 && walk.querySelector("ol li a")?.getAttribute("href") === walkthrough.how[0].url && walk.querySelector("ol li a code")?.textContent === "src/a.js:12", walk.innerHTML);
    ok("draft: an arrived draft shows no Prepare review line", document.getElementById("d-draft").hidden);
    const card = () => document.querySelector("#d-routes .card.open") || document.querySelector("#d-routes .card");
    const segs = () => [...card().querySelectorAll(".review-event .seg")];
    ok("draft: the card offers the three verdicts with Gary's preselected", card().querySelector(".review-event .card-label")?.textContent === "Verdict" && segs().map((b) => b.textContent).join() === "Request changes,Comment,Approve" && segs().find((b) => b.getAttribute("aria-pressed") === "true")?.textContent === "Request changes");
    ok("draft: the card says which verdict to pick on GitHub", /Pick “Request changes” there/.test(card().querySelector(".verdict-hint")?.textContent ?? ""));
    ok("draft: the inline comment can be edited and unchecked", !!card().querySelector(".checklist li button.c-edit") && !!card().querySelector(".checklist li input[type=checkbox]"));
    const button = () => [...card().querySelectorAll(".card-actions button")].find((b) => /pending review/.test(b.textContent));
    ok("draft: one button prepares the pending review, and nothing copies or posts as a bot", !!button() && button().textContent.includes("Prepare pending review on GitHub") && ![...card().querySelectorAll(".card-actions button")].some((b) => /^Copy|Confirm/.test(b.textContent)));
    segs().find((b) => b.textContent === "Approve").click(); await wait(10);
    ok("draft: an untouched body follows the verdict", card().querySelector("textarea")?.value === bodies.approve && /Pick “Approve” there/.test(card().querySelector(".verdict-hint").textContent));
    const li = card().querySelector(".checklist li");
    [...li.querySelectorAll("button.c-edit")].find((b) => b.textContent === "Edit").click(); await wait(5);
    const ta = li.querySelector("textarea") || card().querySelector(".checklist li textarea");
    ta.value = "Cap the size, please."; ta.dispatchEvent(new Event("input"));
    [...card().querySelectorAll(".checklist li button")].find((b) => b.textContent === "Done").click(); await wait(5);
    const calls = __calls.length;
    window.__reply = (b) => (b.tool === "pending_review" ? { ok: true, result: "Pending review on GitHub, with 1 comment. Only you see it. Submit it there as \"Approve\".", url: base + "/pull/2401/files", event: "approve" } : { ok: true, result: { dryRun: true } });
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (t) => { window.__clip = t; } } });
    button().click(); await wait(20);
    const sent = __calls.at(-1);
    ok("draft: the click copies the summary of the picked verdict", window.__clip === bodies.approve && /summary is in your clipboard/.test(dlg.textContent), window.__clip);
    ok("draft: the click sends pending_review with the verdict, the body and the edited comment", __calls.length === calls + 1 && sent.tool === "pending_review" && sent.routeId === "r1" && sent.draftHash === "h24" && sent.input.event === "approve"
      && sent.text === bodies.approve && JSON.stringify(sent.input.commentIds) === '["c1"]' && sent.input.commentTexts?.c1 === "Cap the size, please.", sent);
    ok("draft: the board opens the PR's files view and says which verdict to pick", window.__opened.at(-1) === base + "/pull/2401/files" && /Submit it there as "Approve"/.test(dlg.textContent));
    await shut();

    window.__reply = (b) => (b.tool === "pending_review" ? { ok: false, result: "You already have a pending review on this PR. Finish or discard it on GitHub first. Gary does not change it.", existing: true } : { ok: true, result: { dryRun: true } });
    items([["pr-2401", { ...common, number: 2401, title: "Fix the debug capture", url: base + "/pull/2401", walkthrough, hint: route.title, routes: [{ ...route, draftHash: "h25" }] }]]);
    await wait(10);
    openDetail("pr-2401"); await wait(10);
    const opened = window.__opened.length;
    button().click(); await wait(20);
    ok("draft: an existing pending review is refused with its reason, and nothing opens", /already have a pending review/.test(dlg.textContent) && window.__opened.length === opened);
    await shut();

    items([["pr-2402", { ...common, number: 2402, title: "Rewrite the parser", url: base + "/pull/2402", reviewDepth: "quick", hint: "Open: review the parser", routes: [{ id: "r1", type: "open", as: "me", actor: "me", title: "Open: review the parser", recommended: true, draftHash: "h1" }],
      reviewDraft: { state: "held", code: "size", message: "PR #2402 changes 1,240 lines, more than the limit of 800 in reviewDraftMaxLines.", canPrepare: true } }]]);
    await wait(10);
    openDetail("pr-2402"); await wait(10);
    const line = document.getElementById("d-draft");
    ok("held: the line says why no draft started, with the numbers", !line.hidden && /1,240 lines/.test(line.textContent) && /800/.test(line.textContent));
    window.__reply = (b) => (b.tool === "prepare_review" ? { ok: true, result: "Queued. The agent prepares the review draft.", queued: true } : { ok: true, result: { dryRun: true } });
    const c2 = __calls.length;
    line.querySelector("button").click(); await wait(20);
    ok("held: Prepare review sends prepare_review for the item", __calls.length === c2 + 1 && __calls.at(-1).tool === "prepare_review" && __calls.at(-1).itemId === "pr-2402");
    await shut();
    window.__reply = () => ({ ok: true, result: { dryRun: true } });
    items([]); await wait(5);
  }
