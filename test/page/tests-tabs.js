  // ---------- one board, several instances ----------
  const tabsBar = document.getElementById("tabs");
  ok("one instance: no tab bar", tabsBar.hidden && document.getElementById("board-title").textContent === "widgets triage");
  const acctT = (login) => ({ login, avatarUrl: "https://github.com/" + login + ".png?size=80" });
  const TWO = { ...window.__board, me: acctT("octocat"), dryRun: false, instances: [window.__instanceInfo("widgets", "widgets"), window.__instanceInfo("gadgets", "contoso-gadgets")] };
  window.__board.me = TWO.me; window.__board.instances = TWO.instances;
  applyBoardInfo(window.__board);
  const T = window.makeTwoInstanceFixtures(iso);
  items(T); await wait(10);
  const tabBtns = () => [...tabsBar.querySelectorAll(".tab")];
  const rowsIn = (g) => [...document.querySelectorAll("#group-" + g + " .row")];
  const allRows = () => [...document.querySelectorAll("#board .row")];
  ok("two instances: All first, then one tab per instance title, no counts", !tabsBar.hidden && tabBtns().map((b) => b.textContent).join() === "All,widgets,contoso-gadgets" && tabBtns()[0].getAttribute("aria-selected") === "true");
  ok("the header names the board, not one project", document.getElementById("board-title").textContent === "Gary");
  ok("combined: both projects' #12 are on the board with their full refs", rowsIn("quick").concat(rowsIn("after"), rowsIn("later")).some((r) => r.querySelector(".r-ref")?.textContent === "acme/widgets#12")
    || allRows().some((r) => r.querySelector(".r-ref")?.textContent === "acme/widgets#12"));
  for (let i = 0; i < 4; i++) for (const b of document.querySelectorAll(".show-all")) if (!b.hidden && !/less/i.test(b.textContent)) b.click();
  await wait(5);
  ok("combined: every row carries its owner/name#number, the number column is gone", allRows().length === 8 && allRows().every((r) => /^(acme\/widgets|contoso\/gadgets)#\d+$/.test(r.querySelector(".r-ref")?.textContent ?? "") && getComputedStyle(r.querySelector(".r-num")).display === "none")
    && allRows().filter((r) => /#12$/.test(r.querySelector(".r-ref").textContent)).length === 2);
  state.reveal.clear(); render(); await wait(5);
  ok("combined: the same plan rules, at most 5 in Quick & Easy", rowsIn("quick").length === 5 && !!document.querySelector("#group-quick .show-all"));
  const titleW = (r) => r.querySelector(".r-title").getBoundingClientRect().width;
  const combinedTitleW = titleW(rowsIn("quick")[0]);
  // A project tab
  tabBtns()[2].click(); await wait(10);
  ok("project tab: only its items, #number in the row, no ref line", allRows().length > 0 && allRows().every((r) => state.items.get(r.dataset.id).instance === "gadgets" && /^#\d+$/.test(r.querySelector(".r-num").textContent) && !r.querySelector(".r-ref")));
  ok("project tab: the full ref does not cost the title width", combinedTitleW >= titleW(rowsIn("quick")[0]) - 1);
  ok("the tab choice is remembered board-wide", localStorage.getItem("gary:board:tab") === "gadgets" && tabBtns()[2].getAttribute("aria-selected") === "true" && tabBtns()[0].getAttribute("aria-selected") === "false");
  // Keyboard
  tabBtns()[2].focus();
  tabBtns()[2].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true })); await wait(10);
  ok("arrow keys move between tabs and keep focus on the tab list", tabBtns()[1].getAttribute("aria-selected") === "true" && document.activeElement === tabBtns()[1] && tabBtns()[1].tabIndex === 0 && tabBtns()[0].tabIndex === -1);
  tabBtns()[1].dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true })); await wait(10);
  ok("Home goes back to All", tabBtns()[0].getAttribute("aria-selected") === "true");
  // The dialog in the combined tab names the full ref and uses the item's own instance
  openDetail("gadgets/pr-12"); await wait(10);
  ok("combined: the dialog's top bar shows the full ref", document.querySelector("#d-ref .ref")?.textContent === "contoso/gadgets#12");
  const gBtn = [...document.querySelectorAll("#d-routes .card.open .card-actions button")].find((b) => b.textContent === "Request changes");
  ok("the bot avatar comes from the item's instance", /gadgets-bot/.test(gBtn?.querySelector("img")?.src ?? gBtn?.title ?? ""));
  gBtn.click(); await wait(5);
  ok("the confirm names the item's own bot", !![...document.querySelectorAll("#d-routes .card.open .card-actions button")].find((b) => b.textContent === "Confirm: request changes as gadgets-bot"));
  let callsT = __calls.length;
  [...document.querySelectorAll("#d-routes .card.open .card-actions button")].find((b) => b.textContent === "Confirm: request changes as gadgets-bot").click(); await wait(20);
  ok("a route click sends the item's instance and its own id", __calls.length === callsT + 1 && __calls.at(-1).instance === "gadgets" && __calls.at(-1).itemId === "pr-12");
  document.getElementById("d-close").click(); await wait(5);
  openDetail("gadgets/issue-41"); await wait(10);
  const gTa = document.querySelector("#d-routes .card.open textarea");
  gTa.value = "Could you attach a debug log?"; gTa.dispatchEvent(new Event("input"));
  const nD = window.__decisions.length;
  [...document.querySelectorAll("#d-routes .card.open .card-actions button")].find((b) => b.textContent === "Copy reply, open GitHub").click(); await wait(20);
  ok("the decision post names the instance", window.__decisions.length === nD + 1 && window.__decisions.at(-1).instance === "gadgets" && window.__decisions.at(-1).itemId === "issue-41");
  ok("drafts and opened marks go to the instance's own keys", /debug log/.test(localStorage.getItem("gary:gadgets:drafts") || "") && /issue-41/.test(localStorage.getItem("gary:gadgets:opened") || "") && !/issue-41/.test(localStorage.getItem("gary:widgets:opened") || ""));
  const wB = __writes.length;
  document.querySelector('#d-foot [aria-label="Snooze 1 day"]').click(); await wait(20);
  ok("a snooze writes to the item's instance", __writes.slice(wB).some((w) => w[1] === "items/gadgets/issue-41" && w[2].snoozedUntil) && __writes.slice(wB).some((w) => /^actions\/gadgets\//.test(w[1]) && w[2].instance === "gadgets" && w[2].itemId === "issue-41"));
  items(T); await wait(10);
  // Paused per instance
  const pausedM = document.getElementById("paused");
  window.__board.instances[1].paused = true; window.dispatchEvent(new Event("board:info")); await wait(10);
  ok("combined: some paused names them", !pausedM.hidden && pausedM.textContent === "Paused: contoso-gadgets");
  tabBtns()[1].click(); await wait(5);
  ok("a running instance's tab shows no marker", pausedM.hidden);
  tabBtns()[2].click(); await wait(5);
  ok("a paused instance's tab shows Paused", !pausedM.hidden && pausedM.textContent === "Paused");
  tabBtns()[0].click(); await wait(5);
  openDetail("gadgets/pr-12"); await wait(10);
  ok("bot buttons show the paused hint by their own instance", !!document.querySelector("#d-routes .card.open .paused-hint"));
  document.getElementById("d-close").click(); await wait(5);
  openDetail("widgets/pr-12"); await wait(10);
  ok("the other instance's bot buttons have no hint", !document.querySelector("#d-routes .paused-hint"));
  document.getElementById("d-close").click(); await wait(5);
  window.__board.instances[0].paused = true; window.dispatchEvent(new Event("board:info")); await wait(10);
  ok("combined: all paused says Paused", !pausedM.hidden && pausedM.textContent === "Paused");
  window.__board.instances[0].paused = false; window.__board.instances[1].paused = false; window.dispatchEvent(new Event("board:info")); await wait(10);
  ok("resumed: no marker", pausedM.hidden);
  // Proposals of all instances in one dialog
  window.__subs["proposals"](__mkSnap(window.makeTwoInstanceProposals(iso))); await wait(10);
  const lb = document.getElementById("learn");
  ok("the lightbulb counts proposals of all instances", !lb.hidden && lb.textContent === "2");
  tabBtns()[1].click(); await wait(5);
  ok("the count is the same from a project tab", lb.textContent === "2");
  lb.click(); await wait(10);
  const lcards = () => [...document.querySelectorAll("#learn-dialog .pcard")];
  ok("each proposal card names its instance", lcards().length === 2 && lcards().map((c) => c.querySelector(".p-instance")?.textContent).sort().join() === "contoso-gadgets,widgets");
  const gCard = lcards().find((c) => /manual link/.test(c.textContent));
  callsT = __calls.length;
  [...gCard.querySelectorAll(".card-actions button")].find((b) => b.textContent === "Add rule").click(); await wait(20);
  ok("accepting a proposal sends its instance", __calls.at(-1).tool === "accept_proposal" && __calls.at(-1).instance === "gadgets" && __calls.at(-1).proposalId === "learn-1");
  ok("both instances' proposals with the same id stay apart", lcards().length === 2 && /Added to rules\/review\.md/.test(gCard.textContent) && !/Added to/.test(lcards().find((c) => c !== gCard).textContent));
  document.getElementById("learn-close").click(); await wait(5);
  window.__subs["proposals"](__mkSnap([])); await wait(5);
  // Hover and focus audit: every button variant keeps a readable label in both themes
  {
    // Copy every :hover and :focus-visible rule to a class, so the states can be measured without a pointer
    const sheet = document.createElement("style");
    const rules = [];
    for (const ss of document.styleSheets) {
      let list;
      try { list = ss.cssRules; } catch { continue; }
      const walk = (rs, wrap) => {
        for (const r of rs) {
          if (r.cssRules && r.media) walk(r.cssRules, (x) => "@media " + r.media.mediaText + " { " + wrap(x) + " }");
          else if (r.selectorText && /:hover|:focus-visible/.test(r.selectorText)) {
            rules.push(wrap(r.selectorText.replace(/:hover/g, ".__hover").replace(/:focus-visible/g, ".__focus") + " { " + r.style.cssText + " }"));
          }
        }
      };
      walk(list, (x) => x);
    }
    sheet.textContent = rules.join("\n");
    document.head.append(sheet);
    const parse = (c) => {
      let m = /^rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)$/.exec(c);
      if (m) return [+m[1] / 255, +m[2] / 255, +m[3] / 255, m[4] === undefined ? 1 : +m[4]];
      m = /^color\(srgb ([\d.e-]+) ([\d.e-]+) ([\d.e-]+)(?: \/ ([\d.]+))?\)$/.exec(c);
      if (m) return [+m[1], +m[2], +m[3], m[4] === undefined ? 1 : +m[4]];
      return null;
    };
    const over = (top, bottom) => [0, 1, 2].map((i) => top[i] * top[3] + bottom[i] * (1 - top[3])).concat(1);
    const bgOf = (el) => {
      const layers = [];
      for (let e = el; e; e = e.parentElement) {
        const c = parse(getComputedStyle(e).backgroundColor);
        if (c && c[3] > 0) { layers.push(c); if (c[3] >= 1) break; }
      }
      let out = [1, 1, 1, 1];
      for (const l of layers.reverse()) out = over(l, out);
      return out;
    };
    const lum = (c) => { const f = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4); return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
    const contrast = (el) => {
      const bg = bgOf(el);
      const fg = over(parse(getComputedStyle(el).color) ?? [0, 0, 0, 1], bg);
      const [a, b] = [lum(fg), lum(bg)].sort((x, y) => y - x);
      return (a + 0.05) / (b + 0.05);
    };
    const bad = [];
    const audit = (label, el, min = 4.5) => {
      if (!el) { bad.push(label + ": missing"); return; }
      for (const state of ["", "__hover", "__focus"]) {
        if (state) el.classList.add(state);
        const c = contrast(el);
        if (c < min) bad.push(label + (state ? " " + state : "") + " " + c.toFixed(2));
        if (state) el.classList.remove(state);
      }
    };
    if (rules.length < 10) bad.push("only " + rules.length + " hover and focus rules found");
    const P2 = window.makeTwoInstanceProposals(iso);
    items([...T, ...F]); await wait(10);
    for (const theme of ["light", "dark"]) {
      document.documentElement.dataset.theme = theme;
      await wait(5);
      audit(theme + " tab", tabsBar.querySelector('.tab[aria-selected="false"]'));
      audit(theme + " tab selected", tabsBar.querySelector('.tab[aria-selected="true"]'));
      window.__subs["proposals"](__mkSnap(P2)); await wait(5);
      audit(theme + " lightbulb", document.getElementById("learn"));
      openDetail("widgets/pr-12"); await wait(10);
      audit(theme + " filled intent button", document.querySelector("#d-routes .card.open .card-actions .btn.primary"));
      document.querySelector("#d-routes .card.open .card-actions .btn.primary").click(); await wait(5);
      audit(theme + " confirm button", document.querySelector("#d-routes .card.open .btn.confirm"));
      audit(theme + " quiet button", [...document.querySelectorAll("#d-routes .card.open .btn.quiet")].find((b) => b.textContent === "Cancel"));
      [...document.querySelectorAll("#d-routes .card.open .btn.quiet")].find((b) => b.textContent === "Cancel").click(); await wait(5);
      audit(theme + " foot button", document.querySelector('#d-foot [aria-label="Snooze 1 day"]'));
      audit(theme + " analyze foot button", document.querySelector("#d-foot .foot-analyze"));
      audit(theme + " card dismiss", document.querySelector("#d-routes .card .card-x"), 3);
      document.getElementById("d-close").click(); await wait(5);
      openDetail("widgets/issue-31"); await wait(10);
      audit(theme + " me button filled", document.querySelector("#d-routes .card.open .me-btn"));
      document.getElementById("d-close").click(); await wait(5);
      openDetail("pr-9473"); await wait(10);
      audit(theme + " compact row me button", document.querySelector("#d-routes .card.compact .me-btn"));
      audit(theme + " compact row bot button", [...document.querySelectorAll("#d-routes .card.compact .card-actions .btn")].find((b) => !b.classList.contains("me-btn")));
      audit(theme + " outline intent button", (() => { const c = [...document.querySelectorAll("#d-routes .card")][3]; c.querySelector(".card-head").click(); return c.querySelector(".card-actions .btn"); })());
      document.getElementById("d-close").click(); await wait(5);
      openDetail("pr-9474"); await wait(10);
      audit(theme + " segment", document.querySelector('#d-routes .card.open .seg[aria-pressed="false"]'));
      audit(theme + " segment fix", document.querySelector('#d-routes .card.open .seg[data-v="fix"][aria-pressed="true"]'));
      audit(theme + " segment dismiss", document.querySelector('#d-routes .card.open .seg[data-v="dismiss"][aria-pressed="true"]'));
      audit(theme + " link button", document.querySelector("#d-routes .card.open .lane-switch"));
      document.getElementById("d-close").click(); await wait(5);
      window.__board.instances[1].paused = true; window.dispatchEvent(new Event("board:info")); await wait(10);
      openDetail("gadgets/pr-12"); await wait(10);
      audit(theme + " paused hint", document.querySelector("#d-routes .paused-hint"));
      document.getElementById("d-close").click(); await wait(5);
      window.__board.instances[1].paused = false; window.dispatchEvent(new Event("board:info")); await wait(10);
      document.getElementById("learn").click(); await wait(10);
      const pc = document.querySelector("#learn-dialog .pcard");
      audit(theme + " Add rule", [...pc.querySelectorAll(".card-actions button")].find((b) => b.textContent === "Add rule"));
      audit(theme + " Not this", [...pc.querySelectorAll(".card-actions button")].find((b) => b.textContent === "Not this"));
      document.getElementById("learn-close").click(); await wait(5);
      window.__subs["proposals"](__mkSnap([])); await wait(5);
    }
    delete document.documentElement.dataset.theme;
    sheet.remove();
    ok("hover and focus keep labels readable in light and dark " + bad.join(" | "), bad.length === 0);
  }

  // A reload while a dialog is open waits, and the dialog's own bar says so
  openDetail("widgets/issue-31"); await wait(10);
  window.dispatchEvent(new Event("board:reload")); await wait(5);
  ok("a deferred reload shows its notice in the dialog's top bar", !document.querySelector("#detail .bar-reload").hidden && !document.getElementById("reload").hidden && reloadPending === true);
  reloadPending = false;
  for (const b of document.querySelectorAll("#reload, .bar-reload")) b.hidden = true;
  document.getElementById("d-close").click(); await wait(5);

  // Back to one instance for the remaining suites
  tabBtns()[0].click(); await wait(5);
  window.__board.instances = [window.__instanceInfo("widgets", "widgets")];
  applyBoardInfo(window.__board);
  ok("back to one instance: the tab bar goes away", tabsBar.hidden && document.getElementById("board-title").textContent === "widgets triage");
