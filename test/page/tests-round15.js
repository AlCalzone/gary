  // ---------- round 15 ----------
  // A bot PR outside Gary: the session that opened it, its resume command, and what the pushing cards say about it
  {
    const base = "https://github.com/acme/widgets";
    const common = { author: "widgets-bot", authorType: "bot", section: "review", effortMinutes: 5, priority: 1, updatedAt: iso(1000), reviewDepth: "full", kind: "pr" };
    const SID = "9d269cae-776d-486e-9ca4-fd92ef5921be";
    const RESUME = "cd ~/repositories/widgets/master && claude --resume " + SID;
    const started = "2026-11-16T19:44:51.795Z";
    const quiet = iso(3 * 3600000);
    const active = iso(5 * 60000);
    const origin = (lastActiveAt) => ({ found: true, sessionId: SID, dir: "~/repositories/widgets/master", resume: RESUME, startedAt: started, lastActiveAt, prompt: "Look into why the LED stays red after a restore." });
    const routes = [
      { id: "r1", type: "revise", as: "agent", actor: "agent", title: "Change: handle the empty body", text: "Return early when the body is empty.", recommended: true, draftHash: "h1" },
      { id: "r2", type: "take_over", as: "agent", actor: "agent", title: "Take over: finish it", params: { mode: "push" }, draftHash: "h2" },
      { id: "r3", type: "address_review", as: "agent", actor: "agent", title: "Address review: the two comments", text: "", draftHash: "h3" },
      { id: "r4", type: "drive", as: "agent", actor: "agent", title: "Drive: the review rounds", params: { maxRounds: 3 }, draftHash: "h4" },
    ];
    const pr = (n, extra) => [`pr-${n}`, { ...common, number: n, title: "PR " + n, url: base + "/pull/" + n, routes, ...extra }];
    const r15 = [pr(9971, { origin: origin(quiet) }), pr(9972, { origin: origin(active) }), pr(9973, { origin: { found: false } }), pr(9974, { author: "someone", authorType: "contributor" })];
    const day = (t) => new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
    const time = (t) => new Date(t).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    const box = () => document.getElementById("d-origin");
    const notes = (card) => [...card.querySelectorAll(".origin-note")].map((e) => e.textContent);
    const warns = (card) => [...card.querySelectorAll(".origin-warn")].map((e) => e.textContent);
    const KNOWN = "The agent continues the PR that the Claude Code session in ~/repositories/widgets/master started. It pushes on top of that session's commits.";
    items(r15); await wait(10);
    await openAll();

    await openItem("pr-9971");
    ok("origin: the dialog names the session's directory, its start and its last activity", !box().hidden && box().querySelector(".origin-line")?.textContent === "Opened by a Claude Code session in ~/repositories/widgets/master on " + day(started) + ", last active " + day(quiet) + ", " + time(quiet) + ".", box().textContent);
    ok("origin: the session details start folded behind one line", box().querySelector("details") && !box().querySelector("details").open && box().querySelector("summary")?.textContent === "Opened by a local Claude Code session", box().querySelector("summary")?.textContent);
    ok("origin: the dialog shows the first prompt", box().querySelector(".origin-prompt")?.textContent === "It started with: Look into why the LED stays red after a restore.");
    ok("origin: the resume command runs in the session's directory", box().querySelector(".origin-cmd")?.textContent === RESUME);
    window.__clip = null;
    [...box().querySelectorAll("button")].find((b) => b.textContent === "Copy")?.click(); await wait(5);
    ok("origin: the copy button copies the resume command", window.__clip === RESUME && box().querySelector(".origin-copied")?.textContent === "Copied", window.__clip);
    const types = [];
    for (let i = 0; i < cards().length; i++) {
      if (!cards()[i].classList.contains("open")) await expand(i);
      types.push(notes(cards()[i]).join("|") === KNOWN && warns(cards()[i]).length === 0);
    }
    ok("origin: Change, Take over, Address review and Drive each say that the agent continues the session's PR", types.length === 4 && types.every(Boolean), types);
    ok("origin: the Change card still starts its push line with who commits", /^Commits as widgets-bot\./.test(cards()[0].querySelector(".card-actions .quiet-line")?.textContent ?? ""));

    await openItem("pr-9972");
    const warned = [];
    for (let i = 0; i < cards().length; i++) {
      if (!cards()[i].classList.contains("open")) await expand(i);
      warned.push(warns(cards()[i]).join("|"));
    }
    ok("origin: while the session was active in the last 30 minutes, each pushing card warns about its next push", warned.length === 4 && warned.every((w) => w === "That session was active at " + time(active) + " and may still be working. Its next push could conflict with the agent's."), warned);

    await openItem("pr-9973");
    ok("origin: a bot PR without a found session says so", !box().hidden && box().textContent === "Opened by widgets-bot outside Gary. No local session found." && !box().querySelector("code"), box().textContent);
    ok("origin: its Change card says that the agent continues a PR from outside Gary", notes(cards()[0]).join("|") === "The agent continues a PR that widgets-bot opened outside Gary. It pushes on top of its commits." && warns(cards()[0]).length === 0, notes(cards()[0]));

    await openItem("pr-9974");
    ok("origin: a PR without an origin shows no origin line and no note", box().hidden && notes(cards()[0]).length === 0);
    document.getElementById("d-close").click(); await wait(5);
    items(F); await wait(5);
  }
