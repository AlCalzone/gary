<script>
const log = [];
window.addEventListener("error", (e) => log.push("PAGEERR " + e.message));
window.addEventListener("unhandledrejection", (e) => log.push("REJECT " + (e.reason && e.reason.stack || e.reason)));
(async () => {
  const ok = (name, v) => log.push((v ? "PASS " : "FAIL ") + name);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  await wait(100);
  const iso = (ms) => new Date(Date.now() - ms).toISOString();
  const item = (title, text, extra) => ({ kind: "pr", number: 9488, title, url: "https://github.com/acme/widgets/pull/9488", author: "someone", authorType: "contributor", labels: ["config"], ci: "failing", section: "easy", priority: 1, updatedAt: iso(0), reviewDepth: "full", effortMinutes: 5, waitingDays: 12, state: "Looks fine.", findings: [{ severity: "minor", text: "nit", ref: "a.ts:1" }], routes: [{ id: "r1", type: "reply", as: "bot", title: "Reply: thanks", text, recommended: true }, { id: "r2", type: "merge", as: "me", title: "Merge" }], links: [], ...extra });
  // Every item on the board has a route. The untitled chore keeps rows without a hint.
  const simple = (n, section, effort, priority, extra) => ({ kind: "issue", number: n, title: "Item " + n, section, effortMinutes: effort, priority, updatedAt: iso(n * 1000), routes: [{ id: "r0", type: "chore", as: "bot", title: "", params: { action: "update_branch" }, recommended: true }], ...extra });
  const items = (list) => window.__subs["items"](__mkSnap(list));
  const actions = (list) => window.__subs["actions"](__mkSnap(list));
  const todayIds = () => [...document.querySelectorAll("#today .row")].map((r) => r.dataset.id);
  const laterIds = () => [...document.querySelectorAll("#not-today .row")].map((r) => r.dataset.id);
  const spentText = () => document.querySelector("#plan .sum").textContent;
  const todayBtn = () => document.querySelector("#today .show-all");
  window.__subs["meta/widgets"]({ exists: true, data: () => ({ lastRunAt: iso(3e6), staleIssues: 240 }) });
  actions([]);

  const ids = (g) => [...document.querySelectorAll("#group-" + g + " .row")].map((r) => r.dataset.id);
  const moreBtn = (g) => document.querySelector("#group-" + g + " .show-all");
  const openAll = async () => { for (let i = 0; i < 5; i++) { for (const b of document.querySelectorAll(".show-all")) if (!b.hidden) b.click(); await wait(2); } };
  const kindLabel = (id) => { const r = document.querySelector('.row[data-id="' + id + '"]'); return r && r.querySelector(".r-kind svg").getAttribute("aria-label"); };
  const revLabel = (id) => { const r = document.querySelector('.row[data-id="' + id + '"]'); const s = r && r.querySelector(".r-rev svg"); return s ? s.getAttribute("aria-label") : ""; };
  const future = new Date(Date.now() + 3 * 86400000).toISOString();

  // Grouping by section, snoozed and dismissed items in the third group
  items([["i1", simple(1, "active", 5, 1)], ["i2", simple(2, "easy", 5, 1)], ["i3", simple(3, "almost", 5, 1)], ["i4", simple(4, "review", 5, 1)], ["i5", simple(5, "deferred", 5, 1)], ["i6", simple(6, "hardware", 5, 1)], ["i7", simple(7, "active", 5, 1, { snoozedUntil: future })], ["i8", simple(8, "easy", 5, 1, { hidden: true })]]);
  await wait(10);
  ok("quick holds active and easy: " + ids("quick"), ids("quick").join(",") === "i1,i2");
  ok("afterwards holds almost and review: " + ids("after"), ids("after").join(",") === "i3,i4");
  ok("later holds deferred and hardware: " + ids("later"), ids("later").join(",") === "i5,i6");
  ok("snoozed not planned, behind show more", !moreBtn("later").hidden && moreBtn("later").textContent === "Show more");
  moreBtn("later").click(); await wait(5);
  ok("snoozed lands in later with chip: " + ids("later"), ids("later").join(",") === "i5,i6,i7" && document.querySelector('.row[data-id="i7"] .cat').textContent === "Snoozed");
  ok("category chips", ["Active", "Easy", "Almost", "Review", "Later", "Hardware"].every((t, i) => document.querySelector('.row[data-id="i' + (i + 1) + '"] .cat').textContent === t));
  ok("dismissed hidden by default", !ids("later").includes("i8"));
  document.getElementById("show-hidden").click(); await wait(5); await openAll();
  ok("dismissed shows in later with show dismissed", ids("later").includes("i8"));
  document.getElementById("show-hidden").click(); await wait(5);
  state.reveal.clear();

  // Budget fill across groups with skip
  items([["q1", simple(1, "active", 300, 1)], ["a1", simple(2, "almost", 120, 1)], ["a2", simple(3, "review", 45, 1)], ["l1", simple(4, "deferred", 15, 1)], ["l2", simple(5, "hardware", 30, 1)]]);
  await wait(10);
  ok("budget fill: " + ids("quick") + "|" + ids("after") + "|" + ids("later"), ids("quick").join(",") === "q1" && ids("after").join(",") === "a2" && ids("later").join(",") === "l1");
  ok("skipped item behind show more", !moreBtn("after").hidden && !moreBtn("later").hidden);
  ok("progress text " + spentText(), spentText() === "0 h of 6 h");
  ok("no backlog numbers in default view", !/240|stale|pending/i.test(document.querySelector("header").textContent));

  // Quick & Easy shows 5 rows and the next planned item moves up
  items(Array.from({ length: 8 }, (_, i) => ["e" + (i + 1), simple(i + 1, "easy", 10, i + 1)]));
  await wait(10);
  ok("quick capped at 5: " + ids("quick"), ids("quick").join(",") === "e1,e2,e3,e4,e5" && !moreBtn("quick").hidden);
  items(Array.from({ length: 8 }, (_, i) => ["e" + (i + 1), simple(i + 1, "easy", 10, i + 1, i === 0 ? { handled: { at: iso(60000), routeId: "r0", routeType: "chore", verified: null } } : {})]));
  await wait(10);
  ok("next planned moves up: " + ids("quick"), ids("quick").join(",") === "e2,e3,e4,e5,e6");
  ok("handled counts as spent: " + spentText(), spentText() === "10 min of 6 h");
  actions([]);

  // Show more reveals 10 at a time
  items(Array.from({ length: 25 }, (_, i) => ["m" + (i + 1), simple(i + 1, "almost", 60, i + 1)]));
  await wait(10);
  ok("after shows planned 6: " + ids("after").length, ids("after").length === 6);
  moreBtn("after").click(); await wait(5);
  ok("show more adds 10: " + ids("after").length, ids("after").length === 16);
  moreBtn("after").click(); await wait(5);
  ok("show more to the end", ids("after").length === 25 && moreBtn("after").hidden);
  state.reveal.clear();

  // Plan done and Add more
  items([["d1", simple(1, "easy", 30, 1)]]);
  items([["d1", simple(1, "easy", 30, 1, { handled: { at: iso(1000), routeId: "r0", routeType: "close", verified: null } })]]);
  await wait(10);
  ok("plan done with add more", !document.querySelector(".plan-done").hidden);
  document.querySelector(".plan-done button").click(); await wait(5);
  ok("add more raises budget: " + spentText(), /of 7 h$/.test(spentText()));
  actions([]);

  // Hint
  items([["h1", simple(1, "easy", 5, 1, { hint: "Maybe reply that a PR is welcome" })], ["h2", simple(2, "easy", 5, 2)]]);
  await wait(10);
  ok("hint shown", document.querySelector('.row[data-id="h1"] .r-hint').textContent === "Maybe reply that a PR is welcome");
  ok("no hint element without hint", !document.querySelector('.row[data-id="h2"] .r-hint'));
  ok("short age without ago: " + document.querySelector('.row[data-id="h2"] .r-age').textContent, /^(now|\d+(m|h|d|mo))$/.test(document.querySelector('.row[data-id="h2"] .r-age').textContent));
  ok("state not in row", !/Item 1 state/.test(document.querySelector('.row[data-id="h1"]').textContent));

  // Status mapping
  const yesterday = new Date(Date.now() - 2 * 86400000).toISOString();
  const prx = (n, extra) => simple(n, "easy", 1, n, { kind: "pr", ci: "passing", ...extra });
  items([
    ["s1", simple(1, "easy", 1, 1)], ["s2", simple(2, "easy", 1, 2, { solved: true })], ["s3", simple(3, "easy", 1, 3, { hidden: true })],
    ["s4", simple(4, "easy", 1, 4)], ["s5", simple(5, "easy", 1, 5)],
    ["p1", prx(6, { mergeable: "mergeable", reviewDecision: "approved" })], ["p2", prx(7, { mergeable: "conflicting", reviewDecision: "changes_requested" })],
    ["p3", prx(8, { reviewDecision: "pending" })], ["p4", prx(9, { isDraft: true })], ["p5", prx(10, { mergeable: "unknown" })], ["p6", prx(11, {})],
    ["p7", prx(12, { mergeable: "mergeable", ci: "failing" })],
    ["c1", simple(13, "easy", 1, 13, { kind: "discussion" })], ["c2", simple(14, "easy", 1, 14, { kind: "discussion", isAnswered: true })], ["c3", simple(15, "easy", 1, 15, { kind: "discussion" })],
  ]);
  actions([
    ["y1", { itemId: "s4", action: "close", params: { reason: "not_planned" }, status: "done", createdAt: yesterday }],
    ["y2", { itemId: "s5", action: "close", params: { reason: "completed" }, status: "done", createdAt: yesterday }],
    ["y3", { itemId: "p5", action: "merge", status: "done", createdAt: yesterday }],
    ["y4", { itemId: "p6", action: "close", status: "done", createdAt: yesterday }],
    ["y5", { itemId: "c3", action: "close", status: "done", createdAt: yesterday }],
  ]);
  await wait(10);
  ok("merged and closed items stay out of the plan", ["s4", "s5", "p5", "p6", "c3"].every((id) => !ids("quick").includes(id)));
  document.getElementById("show-hidden").click(); await wait(5); await openAll();
  const expect = {
    s1: "Issue, open", s2: "Issue, open", s3: "Issue, open", s4: "Issue, closed as not planned", s5: "Issue, closed as completed",
    p1: "Pull request, ready", p2: "Pull request, has conflicts", p3: "Pull request, open", p4: "Pull request, draft", p5: "Pull request, merged", p6: "Pull request, closed", p7: "Pull request, open",
    c1: "Discussion, open", c2: "Discussion, answered", c3: "Discussion, closed",
  };
  const bad = Object.entries(expect).filter(([id, l]) => kindLabel(id) !== l).map(([id]) => id + "=" + kindLabel(id));
  ok("kind status mapping " + bad.join(";"), bad.length === 0);
  const shapes = { p1: "pr", p2: "prConflict" };
  const metaLabels = (id) => [...document.querySelectorAll('.row[data-id="' + id + '"] .r-meta svg')].map((s) => s.getAttribute("aria-label"));
  ok("PR mergeability sits on the kind icon only", !metaLabels("p2").includes("Has conflicts") && !metaLabels("p1").includes("Ready to merge") && document.querySelector('.row[data-id="p2"] .r-kind svg').innerHTML !== document.querySelector('.row[data-id="p6"] .r-kind svg').innerHTML);
  ok("open plus solved shows the open icon and the solved state icon", kindLabel("s2") === "Issue, open" && metaLabels("s2").includes("Looks solved, still open"));
  ok("dismissed issue keeps the open icon and shows the dismissed state", kindLabel("s3") === "Issue, open" && metaLabels("s3").includes("Dismissed"));
  ok("closed issue shows no solved state icon", !metaLabels("s5").includes("Looks solved, still open"));
  ok("review pending is the hourglass", document.querySelector('.row[data-id="p3"] .r-rev svg').innerHTML === icon("hourglass", "Review pending", "faint").innerHTML);
  state.latestAction.set(actionRef("widgets", "__q"), { status: "queued", action: "merge", createdAt: new Date().toISOString() });
  const queuedIcon = stateIcons("__q", {}, false, false)[0];
  state.latestAction.delete(actionRef("widgets", "__q"));
  ok("queued uses its own shape", queuedIcon[0] === "queued" && icon("queued").innerHTML !== icon("hourglass").innerHTML);
  ok("review icons", revLabel("p1") === "Review approved" && revLabel("p2") === "Changes requested" && revLabel("p3") === "Review pending" && revLabel("s1") === "" && revLabel("p4") === "");
  ok("at most 3 state icons plus the author type", [...document.querySelectorAll(".r-meta")].every((e) => e.children.length <= 4));
  const all = [...document.querySelectorAll("#board .row")].map((r) => r.dataset.id);
  ok("no duplication", new Set(all).size === all.length);
  document.getElementById("show-hidden").click(); await wait(5);
  state.reveal.clear();
  actions([]);

  // Bold action in hints
  const hints = { b1: "Merge", b2: "Reply: point to widgets-desktop", b3: "Request changes for the style nits", b4: "Looks fine to me", b5: "Start fix now", b6: "Reviewer asked twice" };
  items(Object.entries(hints).map(([id, hint], i) => [id, simple(i + 1, i < 3 ? "easy" : "almost", 1, i + 1, { hint })]));
  await wait(10);
  const boldOf = (id) => { const r = document.querySelector('.row[data-id="' + id + '"] .r-hint'); return [r.querySelector(".h-act").textContent, r.textContent]; };
  const boldExpect = { b1: "Merge", b2: "Reply", b3: "Request changes", b4: "Looks", b5: "Start fix", b6: "Reviewer" };
  const boldBad = Object.entries(boldExpect).filter(([id, v]) => boldOf(id)[0] !== v || boldOf(id)[1] !== hints[id]).map(([id]) => id + "=" + JSON.stringify(boldOf(id)));
  ok("action split in hints " + boldBad.join(" "), boldBad.length === 0);
  const groups = { b1: "act-finish", b2: "act-talk", b3: "act-push", b4: "", b5: "act-agent", b6: "" };
  const groupBad = Object.entries(groups).filter(([id, g]) => { const r = document.querySelector('.row[data-id="' + id + '"] .r-hint'); return [...r.classList].filter((c) => c.startsWith("act-")).join("") !== g; }).map(([id]) => id);
  ok("hint color groups " + groupBad.join(" "), groupBad.length === 0);
  ok("Close is its own red group", hintEl("Close: fixed in 15.2").classList.contains("act-close") && hintEl("Approve").classList.contains("act-finish"));
  ok("no bold in hints", !document.querySelector(".r-hint b") && getComputedStyle(document.querySelector('.row[data-id="b1"] .h-act')).fontWeight !== "700");
  ok("arrow takes the action color", getComputedStyle(document.querySelector('.row[data-id="b1"] .r-hint svg')).color === getComputedStyle(document.querySelector('.row[data-id="b1"] .h-act')).color && getComputedStyle(document.querySelector('.row[data-id="b1"] .h-act')).color !== getComputedStyle(document.querySelector('.row[data-id="b2"] .h-act')).color);
  ok("hint that is only the action is all action", document.querySelector('.row[data-id="b1"] .r-hint .h-act').textContent === "Merge" && document.querySelector('.row[data-id="b1"] .r-hint > span').childNodes.length === 1);

  items([["pr-60", simple(60, "easy", 5, 1, { kind: "pr", hint: "Reply: drop `isMissingNodeACK` from it", story: "The `ZW0204` code stays.", state: "Merge after `yarn fmt` runs.", findings: [{ severity: "minor", text: "Use `foo()` here, then `bar", ref: "a.ts:1" }] })]]);
  await wait(10);
  openDetail("pr-60"); await wait(5);
  const codes = (sel) => [...document.querySelectorAll(sel + " code.ic")].map((c) => c.textContent);
  ok("backtick spans render as inline code", codes("#d-story").join() === "ZW0204" && codes("#d-verdict").join() === "yarn fmt" && codes(".findings .f-text").join() === "foo()" && /then `bar$/.test(document.querySelector(".findings .f-text").textContent) && codes('.row[data-id="pr-60"] .r-hint').join() === "isMissingNodeACK");
  ok("finding reference sits on its own line below the text", document.querySelector(".findings .fref").getBoundingClientRect().top > document.querySelector(".findings .f-text").getBoundingClientRect().top);
  document.getElementById("d-close").click(); await wait(5);