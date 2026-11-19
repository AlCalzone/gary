  // ---------- round 11 ----------
  // The sensitive files banner in its three states: nothing pushes, only an API edit pushes, and a PR that is ours alone
  {
    const base = "https://github.com/acme/widgets";
    const common = { author: "someone", authorType: "contributor", section: "review", effortMinutes: 5, priority: 1, updatedAt: iso(1000), reviewDepth: "full", kind: "pr" };
    const files = [".github/bot-scripts/escalate.cjs"];
    const review = { id: "r1", type: "review", as: "bot", actor: "bot", title: "Request changes: the script", text: "The script fails.", params: { event: "request_changes" }, recommended: true, draftHash: "h1" };
    const api = { id: "r1", type: "take_over", as: "bot", actor: "bot", title: "Take over: fix the link", recommended: true, draftHash: "h1",
      params: { via: "api", message: "docs: fix the link", edits: [{ path: "CONTRIBUTING.md", original: "old", replacement: "new" }] } };
    const change = { id: "r1", type: "revise", as: "agent", actor: "agent", title: "Change: handle the empty body", text: "Return early when the body is empty.", recommended: true, draftHash: "h1" };
    const r11 = [
      ["pr-9961", { ...common, number: 9961, title: "A contributor's workflow change", url: base + "/pull/9961", sensitive: { files, total: 1 }, routes: [review] }],
      ["pr-9962", { ...common, number: 9962, title: "A contributor's docs change", url: base + "/pull/9962", sensitive: { files, total: 1 }, routes: [api] }],
      ["pr-9963", { ...common, number: 9963, title: "Fix the escalate script", url: base + "/pull/9963", author: "widgets-bot", authorType: "bot", sensitive: { files: [...files, "package.json"], total: 4, ours: true }, routes: [change] }],
    ];
    const rowOf = (id) => document.querySelector('.row[data-id="' + id + '"]');
    const banner = () => document.getElementById("d-sensitive");
    const label = (id) => [...rowOf(id).querySelectorAll(".r-meta svg")].map((s) => s.getAttribute("aria-label") ?? "").find((l) => /sensitive/.test(l)) ?? "";
    const badge = () => [...document.querySelectorAll("#d-meta .sbadge.tone-warn")].some((b) => b.textContent === "Sensitive files");
    const RISK = " These files can change what agents do or run code with repo secrets.";
    items(r11); await wait(10);
    await openAll();

    await openItem("pr-9961");
    ok("sensitive banner: without a pushing route it says that Gary does not push", banner().textContent === "Touches sensitive files: .github/bot-scripts/escalate.cjs. Gary does not push to this PR. It gets no take-over, no change and no format run." + RISK && badge(), banner().textContent);
    document.getElementById("d-close").click(); await wait(5);

    await openItem("pr-9962");
    ok("sensitive banner: with an API edit it says that only the shown edits are committed", banner().textContent === "Touches sensitive files: .github/bot-scripts/escalate.cjs. Gary only commits the text edits shown below, outside these files. It checks out nothing and runs nothing from this PR." + RISK && badge(), banner().textContent);
    document.getElementById("d-close").click(); await wait(5);

    await openItem("pr-9963");
    ok("sensitive banner: on a PR that is ours alone it says that agents may push", !banner().hidden && banner().textContent === "Touches sensitive files: .github/bot-scripts/escalate.cjs, package.json and 2 more. Only you and Gary have committed to this PR. Agents may push to it. Read the changes to these files with care." + RISK, banner().textContent);
    ok("sensitive banner: it never says that Gary does not push there", !/does not push|no take-over|only commits/.test(banner().textContent));
    ok("sensitive banner: the files stay named as code and the meta row keeps its tag", [...banner().querySelectorAll("code")].map((c) => c.textContent).join() === ".github/bot-scripts/escalate.cjs,package.json" && badge());
    ok("sensitive banner: the change card of a PR that is ours alone is a normal agent card", !!cardBtn("Change", cards()[0]) && !cards()[0].querySelector(".edit-list"));
    document.getElementById("d-close").click(); await wait(5);

    ok("sensitive banner: the row icon stays and its tooltip follows the state", label("pr-9963") === "Touches sensitive files: .github/bot-scripts/escalate.cjs, package.json and 2 more. Only you and Gary have committed to this PR. Agents may push to it." && /Gary does not push to this PR\.$/.test(label("pr-9961")) && /Gary only commits the text edits shown below, outside these files\.$/.test(label("pr-9962")), label("pr-9963"));
    items(F); await wait(5);
  }
