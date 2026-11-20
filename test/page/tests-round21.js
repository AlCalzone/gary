  // ---------- round 21 ----------
  // Focus: the button that asks for a session, the In focus and Focus paused states, and the item that stays in the plan
  {
    const base = "https://github.com/acme/widgets";
    const dlg = document.getElementById("detail");
    const banner = () => document.getElementById("d-focus");
    const focusBtn = () => document.querySelector("#d-foot .foot-focus");
    const analyzeBtn = () => document.querySelector("#d-foot .foot-analyze");
    const chip = (id) => document.querySelector('.row[data-id="' + id + '"] .focus-chip');
    const routes = [
      { id: "r1", type: "review", as: "me", actor: "me", title: "Review: ask for the cleared timeout", text: "Please clear it.", recommended: true, draftHash: "h1" },
      { id: "r2", type: "revise", as: "agent", actor: "agent", title: "Change: clear the timeout", text: "Clear it.", draftHash: "h2" },
    ];
    const pr = (n, extra) => ["pr-" + n, { kind: "pr", number: n, title: "PR " + n, url: base + "/pull/" + n, author: "someone", authorType: "contributor", category: "land", effortMinutes: 5, priority: 1, updatedAt: iso(1000), reviewDepth: "full", state: "The fix waits.", routes, ...extra }];
    const session = { id: "thread-1", title: "Focus: PR 2101", link: "t3-thread://v2/env/thread-1" };
    const reopen = async (key) => { if (dlg.open) { document.getElementById("d-close").click(); await wait(5); } openDetail(key); await wait(10); };
    const openGroups = async () => { for (let i = 0; i < 4; i++) { for (const b of document.querySelectorAll(".show-all")) if (!b.hidden && !/less/i.test(b.textContent)) b.click(); await wait(2); } };

    // No focus: the button asks the master for a session
    __calls.length = 0;
    items([pr(2101)]); await wait(10);
    await reopen("pr-2101");
    ok("focus: every item's dialog has a Focus button", focusBtn() && !focusBtn().hidden && focusBtn().textContent === "Focus" && banner().hidden);
    focusBtn().click(); await wait(10);
    ok("focus: the click sends one focus request for the item", __calls.length === 1 && __calls[0].tool === "focus" && __calls[0].itemId === "pr-2101" && __calls[0].instance === "widgets", JSON.stringify(__calls));
    ok("focus: the footer says the master has it", /Queued for the master session/.test(document.querySelector("#d-foot .foot-status").textContent), document.querySelector("#d-foot .foot-status").textContent);

    // Requested. The list stays as it is while a dialog is open, so the rows are read with the dialog closed
    const shut = async () => { if (dlg.open) { document.getElementById("d-close").click(); await wait(5); } };
    await shut();
    items([pr(2101, { focus: { status: "requested", at: iso(1000) } })]); await wait(10);
    ok("focus requested: the row says the master sets it up", chip("pr-2101")?.textContent === "Focus requested");
    await reopen("pr-2101");
    ok("focus requested: the dialog says so too, and the button is gone", !banner().hidden && /The master looks for a session/.test(banner().textContent) && focusBtn().hidden);

    // Active
    const started = new Date(Date.now() - 20 * 60000).toISOString();
    await shut();
    items([pr(2101, { focus: { status: "active", harness: "t3code", how: "started", session, startedAt: started, lastActivity: iso(60000) } })]); await wait(10);
    ok("in focus: the row shows the In focus chip", chip("pr-2101")?.textContent === "In focus" && /Focus: PR 2101/.test(chip("pr-2101").title));
    await reopen("pr-2101");
    ok("in focus: the callout says why Gary does not act", /In focus in Focus: PR 2101 since/.test(banner().textContent) && /no worker, review round or push touches it/.test(banner().textContent), banner().textContent);
    const openLink = banner().querySelector("a");
    ok("in focus: the callout links the session", openLink?.textContent === "Open session" && openLink.getAttribute("href") === session.link && openLink.rel.includes("noopener"));
    ok("in focus: no Focus, no Analyze again, no agent route", focusBtn().hidden && analyzeBtn().hidden && ![...dlg.querySelectorAll(".card .card-title, .card h3, .card")].some((c) => /Change: clear the timeout/.test(c.textContent)) && /Review: ask for the cleared timeout/.test(dlg.textContent));
    items([pr(2101, { focus: { status: "active", session: { ...session, link: "javascript:alert(1)" }, startedAt: started } })]); await wait(10);
    ok("in focus: a link of another scheme is not shown", !banner().querySelector("a"));
    document.getElementById("d-close").click(); await wait(5);

    // The plan keeps it, also beyond the budget and without routes
    const before = state.filters.budget;
    state.filters.budget = 2;
    items([pr(2102, { effortMinutes: 120, priority: 1 }), pr(2103, { effortMinutes: 120, priority: 9, routes: [], focus: { status: "active", session, startedAt: started } })]); await wait(10);
    await openGroups();
    const rows = [...document.querySelectorAll("#board .row")].map((r) => r.dataset.id);
    ok("in focus: the item stays in today's plan, first, beyond the budget and without routes", rows.includes("pr-2103") && rows.includes("pr-2102") && rows.indexOf("pr-2103") < rows.indexOf("pr-2102"), rows.join());
    ok("in focus: the plan shows no count of the backlog", !/\d+ (items|more)/.test(document.getElementById("plan").textContent), document.getElementById("plan").textContent);
    state.filters.budget = before;

    // Paused
    __calls.length = 0;
    items([pr(2101, { focus: { status: "paused", session, startedAt: started, lastActivity: iso(40 * 60000), pausedAt: iso(5 * 60000) } })]); await wait(10);
    ok("focus paused: the row shows the Focus paused chip", chip("pr-2101")?.textContent === "Focus paused" && chip("pr-2101").classList.contains("paused"));
    await reopen("pr-2101");
    ok("focus paused: the callout says Gary still holds the item and touches nothing", banner().classList.contains("paused") && /Focus paused: Focus: PR 2101 has been quiet since/.test(banner().textContent) && /touches nothing until you resume the session or end the focus/.test(banner().textContent), banner().textContent);
    const resume = [...banner().querySelectorAll("a")].find((a) => a.textContent === "Resume");
    const end = [...banner().querySelectorAll("button")].find((b) => b.textContent === "End focus");
    ok("focus paused: Resume links the session, and End focus is there", resume?.getAttribute("href") === session.link && !!end);
    end.click(); await wait(10);
    ok("focus paused: End focus sends end_focus for the item", __calls.length === 1 && __calls[0].tool === "end_focus" && __calls[0].itemId === "pr-2101", JSON.stringify(__calls));

    // A refusal because of the focus is information
    __calls.length = 0;
    window.__reply = (b) => (b.tool === "focus" ? { ok: false, result: "This item is already in focus.", focus: true } : { ok: true, result: { dryRun: true } });
    items([pr(2101)]); await wait(10);
    focusBtn().click(); await wait(10);
    const refusal = document.querySelector("#d-foot .foot-status .status");
    ok("focus: a refusal for an item in focus shows as information", refusal?.classList.contains("info") && /already in focus/.test(refusal.textContent), document.querySelector("#d-foot .foot-status").innerHTML.slice(0, 200));
    window.__reply = () => ({ ok: true, result: { dryRun: true } });

    // Failed
    await shut();
    items([pr(2101, { focus: { status: "failed", reason: "This master runs in Claude Code and cannot start a session.", at: iso(1000) } })]); await wait(10);
    ok("no focus session: the row says so", chip("pr-2101")?.textContent === "No focus session" && /cannot start a session/.test(chip("pr-2101").title));
    await reopen("pr-2101");
    ok("no focus session: the callout gives the reason, and Focus can be asked again", /cannot start a session/.test(banner().textContent) && !focusBtn().hidden && !analyzeBtn().hidden);

    document.getElementById("d-close").click(); await wait(5);
    items([]); await wait(5);
  }
