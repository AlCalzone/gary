  // ---------- round 19 ----------
  // Categories, due dates, the hardware flag and series
  {
    const base19 = "https://github.com/acme/widgets";
    const day19 = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); };
    const shortDate = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toLocaleDateString(undefined, { month: "short", day: "numeric" }); };
    const route19 = [{ id: "r1", type: "reply", as: "me", title: "Reply: thanks", text: "Thanks", recommended: true, draftHash: "h1" }];
    const it = (n, extra) => ["issue-" + n, { kind: "issue", number: n, title: "Item " + n, url: base19 + "/issues/" + n, author: "someone", authorType: "contributor", category: "unblock", effortMinutes: 5, priority: 1, updatedAt: iso(n * 1000), reviewDepth: "full", routes: route19, ...extra }];
    const rowsOf = (g) => [...document.querySelectorAll("#group-" + g + " .row")].map((r) => r.dataset.id);
    const flag = (id, cls) => document.querySelector('.row[data-id="' + id + '"] .r-flag.' + cls);
    const openGroups = async () => { for (let i = 0; i < 4; i++) { for (const b of document.querySelectorAll(".show-all")) if (!b.hidden && !/less/i.test(b.textContent)) b.click(); await wait(2); } };

    // Due chips
    items([it(1901, { category: "act", dueAt: day19(1), dueSource: "milestone 2026.12" }), it(1902, { category: "act", dueAt: day19(-2), dueSource: 'project "Roadmap" · Target date' }),
      it(1903, { category: "act", dueAt: day19(0), dueSource: "milestone 2026.12" }), it(1904, { category: "act", dueAt: day19(10), dueSource: "milestone 2027.1" }), it(1905, {})]);
    await wait(10); await openGroups();
    ok("due: a date in the next days reads due and the date, in the Act color", flag("issue-1901", "due")?.textContent === "due " + shortDate(1) && flag("issue-1901", "due").classList.contains("due-soon"), flag("issue-1901", "due")?.textContent);
    ok("due: an overdue item counts the days", flag("issue-1902", "due")?.textContent === "overdue 2 d" && flag("issue-1902", "due").classList.contains("overdue"));
    ok("due: today reads due today", flag("issue-1903", "due")?.textContent === "due today");
    ok("due: a later date is quiet", flag("issue-1904", "due")?.textContent === "due " + shortDate(10) && !flag("issue-1904", "due").classList.contains("due-soon") && !flag("issue-1904", "due").classList.contains("overdue"));
    ok("due: the tooltip names where GitHub has the date", /from project "Roadmap" · Target date$/.test(flag("issue-1902", "due").title), flag("issue-1902", "due").title);
    ok("due: an item without a due date has no chip", !flag("issue-1905", "due"));
    ok("due: overdue and due tomorrow are in Quick & Easy, overdue first, a date in 10 days is not", rowsOf("quick").join() === "issue-1902,issue-1903,issue-1901" && rowsOf("after")[0] === "issue-1904", rowsOf("quick").join() + "|" + rowsOf("after").join());

    // The hardware flag
    items([it(1911, { category: "decide", needsHardware: true }), it(1912, { category: "decide" })]);
    await wait(10); await openGroups();
    ok("hardware: the flag shows as a chip next to the Decide chip", flag("issue-1911", "hw")?.textContent === "hardware" && /real hardware/.test(flag("issue-1911", "hw").title)
      && document.querySelector('.row[data-id="issue-1911"] .cat').textContent === "Decide" && !flag("issue-1912", "hw"));

    // A contribution that needs a design decision: Decide, and in Afterwards while the contributor waits
    const design = (n, waitingOn) => ["pr-" + n, { kind: "pr", number: n, title: "Add a plugin API", url: base19 + "/pull/" + n, author: "someone", authorType: "contributor", category: "decide", waitingOn, effortMinutes: 15, priority: 1, updatedAt: iso(1000), reviewDepth: "full",
      state: "Decide whether the driver should get a plugin API before a code review.", routes: [{ id: "r1", type: "reply", as: "me", title: "Decide: accept the plugin API direction", text: "Yes, go ahead.", recommended: true, draftHash: "h1" }] }];
    items([design(1921, "us"), design(1922, "them")]);
    await wait(10); await openGroups();
    ok("design decision: a contributor's PR that waits on us is Decide in Afterwards", rowsOf("after").includes("pr-1921") && document.querySelector('.row[data-id="pr-1921"] .cat').textContent === "Decide");
    ok("design decision: without anyone waiting it goes to When you have time", rowsOf("later").includes("pr-1922"));

    // Ranking: finished work he asked for, then due items, then outside contributors, then the lowest effort
    const sha = "c".repeat(40);
    items([it(1931, { effortMinutes: 5 }), it(1932, { effortMinutes: 30, category: "land", authorType: "maintainer", author: "octocat" }), it(1933, { effortMinutes: 60, category: "act", dueAt: day19(4), dueSource: "milestone 2026.12" }),
      it(1934, { effortMinutes: 10 }), ["pr-1935", { ...it(1935)[1], kind: "pr", url: base19 + "/pull/1935", authorType: "bot", author: "widgets-bot", category: "land", effortMinutes: 30, reviewedSha: sha, pushed: { action: "take_over", sha, at: iso(5000) }, routes: [{ id: "r1", type: "merge", as: "me", title: "Merge", recommended: true }] }]]);
    await wait(10); await openGroups();
    ok("ranking: finished asked-for work, then due, then contributors by effort, then his own: " + rowsOf("after").join(), rowsOf("after").join() === "pr-1935,issue-1933,issue-1931,issue-1934,issue-1932");

    // Series: the items sit together, in series order, at the place of the first unfinished one
    const s = (position) => ({ series: { id: "pr-1941", title: "Split the driver, part 1", position, size: 2 } });
    const pr = (n, extra) => ["pr-" + n, { ...it(n)[1], kind: "pr", url: base19 + "/pull/" + n, ...extra }];
    const stack = [pr(1941, { ...s(1), category: "land", authorType: "maintainer", author: "octocat", effortMinutes: 30 }), pr(1942, { ...s(2), effortMinutes: 5 }), it(1943, { effortMinutes: 10 })];
    items(stack);
    await wait(10); await openGroups();
    ok("series: each row says its place", flag("pr-1941", "series")?.textContent === "series 1/2" && flag("pr-1942", "series")?.textContent === "series 2/2" && /starts with “Split the driver, part 1”/.test(flag("pr-1942", "series").title));
    ok("series: a stacked pair sits together at the rank of its first item: " + rowsOf("after").join(), rowsOf("after").join() === "issue-1943,pr-1941,pr-1942");
    items(stack.map(([k, d]) => [k, k === "pr-1941" ? { ...d, handled: { at: new Date().toISOString(), routeId: "r1", routeType: "reply", verified: null } } : d]));
    await wait(10); await openGroups();
    ok("series: once the first is done, the series ranks by the next unfinished item: " + rowsOf("after").join(), rowsOf("after").join() === "pr-1942,issue-1943");
    items([pr(1951, { effortMinutes: 30 }), pr(1952, { effortMinutes: 5 }), it(1953, { effortMinutes: 10 })]);
    await wait(10); await openGroups();
    ok("series: an unrelated pair keeps the normal ranking and has no chip", rowsOf("after").join() === "pr-1952,issue-1953,pr-1951" && !flag("pr-1951", "series") && !flag("pr-1952", "series"));

    // The category colors are a soft tint behind a strong ink
    const chip = document.querySelector('.row[data-id="pr-1952"] .cat');
    ok("colors: the Unblock chip has the tint and the ink of its category", getComputedStyle(chip).backgroundColor === getComputedStyle(document.documentElement).getPropertyValue("--cat-unblock").trim().replace(/^#(..)(..)(..)$/, (_, r, g, b) => "rgb(" + [r, g, b].map((x) => parseInt(x, 16)).join(", ") + ")"), getComputedStyle(chip).backgroundColor);
    items(F); await wait(10);
    localHandled.clear();
  }
