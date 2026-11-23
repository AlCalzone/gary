  // ---------- round 10 ----------
  // Setting proposals: a card built from numbers, which sets a config value on accept
  {
    const lb = document.getElementById("learn");
    const dlg = document.getElementById("learn-dialog");
    const pcards = () => [...dlg.querySelectorAll(".pcard")];
    const buttons = (c) => [...c.querySelectorAll(".card-actions button")].map((b) => b.textContent).join();
    const paras = (c) => [...c.querySelectorAll(".card-why")].map((p) => p.textContent);
    const shown = () => [...dlg.querySelectorAll(".d-bar .d-ref, .learn-group:not([hidden]), #learn-empty:not([hidden])")].map((e) => e.textContent).join(" ");
    const answers = { fast: { category: "decide", recommendedType: "follow_up" }, standard: { category: "decide", recommendedType: null } };
    const on = ["s-on", {
      kind: "setting", setting: { key: "fastTier", value: "on" }, title: "Use the faster model for obvious items",
      stats: { pairs: 130, handedUp: 76, answered: 54, sameCategory: 54, sameRouteType: 51 },
      differences: [
        { itemId: "issue-9471", number: 9471, url: "https://github.com/acme/widgets/issues/9471", runs: 3, ...answers },
        { itemId: "issue-9001", number: 9001, url: "https://github.com/acme/widgets/issues/9001", runs: 1, fast: { category: "land", recommendedType: "merge" }, standard: { category: "unblock", recommendedType: "merge" } },
        { itemId: "issue-gone", runs: 2, fast: { section: "easy", recommendedType: "Implement" }, standard: { section: "active", recommendedType: "request_logs" } },
      ],
      status: "open",
    }];
    const back = ["s-back", {
      kind: "setting", setting: { key: "fastTier", value: "shadow" }, title: "Go back to the standard model for all items",
      stats: { pairs: 40, handedUp: 0, answered: 40, sameSection: 30, sameRouteType: 30, recent: { answered: 40, sameSection: 30, needed: 38 }, overrides: { fast: { items: 20, changed: 8 }, standard: { items: 25, changed: 2 } } },
      reasons: ["agreement", "overrides"], differences: [], status: "open",
    }];
    const P = window.makeProposalFixtures(iso);
    learn.gone.clear(); learn.known.clear(); learn.added.clear();

    window.__subs["proposals"](__mkSnap([on])); await wait(10);
    ok("setting: the lightbulb counts it as a suggestion", !lb.hidden && lb.textContent === "1" && lb.getAttribute("aria-label") === "1 suggestion" && lb.title === "1 suggestion");
    lb.click(); await wait(10);
    const card = () => pcards()[0];
    ok("setting only: the dialog has the settings group and no rules group", dlg.open && pcards().length === 1 && !document.getElementById("learn-settings").hidden && document.getElementById("learn-rules").hidden);
    ok("setting only: heading and intro do not talk about the maintainer's decisions or rules", document.getElementById("learn-settings-title").textContent === "A setting Gary would change"
      && document.getElementById("learn-settings-intro").textContent === "Gary measured this itself. Nothing changes until you click." && !/decision|decided|rule/i.test(shown()), shown());
    ok("setting: the card has the plain title", card().querySelector(".p-title").textContent === "Use the faster model for obvious items");
    ok("setting: the first paragraph says what was measured, with the numbers", paras(card())[0] === "For a while, a faster and cheaper model sorted the same items as the standard model. Its answers were not used. "
      + "Gary compared their answers 130 times. The faster model passed 76 of these on as too hard. In the other 54 it chose the same board category every time and the same kind of card 51 times.", paras(card())[0]);
    ok("setting: the second paragraph says what changes", paras(card())[1] === "If you turn this on, the faster model sorts the obvious items and passes the rest on to the standard model. Runs get faster and cheaper. "
      + "The faster model never drafts text for GitHub, never judges code and never suggests closing an item. Full reviews stay as they are.", paras(card())[1]);
    ok("setting: the third paragraph says that Gary keeps checking", paras(card()).length === 3 && paras(card())[2] === "Gary keeps checking some of its answers against the standard model and suggests switching back when the two disagree too often.", paras(card())[2]);
    ok("setting: no rule text, no target line and no decision count", !card().querySelector("textarea") && !card().querySelector("details") && !/Adds to|Based on|Rule/.test(card().textContent));
    const diffs = () => [...card().querySelectorAll(".diffs li")];
    ok("setting: the differences sit under their own label, one line per item", [...card().querySelectorAll(".card-label")].map((l) => l.textContent).join() === "Where they differed" && diffs().length === 3);
    ok("setting: a difference names the item, its runs and both kinds of card", diffs()[0].textContent === "#9471, in 3 runs: faster model: Implement card. Standard model: no card.", diffs()[0].textContent);
    ok("setting: equal cards in different board categories show the categories", diffs()[1].textContent === "#9001, in 1 run: faster model: board category “Land”. Standard model: board category “Unblock”.", diffs()[1].textContent);
    ok("setting: a difference written before categories names the old sections, and an unknown kind of card keeps its words", diffs()[2].textContent === "issue-gone, in 2 runs: faster model: Implement card, board section “Easy wins”. Standard model: Ask for a log card, board section “Active communication”.", diffs()[2].textContent);
    ok("setting: an item on the board is a button, one off the board a GitHub link, one without a URL plain", diffs()[0].querySelector("button.ev-link")?.textContent === "#9471"
      && diffs()[1].querySelector("a.ev-ref")?.href === "https://github.com/acme/widgets/issues/9001" && diffs()[2].querySelector("span.ev-ref")?.textContent === "issue-gone");
    ok("setting: the buttons are Turn it on and Not now", buttons(card()) === "Turn it on,Not now" && card().querySelector(".card-actions .btn").classList.contains("primary"));
    ok("setting: the card avoids the internal words", !/shadow|tier|pairs|handed up|route type/i.test(card().textContent) && (card().textContent.match(/section/g) ?? []).length === (card().textContent.match(/board section/g) ?? []).length, card().textContent);

    let calls = __calls.length;
    window.__reply = () => ({ ok: true, result: "/home/x/config.json", setting: { key: "fastTier", value: "on" }, changed: true });
    card().querySelector(".card-actions button").click(); await wait(20);
    ok("setting: Turn it on sends accept_proposal without a text", __calls.length === calls + 1 && __calls.at(-1).tool === "accept_proposal" && __calls.at(-1).proposalId === "s-on" && __calls.at(-1).text === undefined);
    ok("setting: one line then says what was set and where", card().querySelector(".card-actions").textContent === "Set fastTier: \"on\" in the instance config" && !card().querySelector(".card-actions button") && lb.hidden, card().querySelector(".card-actions").textContent);
    document.getElementById("learn-close").click(); await wait(10);
    window.__subs["proposals"](__mkSnap([])); await wait(5);

    // The config already had the value
    learn.gone.clear(); learn.known.clear(); learn.added.clear();
    window.__subs["proposals"](__mkSnap([on])); await wait(10);
    lb.click(); await wait(10);
    window.__reply = () => ({ ok: true, result: "/home/x/config.json", setting: { key: "fastTier", value: "on" }, changed: false, note: "fastTier was already \"on\"" });
    card().querySelector(".card-actions button").click(); await wait(20);
    ok("setting: a value that was already set is said as such", card().querySelector(".card-actions").textContent === "The instance config already had fastTier: \"on\"", card().querySelector(".card-actions").textContent);
    document.getElementById("learn-close").click(); await wait(10);

    // Switching back, next to rule proposals
    learn.gone.clear(); learn.known.clear(); learn.added.clear();
    window.__reply = () => ({ ok: true, result: "Proposal dismissed." });
    window.__subs["proposals"](__mkSnap([...P, back])); await wait(10);
    ok("mixed: the lightbulb counts both kinds", lb.textContent === "3" && lb.getAttribute("aria-label") === "3 suggestions");
    lb.click(); await wait(10);
    ok("mixed: both groups show, each with its own heading, the setting first", !document.getElementById("learn-settings").hidden && !document.getElementById("learn-rules").hidden && pcards().length === 3
      && pcards()[0].closest("#learn-settings") && pcards()[1].closest("#learn-rules") && document.getElementById("learn-rules-title").textContent === "What your decisions suggest");
    ok("mixed: the rule cards keep their text field and buttons", !!pcards()[1].querySelector("textarea") && buttons(pcards()[1]) === "Add rule,Not this" && /Adds to rules\/classification\.md/.test(pcards()[1].textContent));
    ok("switch back: title and buttons", card().querySelector(".p-title").textContent === "Go back to the standard model for all items" && buttons(card()) === "Switch back,Not now");
    ok("switch back: the reasons carry their numbers", paras(card()).length === 4 && paras(card())[0] === "The faster model sorts the obvious items at the moment. Gary checks some of its answers against the standard model."
      && paras(card())[1] === "In the last 40 checks the faster model chose the same board category as the standard model 30 times. Gary expects at least 38."
      && paras(card())[2] === "You dismissed, replaced or rewrote Gary's suggestion on 8 of 20 items the faster model sorted (40 %). On items the standard model sorted it was 2 of 25 (8 %).", paras(card()));
    ok("switch back: the last paragraph says what changes", paras(card())[3] === "If you switch back, the standard model sorts every item again. The faster model keeps running next to it and its answers are not used. Gary suggests turning it on again when the two agree often enough.", paras(card())[3]);
    ok("switch back: without differences the label stays away", !card().querySelector(".diffs") && !card().querySelector(".card-label"));
    card().querySelectorAll(".card-actions button")[1].click(); await wait(5);
    const why = card().querySelector(".dismiss-box input");
    why.value = "One bad day"; why.dispatchEvent(new Event("input"));
    calls = __calls.length;
    card().querySelector(".dismiss-box button").click(); await wait(20);
    ok("setting: Not now sends dismiss_proposal with the reason", __calls.length === calls + 1 && __calls.at(-1).tool === "dismiss_proposal" && __calls.at(-1).proposalId === "s-back" && __calls.at(-1).text === "One bad day" && pcards().length === 2 && document.getElementById("learn-settings").hidden);
    document.getElementById("learn-close").click(); await wait(10);
    window.__subs["proposals"](__mkSnap([])); await wait(5);
    learn.gone.clear(); learn.known.clear(); learn.added.clear();
    window.__reply = () => ({ ok: true, result: { dryRun: true } });
  }
  // Editing the words of a review's inline comments
  {
    const base = "https://github.com/acme/widgets";
    const common = { author: "someone", authorType: "contributor", section: "review", effortMinutes: 5, priority: 1, updatedAt: iso(1000), reviewDepth: "full", kind: "pr" };
    const comments = [
      { id: "c1", path: "devices/a.json", line: 12, startLine: 10, text: "Metadata comments are for general information about the device.", original: "\"comments\": []", suggestion: "\"comments\": [{}]" },
      { id: "c2", path: "devices/a.json", line: 30, text: "Why this default?" },
    ];
    const review = (extra = {}) => ({ id: "r1", type: "review", as: "bot", actor: "bot", title: "Request changes: two notes", text: "Two notes.", params: { event: "comment", comments }, recommended: true, draftHash: "h1", ...extra });
    const list = (r = review()) => [
      ["pr-9951", { ...common, number: 9951, title: "Add a device", url: base + "/pull/9951", routes: [r] }],
      ["pr-9952", { ...common, number: 9952, title: "Add another device", url: base + "/pull/9952", routes: [review({ as: "me", actor: "me" })] }],
    ];
    const lis = () => [...openCard().querySelectorAll(".checklist li")];
    const editBtn = (i) => [...lis()[i].querySelectorAll("button.c-edit")].find((b) => b.textContent === "Edit");
    const resetBtn = (i) => [...lis()[i].querySelectorAll("button.c-edit")].find((b) => b.textContent === "Reset");
    const area = (i) => lis()[i].querySelector("textarea");
    const type = (i, text) => { area(i).value = text; area(i).dispatchEvent(new Event("input")); };
    const key = (i, k) => area(i).dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
    const stored = () => localStorage.getItem("gary:widgets:drafts") || "";
    items(list()); await wait(10);
    await openAll();

    await openItem("pr-9951");
    ok("comment edit: each inline comment has an Edit link with a pencil, named for its place", !!editBtn(0)?.querySelector("svg") && editBtn(0).getAttribute("aria-label") === "Edit the comment on devices/a.json:10-12"
      && editBtn(1).dataset.focusKey === "r:r1:c:c2:edit" && !resetBtn(0) && !lis()[0].querySelector(".c-edited"));
    editBtn(0).click(); await wait(5);
    ok("comment edit: Edit turns the text into a focused textarea with the same text", area(0)?.value === "Metadata comments are for general information about the device." && document.activeElement === area(0) && !lis()[0].querySelector(".c-text") && area(0).dataset.focusKey === "r:r1:c:c1:text");
    ok("comment edit: the suggestion, the place and the checkbox stay as they are", lis()[0].querySelectorAll(".hunk .h-add").length === 1 && lis()[0].querySelector(".c-where").textContent === "devices/a.json:10-12" && lis()[0].querySelector("input[type=checkbox]").checked && !lis()[0].querySelector(".hunk textarea"));
    type(0, "Please keep the metadata comments general.");
    [...lis()[0].querySelectorAll("button")].find((b) => b.textContent === "Done").click(); await wait(5);
    ok("comment edit: Done shows the new text as a paragraph, marked as edited, with Reset", !area(0) && lis()[0].querySelector(".c-text").textContent === "Please keep the metadata comments general." && lis()[0].querySelector(".c-edited")?.textContent === "edited" && !!resetBtn(0) && document.activeElement === editBtn(0));
    ok("comment edit: the edit is saved like a draft, under the comment and the draft hash", JSON.parse(stored())["pr-9951|r1#c:c1|h1"] === "Please keep the metadata comments general.", stored());

    editBtn(0).click(); await wait(5);
    type(0, "Typed and thrown away");
    const stays = !key(0, "Escape"); await wait(5);
    ok("comment edit: Escape cancels the current edit and keeps the dialog open", stays && dlgR.open && !area(0) && lis()[0].querySelector(".c-text").textContent === "Please keep the metadata comments general." && JSON.parse(stored())["pr-9951|r1#c:c1|h1"] === "Please keep the metadata comments general.");

    editBtn(1).click(); await wait(5);
    type(1, "Why 5 as the default?");
    area(1).dispatchEvent(new FocusEvent("blur")); await wait(5);
    ok("comment edit: leaving the textarea keeps the edit", !area(1) && lis()[1].querySelector(".c-text").textContent === "Why 5 as the default?" && !!lis()[1].querySelector(".c-edited"));
    editBtn(1).click(); await wait(5);
    type(1, "  ");
    area(1).dispatchEvent(new FocusEvent("blur")); await wait(5);
    ok("comment edit: an emptied comment falls back to the agent's text", lis()[1].querySelector(".c-text").textContent === "Why this default?" && !lis()[1].querySelector(".c-edited") && !("pr-9951|r1#c:c2|h1" in JSON.parse(stored())));
    editBtn(1).click(); await wait(5);
    type(1, "Why 5 as the default?");
    area(1).dispatchEvent(new FocusEvent("blur")); await wait(5);

    // A reload keeps only what the browser stored
    document.getElementById("d-close").click(); await wait(5);
    for (const k of [...state.drafts.keys()]) if (k.includes("#c:")) state.drafts.delete(k);
    await openItem("pr-9951");
    ok("comment edit: the edits come back after a reload", lis()[0].querySelector(".c-text").textContent === "Please keep the metadata comments general." && lis()[1].querySelector(".c-text").textContent === "Why 5 as the default?" && lis().every((li) => !!li.querySelector(".c-edited")));
    resetBtn(1).click(); await wait(5);
    ok("comment edit: Reset restores the agent's text", lis()[1].querySelector(".c-text").textContent === "Why this default?" && !lis()[1].querySelector(".c-edited") && !resetBtn(1) && !("pr-9951|r1#c:c2|h1" in JSON.parse(stored())));

    // Sent input: the edit of a checked comment only
    editBtn(1).click(); await wait(5);
    type(1, "Edited but unchecked");
    area(1).dispatchEvent(new FocusEvent("blur")); await wait(5);
    lis()[1].querySelector("input[type=checkbox]").click(); await wait(5);
    let calls = __calls.length;
    window.__reply = () => ({ ok: true, result: "https://github.com/acme/widgets/pull/9951#pullrequestreview-1" });
    cardBtn("Comment").click(); await wait(5);
    cardBtn("Confirm: comment as widgets-bot").click(); await wait(20);
    const sent = __calls.at(-1);
    ok("comment edit: the click sends the edited text of the checked comment", __calls.length === calls + 1 && sent.tool === "review" && JSON.stringify(sent.input.commentIds) === '["c1"]' && JSON.stringify(sent.input.commentTexts) === '{"c1":"Please keep the metadata comments general."}', sent);
    ok("comment edit: a sent review drops its saved edits", !/#c:/.test(stored()), stored());
    document.getElementById("d-close").click(); await wait(5);

    // A new draft hash drops the edit
    localStorage.setItem("gary:widgets:drafts", JSON.stringify({ ...JSON.parse(stored() || "{}"), "pr-9951|r1#c:c2|h1": "For the old text" }));
    items(list(review({ draftHash: "h2" }))); await wait(10);
    await openItem("pr-9951");
    ok("comment edit: an edit made for an older draft is dropped", lis()[1].querySelector(".c-text").textContent === "Why this default?" && !lis()[1].querySelector(".c-edited") && !/For the old text/.test(stored()));
    calls = __calls.length;
    cardBtn("Comment").click(); await wait(5);
    cardBtn("Confirm: comment as widgets-bot").click(); await wait(20);
    ok("comment edit: an unedited review sends no commentTexts", __calls.length === calls + 1 && !("commentTexts" in __calls.at(-1).input), __calls.at(-1));
    document.getElementById("d-close").click(); await wait(5);

    await openItem("pr-9952");
    ok("comment edit: a review the maintainer posts themself has no Edit link", lis().length === 2 && !openCard().querySelector(".c-edit") && lis()[0].querySelector(".c-text").textContent === "Metadata comments are for general information about the device.");
    document.getElementById("d-close").click(); await wait(5);
    window.__reply = () => ({ ok: true, result: { dryRun: true } });
    items(F); await wait(5);
  }
