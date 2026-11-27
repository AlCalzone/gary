  // ---------- round 26 ----------
  // The local review in the dialog: per pass the reviewers, their findings and the agent's verdicts. Finding text is
  // untrusted review output and goes into the page as text only
  {
    const base = "https://github.com/acme/widgets";
    const dlg = document.getElementById("detail");
    const shut = async () => { if (dlg.open) { document.getElementById("d-close").click(); await wait(5); } };
    const evil = "<img src=x onerror=\"window.__lrInjected=1\"> drops the last entry";
    const localReview = { reviews: [
      { job: "old-1", base: "aaaaaaa", at: iso(90000), maxPasses: 2, passes: [{ n: 1, head: "bbbbbbb", reviewers: [{ key: "self", kind: "self", name: "Self review", status: "done", findings: [] }] }] },
      { job: "pr-2601-1", base: "ccccccc", at: iso(5000), maxPasses: 2, passes: [
        { n: 1, head: "ddddddd", fixedIn: "eeeeeee", reviewers: [
          { key: "self", kind: "self", name: "Self review", status: "done", findings: [{ path: "src/a.js", line: 12, body: evil, verdict: "valid" }, { path: null, line: null, body: "Rename the flag.", verdict: "optional", note: "Taste, left as is." }] },
          { key: "cli:octo-review", kind: "cli", name: "octo-review", status: "failed", reason: "timed out after 600 s", findings: [] },
          { key: "agent:codex/o4", kind: "agent", name: "codex o4", status: "skipped", reason: "workers reach only claude", findings: [] },
        ] },
        { n: 2, head: "eeeeeee", reviewers: [{ key: "self", kind: "self", name: "Self review", status: "done", findings: [{ path: "src/a.js", line: 14, body: "Off by one again.", verdict: "wrong", note: "The loop is inclusive." }] }] },
      ] },
    ] };
    const common = { kind: "pr", author: "widgets-bot", authorType: "bot", category: "land", effortMinutes: 5, priority: 1, updatedAt: iso(1000), reviewDepth: "full", reviewedAt: iso(2000), reviewedSha: "e".repeat(40), state: "Ready to merge." };
    items([
      ["pr-2601", { ...common, number: 2601, title: "Fix the send loop", url: base + "/pull/2601", hint: "Merge", routes: [{ id: "r1", type: "merge", as: "me", actor: "me", title: "Merge", recommended: true, draftHash: "h26" }], localReview }],
      ["pr-2602", { ...common, number: 2602, title: "No local review", url: base + "/pull/2602", hint: "Merge", routes: [{ id: "r1", type: "merge", as: "me", actor: "me", title: "Merge", recommended: true, draftHash: "h27" }] }],
    ]);
    await wait(10);
    await openAll();
    openDetail("pr-2601"); await wait(10);
    const sec = document.getElementById("d-local");
    const passes = [...sec.querySelectorAll(":scope > ol > li.lr-pass")];
    ok("local review: the dialog shows the newest review's passes", !sec.hidden && passes.length === 2 && /^Pass 1 of 2 on ddddddd, fixed in eeeeeee$/.test(passes[0].querySelector(".round-n").textContent) && passes[1].querySelector(".round-n").textContent === "Pass 2 of 2 on eeeeeee", sec.innerHTML.slice(0, 400));
    ok("local review: it says nothing of it went to GitHub", /Nothing of it went to GitHub/.test(sec.querySelector(".card-label").textContent));
    const who = [...passes[0].querySelectorAll(".lr-reviewer")].map((li) => li.querySelector(".lr-who").textContent + li.querySelector(".lr-status").textContent);
    ok("local review: each reviewer shows with its result and reason", who.join("|") === "Self review · 2 findings|octo-review · failed: timed out after 600 s|codex o4 · skipped: workers reach only claude", who);
    const first = passes[0].querySelector(".lr-finding");
    ok("local review: a finding shows its verdict, place and text", first.querySelector(".vlabel").textContent === "valid, fixed" && first.querySelector(".vlabel").classList.contains("v-valid") && first.querySelector("code").textContent === "src/a.js:12" && first.querySelector(".lr-body").textContent === evil);
    ok("local review: finding text stays text", !sec.querySelector("img") && !window.__lrInjected);
    const second = passes[0].querySelectorAll(".lr-finding")[1];
    ok("local review: a finding without a place shows no place, and the agent's note follows", !second.querySelector("code") && second.querySelector(".vlabel").textContent === "optional" && second.querySelector(".t-note").textContent === " · Taste, left as is.");
    ok("local review: a wrong verdict shows as wrong", passes[1].querySelector(".lr-finding .vlabel").textContent === "wrong" && passes[1].querySelector(".lr-finding .vlabel").classList.contains("v-wrong"));
    const older = sec.querySelector("details.lr-older");
    ok("local review: earlier reviews fold away", !!older && !older.open && older.querySelector("summary").textContent === "1 earlier local review" && older.querySelectorAll(".lr-pass").length === 1);
    await shut();
    openDetail("pr-2602"); await wait(10);
    ok("local review: an item without a record shows no section", document.getElementById("d-local").hidden && !document.getElementById("d-local").children.length);
    await shut();
    items([]); await wait(5);
  }
