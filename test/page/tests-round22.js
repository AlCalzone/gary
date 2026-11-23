  // ---------- round 22 ----------
  // Opened on GitHub: the mark on a link click, the refresh on return, the merged state and the maintainer's review on GitHub
  {
    const base = "https://github.com/acme/widgets";
    const dlg = document.getElementById("detail");
    const routes = [{ id: "r1", type: "review", as: "me", actor: "me", title: "Approve: ready", text: "", recommended: true, draftHash: "h1", params: { event: "approve" } }];
    const pr = (n, extra) => ["pr-" + n, { kind: "pr", number: n, title: "PR " + n, url: base + "/pull/" + n, author: "someone", authorType: "contributor", category: "land", effortMinutes: 5, priority: 1, updatedAt: iso(1000), reviewedAt: iso(3600000), reviewDepth: "full", state: "Ready to approve.", links: [{ label: "Issue 1", url: base + "/issues/1" }], routes, ...extra }];
    const shut = async () => { if (dlg.open) { document.getElementById("d-close").click(); await wait(5); } };
    const reopen = async (key) => { await shut(); openDetail(key); await wait(10); };
    const cardsNow = () => [...document.querySelectorAll("#d-routes .card")];
    const marks = () => JSON.parse(localStorage.getItem("gary:widgets:githubMarks") || "{}");
    const follow = (a, type, init) => {
      a.addEventListener(type, (e) => e.preventDefault(), { once: true });
      a.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, ...init }));
    };
    const leaveAndReturn = async () => { window.dispatchEvent(new Event("blur")); window.dispatchEvent(new Event("focus")); await wait(10); };
    const sent = (id) => window.__refreshes.filter((b) => b.itemId === id);
    const openAnswer = (b) => ({ ok: true, result: { state: "open", checkedAt: new Date().toISOString() } });
    actions([]);

    // The mark on a click
    items([pr(2201), pr(2202), pr(2203), pr(2204)]); await wait(10);
    await reopen("pr-2201");
    follow(document.querySelector('#d-ref a[href="' + base + '/pull/2201"]'), "click");
    const m1 = marks()["pr-2201"];
    ok("github: a click on the link at the top marks the item with the time", Date.now() - Date.parse(m1) < 5000, JSON.stringify(marks()));
    await reopen("pr-2202");
    follow(document.querySelector('#d-links a[href="' + base + '/issues/1"]'), "click", { ctrlKey: true });
    ok("github: a ctrl click on a link in the dialog marks it too", !!marks()["pr-2202"]);
    await reopen("pr-2203");
    follow(document.querySelector('#d-links a[href="' + base + '/issues/1"]'), "auxclick", { button: 2 });
    ok("github: a right click marks nothing", !marks()["pr-2203"]);
    follow(document.querySelector('#d-links a[href="' + base + '/issues/1"]'), "auxclick", { button: 1 });
    ok("github: a middle click marks the item", !!marks()["pr-2203"]);
    await shut();

    // The refresh on return
    window.__refreshes.length = 0;
    window.__refreshAnswer = () => ({ ok: false, result: "Checked a moment ago. Try again in 5 s.", retryAfter: 5 });
    const failedBefore = document.querySelectorAll(".status.failed").length;
    const noticeBefore = document.getElementById("notice").textContent;
    await leaveAndReturn();
    ok("return: every marked item is refreshed with its mark time", sent("pr-2201").length === 1 && sent("pr-2201")[0].markedAt === m1 && sent("pr-2202").length === 1 && sent("pr-2203").length === 1 && sent("pr-2204").length === 0, JSON.stringify(window.__refreshes));
    document.dispatchEvent(new Event("visibilitychange")); await wait(10);
    ok("return: the second event of the same return sends no marked refresh again", sent("pr-2201").length === 1 && sent("pr-2202").length === 1, JSON.stringify(window.__refreshes));
    ok("return: a rate-limited refresh keeps the marks and shows nothing", !!marks()["pr-2201"] && !!marks()["pr-2202"] && document.querySelectorAll(".status.failed").length === failedBefore && document.getElementById("notice").textContent === noticeBefore);
    window.__refreshes.length = 0;
    window.__refreshAnswer = (b) => (b.itemId === "pr-2201" ? { ok: true, result: { state: "merged", checkedAt: new Date().toISOString() } } : b.itemId === "pr-2202" ? { ok: true, result: { state: "open", checkedAt: new Date().toISOString(), visited: { at: iso(1000), kind: "review", state: "approved" }, queued: true } } : openAnswer(b));
    await leaveAndReturn();
    ok("return: a merged thread or a queued analysis ends the mark, an open one keeps it", !marks()["pr-2201"] && !marks()["pr-2202"] && !!marks()["pr-2203"], JSON.stringify(marks()));
    window.__refreshes.length = 0;
    await leaveAndReturn();
    ok("return: the next return sends only the marks that are left", sent("pr-2201").length === 0 && sent("pr-2202").length === 0 && sent("pr-2203").length === 1);

    // A reload keeps the marks, and a mark expires after 2 hours
    githubMarks.clear();
    window.__refreshes.length = 0;
    await leaveAndReturn();
    ok("reload: the marks come back from local storage", sent("pr-2203").length === 1 && sent("pr-2203")[0].markedAt === marks()["pr-2203"]);
    localStorage.setItem("gary:widgets:githubMarks", JSON.stringify({ "pr-2203": iso(2 * 3600000 + 60000) }));
    githubMarks.clear();
    window.__refreshes.length = 0;
    await leaveAndReturn();
    ok("reload: a mark older than 2 hours is no longer sent", sent("pr-2203").length === 0);

    // The open dialog is refreshed on return, also without a click
    await reopen("pr-2204");
    window.__refreshes.length = 0;
    await leaveAndReturn();
    ok("return: the item of the open dialog is refreshed without a mark", sent("pr-2204").length === 1 && sent("pr-2204")[0].markedAt === undefined, JSON.stringify(window.__refreshes));
    await shut();
    window.__refreshAnswer = null;

    // Merged or closed on GitHub: out of the plan, and the dialog shows it
    items([pr(2205, { live: { state: "merged", checkedAt: new Date().toISOString() } }), pr(2206)]); await wait(10);
    const hrow = (id) => document.querySelector('#handled .handled-row[data-id="' + id + '"]');
    ok("merged: the item leaves today's plan for the handled line", !document.querySelector('#board .group .row[data-id="pr-2205"]') && /merged on GitHub/.test(hrow("pr-2205")?.textContent ?? "") && hrow("pr-2205").querySelector(".h-kind svg").getAttribute("aria-label") === "Pull request, merged");
    ok("merged: its row opens the dialog and has no Bring back", !![...hrow("pr-2205").querySelectorAll("button")].find((b) => b.textContent === "Open") && ![...hrow("pr-2205").querySelectorAll("button")].some((b) => b.textContent === "Bring back"));
    ok("merged: the plan shows no backlog count", !/\d+ (items|more)/.test(document.getElementById("plan").textContent));
    await reopen("pr-2205");
    const hl = document.getElementById("d-handled");
    ok("merged: the dialog says so and shows no route card", !hl.hidden && hl.textContent === "Merged on GitHub. It leaves the board with the next run." && cardsNow().length === 0 && document.getElementById("d-verdict").hidden, hl.textContent);
    await reopen("pr-2206");
    ok("merged: an open item still has its card", cardsNow().length === 1 && document.getElementById("d-handled").hidden);
    items([pr(2205, { live: { state: "merged", checkedAt: new Date().toISOString() } }), pr(2206, { live: { state: "closed", checkedAt: new Date().toISOString() } })]); await wait(10);
    ok("closed while the dialog is open: the cards go and the line says closed", cardsNow().length === 0 && document.getElementById("d-handled").textContent === "Closed on GitHub. It leaves the board with the next run." && /closed/i.test(document.getElementById("d-ref").textContent));
    await shut();

    // The maintainer's review or comment on GitHub
    const visited = { at: iso(60000), kind: "review", state: null };
    items([pr(2207, { visited })]); await wait(10);
    const rowChip = () => document.querySelector('#board .group .row[data-id="pr-2207"] .visit-chip');
    ok("reviewed: the row keeps its place and says You reviewed it on GitHub", rowChip()?.textContent === "Reviewed on GitHub" && /^You reviewed this on GitHub at \d\d:\d\d\./.test(rowChip().title), rowChip()?.outerHTML);
    await reopen("pr-2207");
    const line = document.getElementById("d-visited");
    ok("reviewed: the dialog says so and dims the cards from before", !line.hidden && /^You reviewed this on GitHub at \d\d:\d\d\. The cards below are from before that\.$/.test(line.textContent) && document.getElementById("d-routes").classList.contains("stale") && getComputedStyle(cardsNow()[0]).opacity === "0.6", line.textContent);
    actions([["widgets/v1", { instance: "widgets", itemId: "pr-2207", action: "reanalyze", status: "queued", via: "queue", createdAt: new Date().toISOString(), params: { by: "github_visit" } }]]); await wait(10);
    ok("reviewed: with the analysis queued the line says the agent is on it", /The agent is analyzing it again\.$/.test(line.textContent), line.textContent);
    await shut();
    ok("reviewed: the row waits in the analyzing line with the chip", !document.querySelector('#board .group .row[data-id="pr-2207"]') && document.querySelector('#analyzing .handled-row[data-id="pr-2207"] .visit-chip')?.textContent === "Reviewed on GitHub");
    actions([]);
    items([pr(2207, { visited: { ...visited, state: "approved" } })]); await wait(10);
    ok("approved: the chip names the approval", rowChip()?.textContent === "Approved on GitHub");
    items([pr(2207, { visited, focus: { status: "active", harness: "t3code", how: "started", session: { id: "thread-7", title: "Focus: PR 2207" }, startedAt: iso(60000), lastActivity: iso(1000) } })]); await wait(10);
    ok("in focus: the row shows the visit chip next to the focus chip", !!document.querySelector('#board .group .row[data-id="pr-2207"] .focus-chip') && rowChip()?.textContent === "Reviewed on GitHub");
    items([pr(2207, { visited: { at: iso(60000), kind: "comment", state: null } })]); await wait(10);
    await reopen("pr-2207");
    ok("commented: the dialog says You commented on GitHub", /^You commented on GitHub at \d\d:\d\d\./.test(line.textContent), line.textContent);
    items([pr(2207, { visited, reviewedAt: iso(1000) })]); await wait(10);
    ok("a newer analysis ends the state: no line, no dimmed cards", line.hidden && !document.getElementById("d-routes").classList.contains("stale") && getComputedStyle(cardsNow()[0]).opacity === "1");
    await shut();
    ok("a newer analysis ends the chip", !rowChip());

    items([]); await wait(5);
  }
