  // ---------- round 9 ----------
  // The API edit: a take_over or revise card that shows its text edits as diffs and commits them through the server
  {
    const base = "https://github.com/acme/widgets";
    const common = { author: "someone", authorType: "contributor", section: "review", effortMinutes: 5, priority: 1, updatedAt: iso(1000), reviewDepth: "full", kind: "pr" };
    const sensitive = { files: [".github/copilot-instructions.md"], total: 1 };
    const edit = { path: "CONTRIBUTING.md", original: "Join us on Discord: https://discord.gg/wrong", replacement: "Join us on Discord: https://discord.gg/right" };
    const api = (extra = {}, params = {}) => ({ id: "r1", type: "take_over", as: "bot", actor: "bot", title: "Take over: fix the Discord link", params: { via: "api", message: "docs: fix the Discord invite link", edits: [edit], ...params }, recommended: true, draftHash: "h1", ...extra });
    const review = { id: "r2", type: "review", as: "bot", actor: "bot", title: "Request changes: the Discord link", text: "The link is wrong.", params: { event: "request_changes" }, draftHash: "h2" };
    const two = [edit, { path: "docs/guide.md", original: "See the old page.\nIt moved.", replacement: "See the new page." }];
    const r9 = [
      ["pr-9901", { ...common, number: 9901, title: "Update the agent instructions", url: base + "/pull/9901", sensitive, routes: [api({ text: "Is the old server gone for good?" }), review],
        threads: [{ id: "PRRT_1", author: "octocat", path: "CONTRIBUTING.md", line: 3, url: base + "/pull/9901#discussion_r1", summary: "The link is wrong.", verdict: "valid", note: "It is." }] }],
      ["pr-9902", { ...common, number: 9902, title: "Our own workflow docs", url: base + "/pull/9902", authorType: "maintainer", sensitive: { files: [".github/workflows/ci.yml", "package.json"], total: 3 },
        routes: [api({ type: "revise", actor: "own", title: "Change: fix two links" }, { edits: two })] }],
      ["pr-9903", { ...common, number: 9903, title: "Only a review is left", url: base + "/pull/9903", sensitive, routes: [{ ...review, id: "r1", recommended: true, draftHash: "h1" }] }],
    ];
    const rowOf = (id) => document.querySelector('.row[data-id="' + id + '"]');
    const banner = () => document.getElementById("d-sensitive");
    const label = (id) => [...rowOf(id).querySelectorAll(".r-meta svg")].map((s) => s.getAttribute("aria-label") ?? "").find((l) => /sensitive/.test(l)) ?? "";
    items(r9); await wait(10);
    await openAll();
    ok("api edit: the row's warning says what Gary commits", label("pr-9901") === "Touches sensitive files: .github/copilot-instructions.md. Gary only commits the text edits shown below, outside these files." && /Gary does not push to this PR\.$/.test(label("pr-9903")));

    await openItem("pr-9901");
    const card = () => cards()[0];
    ok("api edit: the banner says that only the shown edits are committed", banner().textContent === "Touches sensitive files: .github/copilot-instructions.md. Gary only commits the text edits shown below, outside these files. It checks out nothing and runs nothing from this PR. These files can change what agents do or run code with repo secrets." && !/no take-over/.test(banner().textContent));
    const hunk = () => [...card().querySelectorAll(".edit-list li")].map((li) => ({ path: li.querySelector(".c-where")?.textContent, rows: [...li.querySelectorAll(".hunk span")].map((s) => [s.className, s.textContent]) }));
    ok("api edit: the card shows the edit as a diff with its path", hunk().length === 1 && hunk()[0].path === "CONTRIBUTING.md" && JSON.stringify(hunk()[0].rows) === JSON.stringify([["h-del", "-" + edit.original + "\n"], ["h-add", "+" + edit.replacement + "\n"]]), hunk());
    ok("api edit: the card says how it commits", card().querySelector(".edit-how")?.textContent === "Commits through the GitHub API, without checking out the branch" && card().querySelector(".edit-message")?.textContent === "Commit message: docs: fix the Discord invite link");
    ok("api edit: the card has no thread switches and the note is optional", !card().querySelector(".decisions") && /Note for the contributor/.test(card().querySelector(".card-label")?.textContent ?? "") && card().querySelector("textarea")?.value === "Is the old server gone for good?");
    ok("api edit: the button commits as the bot", cardBtn("Commit the text edit", card()) && avatarOf(cardBtn("Commit the text edit", card()), "widgets-bot") && !cardBtn("Take over", card()));
    ok("api edit: the review stays as the alternative", cards().length === 2 && /Request changes/.test(cards()[1].textContent));
    let n = __calls.length;
    cardBtn("Commit the text edit", card()).click(); await wait(10);
    ok("api edit: the first click only asks to confirm", __calls.length === n && !!cardBtn("Confirm: commit to the contributor's PR as widgets-bot", card()));
    window.__reply = () => ({ ok: true, result: base + "/pull/9901/commits/abc" });
    cardBtn("Confirm: commit to the contributor's PR as widgets-bot", card()).click(); await wait(20);
    const call = __calls.at(-1);
    ok("api edit: the confirm sends the route with the note and no decisions", __calls.length === n + 1 && call.tool === "take_over" && call.itemId === "pr-9901" && call.routeId === "r1" && call.text === "Is the old server gone for good?" && call.draftHash === "h1" && JSON.stringify(call.input) === "{}", call);
    ok("api edit: the card collapses with Done", card().querySelector(".card-top > .head-done")?.textContent === "Done" && card().classList.contains("settled"));
    items(r9.map((e) => (e[0] === "pr-9901" ? [e[0], { ...e[1], routes: [api({ text: "Is the old server gone for good?", done: { status: "done", result: base + "/pull/9901/commits/abc" } }), review] }] : e))); await wait(10);
    ok("api edit: the served result links the commit", card().querySelector(".card-top > .head-done a")?.href === base + "/pull/9901/commits/abc", card().querySelector(".card-top > .head-done")?.outerHTML);

    await openItem("pr-9902");
    ok("api edit: a change card shows every edit, also one that shortens the text", hunk().length === 2 && hunk()[1].path === "docs/guide.md" && hunk()[1].rows.map((r) => r[0]).join() === "h-del,h-del,h-add");
    ok("api edit: in own mode the button names the maintainer's login", !!cardBtn("Commit the text edits", card()) && avatarOf(cardBtn("Commit the text edits", card()), "octocat") && !cardBtn("Change", card()));
    ok("api edit: a PR we control gets the same banner", /package\.json and 1 more\. Gary only commits the text edits shown below, outside these files\./.test(banner().textContent));
    cardBtn("Commit the text edits", card()).click(); await wait(10);
    ok("api edit: a change needs no note to confirm", !!cardBtn("Confirm: commit to the PR as you", card()));
    document.getElementById("d-close").click(); await wait(5);

    await openItem("pr-9903");
    ok("api edit: without such a route the banner keeps saying that Gary does not push", /Gary does not push to this PR\. It gets no take-over, no change and no format run\./.test(banner().textContent));
    document.getElementById("d-close").click(); await wait(5);
    window.__reply = () => ({ ok: true, result: { dryRun: true } });
    items(F); await wait(5);
  }
