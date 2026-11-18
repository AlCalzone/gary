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
  // Back to one instance for the remaining suites
  tabBtns()[0].click(); await wait(5);
  window.__board.instances = [window.__instanceInfo("widgets", "widgets")];
  applyBoardInfo(window.__board);
  ok("back to one instance: the tab bar goes away", tabsBar.hidden && document.getElementById("board-title").textContent === "widgets triage");
