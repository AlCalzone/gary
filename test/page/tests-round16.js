  // ---------- round 16 ----------
  // The timeline of what happened since the maintainer's last choice, at the top of the dialog
  {
    const base = "https://github.com/acme/widgets";
    const common = { kind: "pr", author: "someone", authorType: "contributor", section: "review", effortMinutes: 5, priority: 1, updatedAt: iso(1000), reviewDepth: "full",
      routes: [{ id: "r1", type: "merge", as: "me", actor: "me", title: "Merge", recommended: true, draftHash: "h1" }] };
    const at = "2026-11-19T10:00:00.000Z";
    const groups = [
      { at: "2026-11-19T11:00:00.000Z", kind: "commit", icon: "commit", text: "jpoeppelman1 pushed 8 commits" },
      { at: "2026-11-19T12:00:00.000Z", kind: "review", icon: "eye", text: "Copilot reviewed 3 times", note: "2 threads still open" },
      { at: "2026-11-19T15:00:00.000Z", kind: "commit", icon: "commit", text: "widgets-bot pushed 1 commit (Change)" },
      { at: "2026-11-19T16:00:00.000Z", kind: "labeled", text: "You added label bug" },
    ];
    const r16 = [
      ["pr-9971", { ...common, number: 9971, title: "Since a choice", url: base + "/pull/9971", since: { anchor: { at, kind: "choice", label: "Take over" }, groups } }],
      ["pr-9972", { ...common, number: 9972, title: "Nothing new", url: base + "/pull/9972", since: { anchor: { at, kind: "choice", label: "Take over" }, groups: [] } }],
      ["pr-9973", { ...common, number: 9973, title: "Since an open", url: base + "/pull/9973", seenAt: at, since: { anchor: { at, kind: "opened" }, groups: groups.slice(0, 1) } }],
      ["pr-9974", { ...common, number: 9974, title: "No anchor", url: base + "/pull/9974" }],
    ];
    items(r16); await wait(5);
    const box = () => document.getElementById("d-since");
    const close = async () => { document.getElementById("d-close").click(); await wait(5); };

    await openItem("pr-9971");
    const det = box().querySelector("details");
    ok("since: the heading names the day and the maintainer's choice", !box().hidden && det?.querySelector("summary").textContent === "Since your last choice, Nov 19 (Take over)", box().textContent);
    ok("since: open by default, one line per group with its callout", det.open && [...det.querySelectorAll("li")].map((li) => li.textContent).join("|") === "jpoeppelman1 pushed 8 commits|Copilot reviewed 3 times · 2 threads still open|widgets-bot pushed 1 commit (Change)|You added label bug", det.textContent);
    ok("since: icons where the page has them, a plain dot otherwise", [...det.querySelectorAll(".s-dot")].map((d) => d.childElementCount).join() === "1,1,1,0" && det.querySelector(".s-note").textContent === " · 2 threads still open");
    ok("since: it sits under the title and meta, before the story and the verdict", !!(document.getElementById("d-meta").compareDocumentPosition(box()) & Node.DOCUMENT_POSITION_FOLLOWING) && !!(box().compareDocumentPosition(document.getElementById("d-story")) & Node.DOCUMENT_POSITION_FOLLOWING));
    det.querySelector("summary").click(); await wait(5);
    ok("since: a click collapses it", !box().querySelector("details").open);
    items(r16.map(([k, d]) => [k, { ...d, since: d.since && { ...d.since } }])); await wait(5);
    ok("since: it stays collapsed when the item updates", !!box().querySelector("details") && !box().querySelector("details").open);
    const before = __writes.length;
    await close();
    const seen = __writes.slice(before).find((w) => w[1] === "items/widgets/pr-9971");
    ok("since: closing the dialog stores the time the maintainer opened it", seen?.[0] === "update" && Object.keys(seen[2]).join() === "seenAt" && Date.parse(seen[2].seenAt) <= Date.now() && Date.parse(seen[2].seenAt) > Date.now() - 60000, seen);
    await openItem("pr-9971");
    ok("since: open again on the next visit", box().querySelector("details").open);
    await close();

    await openItem("pr-9972");
    ok("since: nothing new is one quiet line", !box().hidden && !box().querySelector("details") && box().textContent === "Nothing new since your last choice on Nov 19.", box().textContent);
    await close();
    await openItem("pr-9973");
    ok("since: without a choice it names the first open", box().querySelector("summary")?.textContent === "Since you first opened it, Nov 19", box().textContent);
    const beforeAgain = __writes.length;
    await close();
    ok("since: closing an item that was opened before keeps its first open", !__writes.slice(beforeAgain).some((w) => w[1] === "items/widgets/pr-9973" && "seenAt" in (w[2] ?? {})), __writes.slice(beforeAgain));
    await openItem("pr-9974");
    ok("since: no anchor shows nothing", box().hidden && box().textContent === "");
    await close();
    items(F); await wait(5);
  }
