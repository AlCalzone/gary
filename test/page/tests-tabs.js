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
  // A tab's icon, color and page tint come from the instance's config
  window.__board.instances[1].tab = { icon: "zap", color: "blue", background: true };
  applyBoardInfo(window.__board); await wait(5);
  ok("tab style: the tab shows its icon and color, the label stays", !!tabBtns()[2].querySelector("svg") && tabBtns()[2].style.getPropertyValue("--tab-ink") === "var(--cat-unblock-ink)" && tabBtns()[2].textContent === "contoso-gadgets" && !tabBtns()[1].querySelector("svg"));
  ok("tab style: the tab across all projects has no page tint", !("tint" in document.documentElement.dataset));
  tabBtns()[2].click(); await wait(5);
  ok("tab style: the project's own tab tints the page", document.documentElement.dataset.tint === "#8cc0f0" && /^#[0-9a-f]{6}$/.test(document.documentElement.style.getPropertyValue("--today")) && document.documentElement.style.getPropertyValue("--accent") !== "");
  {
    // The palette of every key color keeps text readable and cards apart from the page, in both themes
    const lum = (hx) => { const f = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4); const [r, g, b] = [1, 3, 5].map((i) => f(parseInt(hx.slice(i, i + 2), 16) / 255)); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
    const cr = (a, b) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
    const inks = { dark: ["#f4a582", "#8cc0f0", "#86d9a4", "#bbaefa", "#f3a8d2"], light: ["#a8481f", "#255f99", "#1f6a45", "#5a43b3", "#9a2c6a"] };
    const bad = [];
    for (const key of [...Object.values(TINT_KEYS), "#0071bc", "#ffcc00", "#ff0000", "#00ffcc"]) for (const theme of ["dark", "light"]) {
      const p = paletteFor(key, theme);
      const need = (what, a, b, min) => { const v = cr(a, b); if (v < min) bad.push(key + " " + theme + " " + what + " " + v.toFixed(2)); };
      for (const s of ["bg", "surface", "surface-2", "today", "today-hover", "n-surface", "n-surface-2"]) {
        need("fg/" + s, p.fg, p[s], 7);
        need("muted/" + s, p.muted, p[s], 4.5);
        need("faint/" + s, p.faint, p[s], 4.5);
        need("accent/" + s, p.accent, p[s], 4.5);
        inks[theme].forEach((ink, i) => need("category " + i + "/" + s, ink, p[s], 4.5));
      }
      need("accent-fg/accent", p["accent-fg"], p.accent, 4.5);
      need("accent/accent-soft", p.accent, p["accent-soft"], 4.5);
      need("plan card/page", p.today, p.bg, theme === "dark" ? 1.25 : 1.13);
      need("line/surface", p["line-strong"], p.surface, theme === "dark" ? 1.4 : 1.3);
    }
    ok("tab style: every key color keeps text contrast and separates cards from the page", bad.length === 0, bad.slice(0, 12).join(" | "));
    const chromaOf = (hx) => { const v = [1, 3, 5].map((i) => parseInt(hx.slice(i, i + 2), 16)); return Math.max(...v) - Math.min(...v); };
    ok("tab style: a dialog's surface is nearly neutral in every key color", Object.values(TINT_KEYS).every((k) => ["dark", "light"].every((th) => chromaOf(paletteFor(k, th)["n-surface"]) <= 4)), Object.values(TINT_KEYS).map((k) => paletteFor(k, "dark")["n-surface"]).join());
    ok("tab style: gray is a palette without hue", /^#([0-9a-f]{2})\1\1$/.test(paletteFor(TINT_KEYS.gray, "dark").bg));
  }
  tabBtns()[1].click(); await wait(5);
  ok("tab style: another project's tab drops the tint", !("tint" in document.documentElement.dataset));
  tabBtns()[0].click(); await wait(5);
  window.__board.instances[1].tab = { favorite: true };
  applyBoardInfo(window.__board); await wait(5);
  ok("tab style: a favorite comes right after All", tabBtns().map((b) => b.textContent).join() === "All,contoso-gadgets,widgets" && !!tabBtns()[0].querySelector("svg"));
  window.__board.instances[1].tab = { iconUrl: "tab-icon/gadgets" };
  applyBoardInfo(window.__board); await wait(5);
  ok("tab style: a file icon shows as an image", tabBtns()[2].querySelector("img.tab-img")?.getAttribute("src") === "tab-icon/gadgets" && !tabBtns()[2].querySelector("svg"));
  window.__board.instances[1].tab = { iconUrl: "https://example.com/x.png" };
  applyBoardInfo(window.__board); await wait(5);
  ok("tab style: an icon URL from elsewhere is ignored", !tabBtns()[2].querySelector("img"));
  delete window.__board.instances[1].tab;
  applyBoardInfo(window.__board); await wait(5);
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
  ok("drafts go to the instance's own keys", /debug log/.test(localStorage.getItem("gary:gadgets:drafts") || "") && !/debug log/.test(localStorage.getItem("gary:widgets:drafts") || ""));
  ok("the prefill marks the item handled at once", handledOf("gadgets/issue-41")?.routeId === "r1");
  localHandled.delete("gadgets/issue-41");
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
  // Action docs may name the item by its key
  window.__subs["actions"](__mkSnap([["gadgets/a1", { instance: "gadgets", itemId: "gadgets/issue-42", action: "comment", status: "done", via: "server", createdAt: new Date().toISOString() }]])); await wait(10);
  ok("an action doc that names its item by key belongs to that item", latestOf("gadgets/issue-42")?.action === "comment" && !latestOf("widgets/issue-31"));
  window.__subs["actions"](__mkSnap([])); await wait(5);

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

  // Invalid settings: a banner on the instance's tab and on All, writes refused as information
  {
    const sn = document.getElementById("settings-notes");
    const ERR = "profile.json: \"repo\" must be owner/name, got \"contoso\"";
    window.__board.instances[1].settingsError = ERR;
    window.__board.instances[1].settingsWarnings = ["Unknown field \"autolabels\" in profile.json, did you mean \"autoLabels\"?"];
    window.__board.instances.push({ name: "broken", title: "", kind: null, repos: [], repoUrl: null, me: null, bot: null, accountMode: "none", paused: false, relatedRepos: [], botCommands: {}, reviewBots: [], settingsError: "config.json: invalid JSON at line 3" });
    window.dispatchEvent(new Event("board:info")); await wait(10);
    tabBtns()[0].click(); await wait(5);
    const banners = () => [...sn.querySelectorAll(".settings-banner")];
    ok("All: one banner per instance with invalid settings, naming it", banners().length === 2 && /The settings of contoso-gadgets are invalid\. Gary keeps the last valid ones and sends nothing to GitHub until this is fixed\./.test(banners()[0].textContent) && /The settings of broken are invalid/.test(banners()[1].textContent));
    ok("the error text sits below in monospace", banners()[0].querySelector("pre.settings-error")?.textContent === ERR && /mono/i.test(getComputedStyle(banners()[0].querySelector("pre")).fontFamily));
    ok("All: warnings stay on the instance's own tab", !sn.querySelector(".settings-warnings"));
    ok("a never-valid instance is an empty tab titled by its name", tabBtns().map((b) => b.textContent).join() === "All,widgets,contoso-gadgets,broken");
    tabBtns()[3].click(); await wait(5);
    ok("its tab shows the banner and no rows, nothing breaks", banners().length === 1 && /broken/.test(banners()[0].textContent) && document.querySelectorAll("#board .row").length === 0);
    tabBtns()[1].click(); await wait(5);
    ok("a healthy instance's tab shows no banner", banners().length === 0);
    tabBtns()[2].click(); await wait(5);
    const warn = sn.querySelector(".settings-warnings");
    ok("its own tab: the banner plus warnings as one quiet collapsed line", banners().length === 1 && !!warn && !warn.open && warn.querySelector("summary").textContent === "1 note about the settings" && /autolabels/.test(warn.textContent));
    tabBtns()[0].click(); await wait(5);
    openDetail("gadgets/pr-12"); await wait(10);
    window.__reply = (b) => (b.instance === "gadgets" ? { ok: false, result: "The settings of gadgets are invalid: " + ERR, settingsError: ERR } : { ok: true, result: { dryRun: true } });
    [...document.querySelectorAll("#d-routes .card.open .card-actions button")].find((b) => b.textContent === "Request changes").click(); await wait(5);
    [...document.querySelectorAll("#d-routes .card.open .card-actions button")].find((b) => /^Confirm/.test(b.textContent)).click(); await wait(20);
    const info = document.querySelector("#d-routes .card.open .status.info");
    ok("a refused click shows as information without the whole error", !!info && /settings of contoso-gadgets are invalid/.test(info.textContent) && !info.textContent.includes(ERR) && !document.querySelector("#d-routes .card.open .status.failed"));
    window.__reply = () => ({ ok: true, result: { dryRun: true } });
    document.getElementById("d-close").click(); await wait(5);
    delete window.__board.instances[1].settingsError;
    delete window.__board.instances[1].settingsWarnings;
    window.__board.instances.pop();
    window.dispatchEvent(new Event("board:info")); await wait(10);
    ok("fixed settings: the banner goes away", !sn.children.length);
  }

  // Back to one instance for the remaining suites
  tabBtns()[0].click(); await wait(5);
  window.__board.instances = [window.__instanceInfo("widgets", "widgets")];
  applyBoardInfo(window.__board);
  ok("back to one instance: the tab bar goes away", tabsBar.hidden && document.getElementById("board-title").textContent === "widgets triage");
