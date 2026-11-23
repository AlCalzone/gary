  // ---------- round 23 ----------
  // The link of a fix PR to the issue an escalated discussion became: a timeline line, and no work of the maintainer's
  {
    const dlg = document.getElementById("detail");
    const at = iso(60000);
    const spentBefore = (items([]), actions([]), await wait(10), spentText());
    const route = [{ id: "r1", type: "merge", as: "me", actor: "me", title: "Merge", recommended: true, draftHash: "h1" }];
    items([["pr-2301", { kind: "pr", number: 2301, title: "Fix the LED", url: "https://github.com/acme/widgets/pull/2301", author: "widgets-bot", authorType: "bot", category: "land", effortMinutes: 5, priority: 1, updatedAt: at, reviewDepth: "full", state: "Ready.", routes: route,
      fixFor: { itemId: "issue-2300", ref: "acme/widgets#2300" },
      since: { anchor: { at: iso(120000), kind: "opened" }, groups: [{ at, kind: "linked", icon: "link", text: "Linked the fix PR to #2300" }] } }]]);
    const link = (itemId) => [itemId + "-linked", { instance: "widgets", itemId, action: "link_issue", params: { by: "fix", pr: 2301, issue: 2300 }, status: "done", createdAt: at, finishedAt: at, result: "" }];
    actions([link("pr-2301"), link("issue-2300")]);
    await wait(10);
    ok("link: the code's link counts no minutes as spent", spentText() === spentBefore);
    ok("link: the row does not call it finished work", !/Done: link/.test(document.querySelector('.row[data-id="pr-2301"]')?.innerHTML ?? "missing"));
    openDetail("pr-2301"); await wait(10);
    ok("link: the timeline says it, with its icon", document.querySelector("#d-since .s-text")?.textContent === "Linked the fix PR to #2300" && !!document.querySelector("#d-since .s-dot svg"));
    ok("link: the PR points at the issue", /Fix for acme\/widgets#2300/.test(document.getElementById("d-fix-for").textContent));
    ok("link: the dialog names it once", dlg.textContent.split("Linked the fix PR").length === 2);
    if (dlg.open) { document.getElementById("d-close").click(); await wait(5); }
    actions([]); items([]); await wait(5);
  }
