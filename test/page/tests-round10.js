  // ---------- round 10 ----------
  // Setting proposals: a card built from numbers, which sets a config value on accept
  {
    const lb = document.getElementById("learn");
    const dlg = document.getElementById("learn-dialog");
    const pcards = () => [...dlg.querySelectorAll(".pcard")];
    const buttons = (c) => [...c.querySelectorAll(".card-actions button")].map((b) => b.textContent).join();
    const paras = (c) => [...c.querySelectorAll(".card-why")].map((p) => p.textContent);
    const shown = () => [...dlg.querySelectorAll(".d-bar .d-ref, .learn-group:not([hidden]), #learn-empty:not([hidden])")].map((e) => e.textContent).join(" ");
    const answers = { fast: { section: "deferred", recommendedType: "follow_up" }, standard: { section: "deferred", recommendedType: null } };
    const on = ["s-on", {
      kind: "setting", setting: { key: "fastTier", value: "on" }, title: "Use the faster model for obvious items",
      stats: { pairs: 130, handedUp: 76, answered: 54, sameSection: 54, sameRouteType: 51 },
      differences: [
        { itemId: "issue-9471", number: 9471, url: "https://github.com/acme/widgets/issues/9471", runs: 3, ...answers },
        { itemId: "issue-9001", number: 9001, url: "https://github.com/acme/widgets/issues/9001", runs: 1, fast: { section: "easy", recommendedType: "merge" }, standard: { section: "review", recommendedType: "merge" } },
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
    ok("setting only: heading and intro do not talk about his decisions or rules", document.getElementById("learn-settings-title").textContent === "A setting Gary would change"
      && document.getElementById("learn-settings-intro").textContent === "Gary measured this itself. Nothing changes until you click." && !/decision|decided|rule/i.test(shown()), shown());
    ok("setting: the card has the plain title", card().querySelector(".p-title").textContent === "Use the faster model for obvious items");
    ok("setting: the first paragraph says what was measured, with the numbers", paras(card())[0] === "For a while, a faster and cheaper model sorted the same items as the standard model. Its answers were not used. "
      + "Gary compared their answers 130 times. The faster model passed 76 of these on as too hard. In the other 54 it chose the same board section every time and the same kind of card 51 times.", paras(card())[0]);
    ok("setting: the second paragraph says what changes", paras(card())[1] === "If you turn this on, the faster model sorts the obvious items and passes the rest on to the standard model. Runs get faster and cheaper. "
      + "The faster model never drafts text for GitHub, never judges code and never suggests closing an item. Full reviews stay as they are.", paras(card())[1]);
    ok("setting: the third paragraph says that Gary keeps checking", paras(card()).length === 3 && paras(card())[2] === "Gary keeps checking some of its answers against the standard model and suggests switching back when the two disagree too often.", paras(card())[2]);
    ok("setting: no rule text, no target line and no decision count", !card().querySelector("textarea") && !card().querySelector("details") && !/Adds to|Based on|Rule/.test(card().textContent));
    const diffs = () => [...card().querySelectorAll(".diffs li")];
    ok("setting: the differences sit under their own label, one line per item", [...card().querySelectorAll(".card-label")].map((l) => l.textContent).join() === "Where they differed" && diffs().length === 3);
    ok("setting: a difference names the item, its runs and both kinds of card", diffs()[0].textContent === "#9471, in 3 runs: faster model: Implement card. Standard model: no card.", diffs()[0].textContent);
    ok("setting: equal cards in different board sections show the sections", diffs()[1].textContent === "#9001, in 1 run: faster model: board section “Easy wins”. Standard model: board section “Needs human review”.", diffs()[1].textContent);
    ok("setting: a difference in both shows both, and an unknown kind of card keeps its words", diffs()[2].textContent === "issue-gone, in 2 runs: faster model: Implement card, board section “Easy wins”. Standard model: Ask for a log card, board section “Active communication”.", diffs()[2].textContent);
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
      && paras(card())[1] === "In the last 40 checks the faster model chose the same board section as the standard model 30 times. Gary expects at least 38."
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
