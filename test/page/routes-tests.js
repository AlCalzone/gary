// A button shows the account's avatar, or its letter placeholder when the image cannot load offline
const avatarOf = (btn, login) => new RegExp(login).test(btn?.querySelector("img")?.src ?? "") || btn?.querySelector(".avatar.ph")?.dataset.letter === login[0].toUpperCase();
  // ---------- route cards ----------
  window.__opened = [];
  window.open = (url) => { window.__opened.push(url); return null; };
  window.__clip = null;
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (t) => { window.__clip = t; } } });
  await wait(30);
  const dlgR = document.getElementById("detail");
  const openItem = async (id) => { if (dlgR.open) { document.getElementById("d-close").click(); await wait(5); } openDetail(id); await wait(10); };
  const cards = () => [...document.querySelectorAll("#d-routes .card")];
  const expandedCard = () => document.querySelector("#d-routes .card.open");
  // A card collapses when its action is done. The checks after a click still look at that card
  let actedCard = null;
  const openCard = () => expandedCard() || (actedCard && actedCard.isConnected && actedCard.classList.contains("settled") ? actedCard : null);
  const cardBtn = (text, card = openCard()) => {
    const btn = [...(card?.querySelectorAll(".card-actions button") ?? [])].find((b) => b.textContent === text);
    if (btn) actedCard = card;
    return btn;
  };
  const expand = async (i) => { cards()[i].querySelector(".card-head").click(); await wait(5); };
  const F = window.makeRouteFixtures(iso);
  const with_ = (id, fn) => F.map((e) => (e[0] === id ? [e[0], fn(e[1])] : e));
  const routeMap = (id, rid, fn) => with_(id, (d) => ({ ...d, routes: d.routes.map((r) => (r.id === rid ? fn(r) : r)) }));
  items(F);
  await wait(10);
  ok("list hint falls back to the recommended route title", /Reply: a PR is welcome/.test(document.querySelector('.row[data-id="issue-9471"] .r-hint')?.textContent ?? ""));

  // items without routes are not on the board
  items([...F, ["issue-9478", { ...F[0][1], number: 9478, url: "https://github.com/acme/widgets/issues/9478", routes: [] }], ["issue-9479", { ...F[0][1], number: 9479, url: "https://github.com/acme/widgets/issues/9479", routes: undefined }]]);
  await wait(10);
  ok("items without routes are not shown", !document.querySelector('.row[data-id="issue-9478"]') && !document.querySelector('.row[data-id="issue-9479"]') && !!document.querySelector('.row[data-id="issue-9471"]'));
  items(F); await wait(10);

  // reply in his name, findings per route, cards, chevrons, tints
  await openItem("issue-9471");
  ok("four cards, the recommended one open", cards().length === 4 && cards().filter((c) => c.classList.contains("open")).length === 1 && openCard() === cards()[0]);
  ok("verdict leads into the cards", document.getElementById("d-verdict").nextElementSibling === document.getElementById("d-routes") && !document.querySelector("#d-verdict svg"));
  ok("open card shows title in hint style, why and an editor", openCard().querySelector(".card-head .r-hint .h-act")?.textContent === "Reply" && /already found the cause/.test(openCard().querySelector(".card-why").textContent) && !!openCard().querySelector("textarea"));
  ok("expandable cards carry a chevron, compact rows do not", cards().filter((c) => !c.classList.contains("compact")).every((c) => !!c.querySelector(".card-head .chev")) && !cards()[1].querySelector(".chev"));
  ok("cards are tinted by intent", cards()[0].classList.contains("intent-talk") && cards()[1].classList.contains("intent-close") && cards()[2].classList.contains("intent-agent")
    && getComputedStyle(cards()[2]).backgroundColor !== getComputedStyle(cards()[0]).backgroundColor);
  ok("collapsed single-actor cards show the actor on the line", !cards()[2].querySelector(".card-body").hidden === false && getComputedStyle(cards()[2].querySelector(".card-head .head-actor")).display !== "none" && !!cards()[2].querySelector(".card-head .head-actor .actor-icon"));
  ok("the open card keeps the actor on its button only", getComputedStyle(openCard().querySelector(".card-head .head-actor")).display === "none");
  ok("close without text is a compact row with one button and no body", cards()[1].classList.contains("compact") && !cards()[1].querySelector(".card-body") && [...cards()[1].querySelectorAll(".card-actions button")].length === 1 && !!cardBtn("Open GitHub to close", cards()[1]));
  ok("a route finding is the card's body, others stay in the findings list", /stored node data looks corrupted/.test(cards()[2].querySelector(".card-finding").textContent) && !/corrupted/.test(document.getElementById("d-findings").textContent) && /two releases behind/.test(document.getElementById("d-findings").textContent));
  const replyBtn = cardBtn("Copy reply, open GitHub");
  ok("reply in his name: label, his avatar, external icon", !!replyBtn && /octocat/.test(replyBtn.querySelector("img")?.src ?? "") && !!replyBtn.querySelector(".ext"));
  const ta201 = openCard().querySelector("textarea");
  ta201.value = "A PR is welcome! Edited."; ta201.dispatchEvent(new Event("input"));
  let calls = __calls.length;
  replyBtn.click(); await wait(20);
  ok("reply in his name copies, opens the anchor and never calls the server", window.__clip === "A PR is welcome! Edited." && window.__opened.at(-1) === "https://github.com/acme/widgets/issues/9471" && __calls.length === calls);
  const hd0 = () => cards()[0].querySelector(".card-top > .head-done");
  ok("a used prefill card collapses, with the confirmation in its header row", !expandedCard() && !hd0().hidden && !!hd0().querySelector("svg") && /^Copied and opened, \d\d:\d\d$/.test(hd0().textContent) && cards()[0].classList.contains("settled") && cards()[0].querySelector(".card-x").hidden);
  ok("the done row is muted against the open suggestions", getComputedStyle(cards()[0].querySelector(".card-head .r-hint")).opacity < 1 && getComputedStyle(cards()[2].querySelector(".card-head .r-hint")).opacity === "1");
  ok("no other card opens in its place", cards().filter((c) => c.classList.contains("open")).length === 0);
  await expand(0);
  ok("he can expand it again, and the header confirmation moves into the card", openCard() === cards()[0] && hd0().hidden);
  const om = openCard().querySelector(".card-actions .status.opened");
  ok("a used prefill says so in words with the time, and never Done", !!om && !!om.querySelector("svg") && /^Copied and opened on GitHub, \d\d:\d\d$/.test(om.textContent) && !om.classList.contains("done") && !/Done/.test(openCard().querySelector(".card-actions").textContent) && handledToday("issue-9471"));
  ok("the used button turns into a secondary Copy again", !cardBtn("Copy reply, open GitHub") && cardBtn("Copy again")?.classList.contains("quiet") && !cardBtn("Copy again").classList.contains("primary") && !cardBtn("Copy again").disabled);
  window.__clip = null;
  cardBtn("Copy again").click(); await wait(20);
  ok("Copy again still copies and opens", window.__clip === "A PR is welcome! Edited." && window.__opened.at(-1) === "https://github.com/acme/widgets/issues/9471" && __calls.length === calls && ta201.isConnected);
  ok("a prefill without text says Opened and offers Open again", (() => {
    const c = cards()[1]; cardBtn("Open GitHub to close", c).click();
    return /^Opened on GitHub, \d\d:\d\d$/.test(c.querySelector(".card-actions .status.opened")?.textContent ?? "") && !!cardBtn("Open again", c);
  })());
  await expand(2);
  ok("clicking a collapsed card opens it and closes the other", openCard() === cards()[2] && cards()[0].querySelector(".card-body").hidden);
  ok("the collapsed header of a used prefill carries the check", !hd0().hidden && !!hd0().querySelector("svg") && cards()[2].querySelector(".card-top > .head-done").hidden);
  await expand(2);
  ok("clicking the open card's head collapses it", !expandedCard());
  await expand(2);
  ok("no lane switch anywhere", !document.querySelector("#d-routes .card-head ~ * .lane-switch[data-focus-key^='lane']"));
  calls = __calls.length;
  cardBtn("Start fix").click(); await wait(20);
  const fixCall = __calls.at(-1);
  ok("follow_up agent: teal Start fix, no confirm, sends routeId and draftHash", __calls.length === calls + 1 && fixCall.itemId === "issue-9471" && fixCall.routeId === "r3" && fixCall.draftHash === "h3" && fixCall.force === false);
  ok("success shows on the card", /The agent is on it/.test(openCard().querySelector(".card-actions").textContent));
  ok("Start fix sends the reporter switch, off by default", fixCall.input.askReporter === false);
  ok("a queued agent route collapses with Requested in its header", !expandedCard() && /^Requested$/.test(cards()[2].querySelector(".card-top > .head-done").textContent) && !cards()[2].querySelector(".card-top > .head-done").hidden);
  ok("a click on another card leaves the used prefill marked", !hd0().hidden && /Copied and opened on GitHub/.test(cards()[0].querySelector(".card-actions").textContent));
  ok("a route click writes no action doc from the page", !__writes.some((w) => w[1].startsWith("actions/")));

  // move to another repo: two bot buttons, the close one reveals its text first
  await expand(3);
  ok("move to a repo: two buttons with the bot avatar", !!cardBtn("Transfer to widgets-desktop") && !!cardBtn("Close, ask to reopen there") && [...openCard().querySelectorAll(".card-actions button")].every((b) => /widgets-bot/.test(b.querySelector("img")?.src ?? b.title)));
  ok("the canned text stays hidden until Close is picked", openCard().querySelector(".reveal").hidden);
  cardBtn("Transfer to widgets-desktop").click(); await wait(5);
  ok("transfer asks for the second confirm", !!cardBtn("Confirm: transfer to widgets-desktop as widgets-bot"));
  calls = __calls.length;
  cardBtn("Confirm: transfer to widgets-desktop as widgets-bot").click(); await wait(20);
  ok("transfer sends mode transfer without text", __calls.length === calls + 1 && __calls.at(-1).routeId === "r4" && __calls.at(-1).input.mode === "transfer" && __calls.at(-1).text === "");
  ok("a bot route that ran collapses with Done in its header", !expandedCard() && cards()[3].querySelector(".card-top > .head-done").textContent === "Done" && !cards()[3].querySelector(".card-top > .head-done").hidden);
  items(F); await wait(5);
  await openItem("issue-9471");
  await expand(3);
  cardBtn("Close, ask to reopen there").click(); await wait(5);
  ok("Close, ask to reopen there reveals the editable text", !openCard().querySelector(".reveal").hidden && /Widgets Desktop problem/.test(openCard().querySelector(".reveal textarea").value));
  cardBtn("Close, ask to reopen there").click(); await wait(5);
  ok("then it asks for the confirm", !!cardBtn("Confirm: post and close as widgets-bot"));
  calls = __calls.length;
  cardBtn("Confirm: post and close as widgets-bot").click(); await wait(20);
  ok("close sends mode close with the text", __calls.length === calls + 1 && __calls.at(-1).input.mode === "close" && /Widgets Desktop problem/.test(__calls.at(-1).text));

  // bot text routes, duplicate close, follow_up bot and me
  await openItem("issue-9472");
  const logsTa = openCard().querySelector("textarea");
  ok("request_logs: tall editable text and blue button", logsTa?.classList.contains("tall") && cardBtn("Ask for a debug log").classList.contains("intent-talk"));
  const resetLink = [...openCard().querySelectorAll(".lane-switch")].find((b) => b.textContent === "Reset to template");
  ok("Reset to template is hidden while the text is unchanged", !!resetLink && resetLink.hidden);
  logsTa.value = "Something else"; logsTa.dispatchEvent(new Event("input"));
  ok("Reset to template shows after an edit", !resetLink.hidden);
  resetLink.click(); await wait(5);
  ok("Reset to template restores the route's text", /loglevel `debug`/.test(logsTa.value) && resetLink.hidden);
  cardBtn("Ask for a debug log").click(); await wait(5);
  ok("request_logs asks for the confirm", !!cardBtn("Confirm: ask for a debug log as widgets-bot"));
  window.__reply = () => ({ ok: false, result: "jbarreiros commented 12 minutes ago. Re-check before posting.", stale: true, forceable: true });
  cardBtn("Confirm: ask for a debug log as widgets-bot").click(); await wait(20);
  ok("a refusal shows as failed on the card", /jbarreiros commented 12 minutes ago/.test(openCard().textContent));
  ok("a refused action leaves its card expanded and unsettled", !!expandedCard() && !expandedCard().classList.contains("settled") && expandedCard().querySelector(".card-top > .head-done").hidden && !expandedCard().querySelector(".card-x").hidden);
  window.__reply = () => ({ ok: false, result: "This route already ran. The board shows its result.", duplicate: true });
  cardBtn("Ask for a debug log").click(); await wait(5);
  cardBtn("Confirm: ask for a debug log as widgets-bot").click(); await wait(20);
  ok("409 duplicate shows its message", /already ran/.test(openCard().textContent));
  items(routeMap("issue-9472", "r1", (r) => ({ ...r, refused: { reason: "jbarreiros commented", forceable: true } }))); await wait(10);
  ok("Post anyway offered for a forceable refusal", !!cardBtn("Post anyway"));
  window.__reply = () => ({ ok: true, result: "https://github.com/x" });
  cardBtn("Post anyway").click(); await wait(5);
  calls = __calls.length;
  cardBtn("Confirm: ask for a debug log as widgets-bot").click(); await wait(20);
  ok("Post anyway sends with force after the confirm", __calls.length === calls + 1 && __calls.at(-1).force === true);
  window.__reply = () => ({ ok: true, result: { dryRun: true } });
  await expand(1);
  const dupLink = openCard().querySelector(".reason a");
  ok("duplicate reason links to the issue", /Duplicate of/.test(openCard().querySelector(".reason").textContent) && dupLink?.href === "https://github.com/acme/widgets/issues/9312");
  ok("close with text is a card that copies the reply", !openCard().classList.contains("compact") && !!cardBtn("Copy reply, open GitHub to close"));
  await expand(2);
  const titleField = openCard().querySelector(".card-body input.field");
  ok("follow_up bot: editable title and body, File issue", titleField?.value === "Wakeup interval resets to the default after a re-interview" && !!openCard().querySelector("textarea") && !!cardBtn("File issue"));
  titleField.value = "Edited title"; titleField.dispatchEvent(new Event("input"));
  cardBtn("File issue").click(); await wait(5);
  calls = __calls.length;
  cardBtn("Confirm: file issue as widgets-bot").click(); await wait(20);
  ok("follow_up bot sends the edited title as input", __calls.at(-1).input.title === "Edited title" && /3600 seconds/.test(__calls.at(-1).text));
  items(F); await wait(5);
  await openItem("issue-9472");
  await expand(3);
  calls = __calls.length;
  cardBtn("Open GitHub to file the issue").click(); await wait(20);
  ok("follow_up me opens the new-issue form with title and body encoded", window.__opened.at(-1) === "https://github.com/acme/widgets/issues/new?title=Docs%3A%20soft%20reset%20after%20restoreNVM&body=" + encodeURIComponent("The docs for `restoreNVM` do not mention the soft reset afterwards.\nApps should wait for the driver ready event again.") && __calls.length === calls);

  // review with diff hunks, merge in his name, chore row, take_over replace
  await openItem("pr-9473");
  const checks = [...openCard().querySelectorAll(".checklist input[type=checkbox]")];
  ok("review: checklist with all comments checked, path:line and text", checks.length === 2 && checks.every((c) => c.checked) && /zw100\.json:41/.test(openCard().querySelector(".checklist").textContent) && !!openCard().querySelector(".checklist code.ic"));
  ok("review: a comment with startLine shows its range", /Node\.ts:1210-1212/.test(openCard().querySelector(".checklist").textContent));
  const hunks = [...openCard().querySelectorAll(".hunk")];
  ok("review: each comment shows its diff hunk with added and removed lines", hunks.length === 2 && !!hunks[0].querySelector(".h-add") && !!hunks[0].querySelector(".h-del") && hunks.every((x) => x.querySelectorAll("span").length <= 12)
    && !!(hunks[0].compareDocumentPosition(hunks[0].parentElement.querySelector(".c-text")) & Node.DOCUMENT_POSITION_FOLLOWING));
  ok("review button label and color from the event", cardBtn("Request changes")?.classList.contains("intent-push"));
  const evSeg = () => [...openCard().querySelectorAll(".review-event .seg")];
  ok("review: a switch for the event, preset from the route", evSeg().map((b) => b.textContent).join() === "Request changes,Comment,Approve" && evSeg().find((b) => b.getAttribute("aria-pressed") === "true").textContent === "Request changes");
  evSeg()[1].click(); await wait(5);
  ok("review: the button follows the picked event", !cardBtn("Request changes") && cardBtn("Comment")?.classList.contains("intent-talk"));
  cardBtn("Comment").click(); await wait(5);
  ok("review: the confirm names the picked event", !!cardBtn("Confirm: comment as widgets-bot"));
  evSeg()[0].click(); await wait(5);
  ok("review: switching back drops the open confirm", !!cardBtn("Request changes") && !cardBtn("Confirm: comment as widgets-bot"));
  checks[1].click();
  cardBtn("Request changes").click(); await wait(5);
  calls = __calls.length;
  cardBtn("Confirm: request changes as widgets-bot").click(); await wait(20);
  ok("review sends the checked comment ids", JSON.stringify(__calls.at(-1).input.commentIds) === '["c1"]' && /Two small things/.test(__calls.at(-1).text));
  ok("review: an unchanged event is not sent", __calls.at(-1).input.event === undefined);
  items(F); await wait(10);
  await openItem("pr-9473");
  evSeg()[2].click(); await wait(5);
  cardBtn("Approve").click(); await wait(5);
  cardBtn("Confirm: approve as widgets-bot").click(); await wait(20);
  ok("review: a picked event goes to the server as input.event", __calls.at(-1).input.event === "approve" && __calls.at(-1).routeId === "r1");
  items(with_("pr-9473", (d) => ({ ...d, author: "widgets-bot", authorType: "bot" }))); await wait(10);
  await openItem("pr-9473");
  ok("review: the bot's own PR has no event switch", !expandedCard().querySelector(".review-event"));
  items(F); await wait(10);
  await openItem("pr-9473");
  ok("with a take_over covering every judged thread the list moves onto that card", document.getElementById("d-threads").hidden && cards()[3].querySelectorAll(".decisions > li").length === 2);
  calls = __calls.length;
  ok("merge in his name is a compact green row", cards()[1].classList.contains("compact") && cardBtn("Open GitHub to merge", cards()[1])?.classList.contains("intent-finish"));
  cardBtn("Open GitHub to merge", cards()[1]).click(); await wait(20);
  ok("merge never calls the server", window.__opened.at(-1) === "https://github.com/acme/widgets/pull/9473" && __calls.length === calls);
  ok("chore: a compact row with one button from its action", cards()[2].classList.contains("compact") && [...cards()[2].querySelectorAll(".card-actions button")].map((b) => b.textContent).join() === "Update branch");
  calls = __calls.length;
  cardBtn("Update branch", cards()[2]).click(); await wait(20);
  ok("chore runs without a confirm", __calls.length === calls + 1 && __calls.at(-1).routeId === "r3");
  await expand(3);
  ok("take_over replace shows its callout prominently and a teal button", openCard().querySelector(".callout.strong")?.textContent.includes("does not allow edits") && cardBtn("Open a replacement PR")?.classList.contains("intent-agent"));
  ok("take_over says the bot commits", /Commits as widgets-bot/.test(openCard().querySelector(".card-actions").textContent) && !!cardBtn("Open a replacement PR").querySelector(".actor-icon"));

  // address_review, approve, reopen as bot, take_over push
  await openItem("pr-9474");
  const dec = [...openCard().querySelectorAll(".decisions > li")];
  const pressed = (li) => li.querySelector('.seg[aria-pressed="true"]')?.textContent;
  ok("address_review lists the threads with verdict labels and prefilled switches", dec.length === 4 && dec.map(pressed).join() === "Fix,Dismiss,Dismiss,Fix"
    && dec.map((li) => li.querySelector(".vlabel").textContent).join() === "valid,not needed,optional,valid" && /1440 entries/.test(dec[0].textContent));
  ok("the chosen fix and dismiss sides are colored differently", getComputedStyle(dec[0].querySelector('.seg[data-v="fix"]')).backgroundColor !== getComputedStyle(dec[1].querySelector('.seg[data-v="dismiss"]')).backgroundColor
    && getComputedStyle(dec[0].querySelector('.seg[data-v="dismiss"]')).backgroundColor === "rgba(0, 0, 0, 0)");
  ok("threads list is replaced by the card", document.getElementById("d-threads").hidden);
  ok("address_review: the run note sits below the threads", !!(openCard().querySelector(".decisions").compareDocumentPosition(openCard().querySelector("textarea")) & Node.DOCUMENT_POSITION_FOLLOWING));
  ok("per-thread note stays hidden until asked", dec.every((li) => li.querySelector(".d-note").hidden));
  dec[2].querySelector('.seg[data-v="dismiss"]').click();
  dec[0].querySelector(".lane-switch").click(); await wait(5);
  const noteField = dec[0].querySelector(".d-note");
  noteField.value = "Cap it at 24 hours"; noteField.dispatchEvent(new Event("input"));
  openCard().querySelector("textarea").value = "Keep it small"; openCard().querySelector("textarea").dispatchEvent(new Event("input"));
  calls = __calls.length;
  cardBtn("Address the review").click(); await wait(20);
  const ar = __calls.at(-1);
  ok("address_review sends decisions and the overall note without a confirm", __calls.length === calls + 1 && ar.text === "Keep it small"
    && JSON.stringify(ar.input.decisions) === JSON.stringify([{ threadId: "t1", decision: "fix", note: "Cap it at 24 hours" }, { threadId: "t2", decision: "dismiss" }, { threadId: "t3", decision: "dismiss" }, { threadId: "t4", decision: "fix" }]));
  await expand(1);
  ok("approve review is green", cardBtn("Approve")?.classList.contains("intent-finish"));
  await expand(2);
  ok("reopen as bot: editable text and a Reopen button with the bot avatar", !!openCard().querySelector("textarea") && /widgets-bot/.test(cardBtn("Reopen")?.querySelector("img")?.src ?? cardBtn("Reopen")?.title ?? ""));
  cardBtn("Reopen").click(); await wait(5);
  calls = __calls.length;
  cardBtn("Confirm: post and reopen as widgets-bot").click(); await wait(20);
  ok("reopen with text confirms, then posts it", __calls.length === calls + 1 && __calls.at(-1).routeId === "r3" && /closed together with the stale PRs/.test(__calls.at(-1).text));
  await openItem("pr-9474");
  await expand(3);
  ok("take_over push says where the work goes", /Continues in the contributor's PR/.test(openCard().textContent) && !openCard().querySelector(".callout") && !!cardBtn("Take over"));

  // drive and the rounds summary
  await openItem("pr-9475");
  ok("rounds summary: open points visible, history folded", /timeout branch/.test(document.querySelector("#d-rounds .rounds-open").textContent) && !document.querySelector("#d-rounds details").open
    && /2 rounds by the agent · 3 fixed · 1 dismissed/.test(document.querySelector("#d-rounds summary").textContent) && /always set here/.test(document.querySelector("#d-rounds details").textContent));
  ok("rounds summary sits above the cards", !!(document.getElementById("d-rounds").compareDocumentPosition(document.getElementById("d-routes")) & Node.DOCUMENT_POSITION_FOLLOWING));
  ok("drive: explains itself and offers 1 to 3 rounds", /request a Copilot review, up to 3 rounds/.test(openCard().querySelector(".card-text").textContent) && [...openCard().querySelectorAll(".seg")].map((b) => b.textContent).join() === "1,2,3");
  [...openCard().querySelectorAll(".seg")][1].click(); await wait(5);
  ok("drive: the line follows the selector", /up to 2 rounds/.test(openCard().querySelector(".card-text").textContent));
  calls = __calls.length;
  cardBtn("Drive this PR").click(); await wait(20);
  ok("drive sends maxRounds without a confirm", __calls.length === calls + 1 && __calls.at(-1).input.maxRounds === 2 && cardBtn("Drive this PR") === undefined);
  ok("reopen as bot without text is a compact row", cards()[2].classList.contains("compact") && !!cardBtn("Reopen", cards()[2]));

  // discussion: escalate to an issue
  await openItem("disc-9476");
  ok("a compact recommended route leaves every card closed", !openCard() && cards()[0].classList.contains("compact"));
  calls = __calls.length;
  cardBtn("Copy escalate command, open GitHub", cards()[0]).click(); await wait(20);
  ok("escalate copies exactly the command and opens the discussion", window.__clip === "@widgets-bot escalate" && window.__opened.at(-1) === "https://github.com/acme/widgets/discussions/9476#issue-comment-box" && __calls.length === calls);
  ok("escalate shows his avatar", avatarOf(cardBtn("Copy again", cards()[0]), "octocat") && /^Copied and opened on GitHub/.test(cards()[0].querySelector(".status.opened").textContent));

  // issue to a discussion
  await openItem("issue-9477");
  calls = __calls.length;
  cardBtn("Open GitHub to convert", cards()[0]).click(); await wait(20);
  ok("move to a discussion opens the issue page, copies nothing", window.__opened.at(-1) === "https://github.com/acme/widgets/issues/9477" && __calls.length === calls && window.__clip === "@widgets-bot escalate");
  ok("react chore shows its emoji", !!cardBtn("👍 React", cards()[2]));

  // The opened mark from the server's route field
  localOpened.clear();
  items(routeMap("issue-9471", "r1", (r) => ({ ...r, opened: { at: new Date().toISOString() } }))); await wait(10);
  await openItem("issue-9471");
  ok("a card the server marks as opened starts collapsed with its confirmation", !expandedCard() && /^Copied and opened, \d\d:\d\d$/.test(hd0().textContent) && !hd0().hidden);
  await expand(0);
  ok("the opened mark comes from the server's route field", /^Copied and opened on GitHub, \d\d:\d\d$/.test(openCard().querySelector(".status.opened")?.textContent ?? "") && !!cardBtn("Copy again"));
  items(F); await wait(10);
  ok("a route the server no longer marks is plain again", !openCard().querySelector(".status.opened") && !!cardBtn("Copy reply, open GitHub") && hd0().hidden && !cards()[0].classList.contains("settled") && !cards()[0].querySelector(".card-x").hidden);

  // done state from the server and draft persistence
  items(routeMap("issue-9471", "r3", (r) => ({ ...r, done: { status: "done", result: "https://github.com/acme/widgets/pull/999" } }))); await wait(10);
  await openItem("issue-9471");
  const hd2 = cards()[2].querySelector(".card-top > .head-done");
  ok("on a fresh open a done route is collapsed, the recommended one is open", expandedCard() === cards()[0] && !cards()[2].classList.contains("open") && cards()[2].classList.contains("settled"));
  ok("the done row carries its confirmation and the link inline", !hd2.hidden && /^The agent took this on·view on GitHub$/.test(hd2.textContent.replace(/\s/g, (c) => (c === " " ? " " : ""))) && hd2.querySelector("a")?.href.endsWith("/pull/999") && hd2.querySelector("a").target === "_blank" && cards()[2].querySelector(".card-x").hidden);
  ok("route draft persists in this browser", openCard().querySelector("textarea").value === "A PR is welcome! Edited." && /A PR is welcome! Edited\./.test(localStorage.getItem("gary:widgets:drafts") || ""));

  await expand(2);
  ok("an expanded done card shows what was sent, read-only", expandedCard() === cards()[2] && /The agent took this on/.test(cards()[2].querySelector(".card-actions").textContent) && cards()[2].querySelector(".card-actions a")?.href.endsWith("/pull/999") && [...cards()[2].querySelectorAll(".card-body textarea, .card-body input")].every((el) => el.disabled) && hd2.hidden);
  await expand(2);

  // Analyze again lives in the footer and opens a note panel
  const foot = document.getElementById("d-foot");
  const analyzeBtn = foot.querySelector(".foot-analyze");
  ok("Analyze again is a quiet footer action next to Snooze", !!analyzeBtn && !analyzeBtn.classList.contains("primary") && !document.querySelector(".d-body #z-agent") && document.getElementById("d-analyze").hidden);
  analyzeBtn.click(); await wait(5);
  const panel = document.getElementById("d-analyze");
  const note = panel.querySelector("textarea");
  ok("a click reveals a full-width note and a send button", !panel.hidden && note.rows >= 3 && note.getBoundingClientRect().width > panel.getBoundingClientRect().width - 60 && /instructions/i.test(note.placeholder)
    && [...panel.querySelectorAll("button")].map((b) => b.textContent).join() === "Send to the agent,Cancel");
  {
    const before = __writes.length;
    [...panel.querySelectorAll("button")][0].click(); await wait(20);
    const w = __writes.slice(before).filter((x) => x[1].startsWith("actions/"));
    ok("Analyze again without a note queues one reanalyze doc", w.length === 1 && w[0][2].action === "reanalyze" && w[0][2].status === "queued" && w[0][2].text === "");
    ok("the panel closes after sending", panel.hidden);
  }
  document.getElementById("d-close").click(); await wait(5);

  // a repeated agent click finds the first request in the queue
  items(routeMap("issue-9471", "r3", (r) => ({ ...r, draftHash: "h3b" }))); await wait(10);
  await openItem("issue-9471");
  await expand(2);
  window.__reply = () => ({ ok: false, result: "This route already ran. The board shows its result.", duplicate: true });
  cardBtn("Start fix").click(); await wait(20);
  ok("409 on an agent route shows already requested", /Already requested/.test(openCard().textContent));
  window.__reply = () => ({ ok: true, result: { dryRun: true } });
  items(routeMap("issue-9471", "r3", (r) => ({ ...r, done: { status: "queued", result: "" } }))); await wait(10);
  ok("a queued agent route reads as requested", /Requested\. The agent has it on its list\./.test(cards()[2].textContent));
  document.getElementById("d-close").click(); await wait(5);

  // take_over on a contributor's PR carries the judged threads
  await openItem("pr-9480");
  const toDec = [...openCard().querySelectorAll(".decisions > li")];
  ok("take_over with judged threads lists them with verdicts and switches", openCard().classList.contains("intent-agent") && toDec.length === 2
    && toDec.map((li) => li.querySelector(".vlabel").textContent).join() === "valid,not needed" && toDec.map((li) => li.querySelector('.seg[aria-pressed="true"]').textContent).join() === "Fix,Dismiss");
  ok("the threads sit above the instructions, the separate list is gone", !!(openCard().querySelector(".decisions").compareDocumentPosition(openCard().querySelector("textarea")) & Node.DOCUMENT_POSITION_FOLLOWING) && document.getElementById("d-threads").hidden);
  ok("take_over keeps where the work goes and who commits", /Continues in the contributor's PR/.test(openCard().textContent) && /Commits as widgets-bot/.test(openCard().textContent));
  toDec[1].querySelector('.seg[data-v="fix"]').click();
  toDec[0].querySelector(".lane-switch").click(); await wait(5);
  toDec[0].querySelector(".d-note").value = "Keep the old name as an alias"; toDec[0].querySelector(".d-note").dispatchEvent(new Event("input"));
  calls = __calls.length;
  cardBtn("Take over").click(); await wait(20);
  ok("take_over sends the decisions", __calls.length === calls + 1 && JSON.stringify(__calls.at(-1).input.decisions) === JSON.stringify([{ threadId: "t1", decision: "fix", note: "Keep the old name as an alias" }, { threadId: "t2", decision: "fix" }]));
  items(with_("pr-9480", (d) => ({ ...d, threads: [] }))); await wait(10);
  await openItem("pr-9480");
  calls = __calls.length;
  ok("take_over without threads has no thread list", !openCard().querySelector(".decisions") && /Continues in the contributor's PR/.test(openCard().textContent));
  cardBtn("Take over").click(); await wait(20);
  ok("take_over without threads sends no decisions", __calls.at(-1).input.decisions === undefined);
  items(F); await wait(10);

  // The switch that lets a fix ask the reporter to test
  items(routeMap("issue-9472", "r3", (r) => ({ ...r, type: "follow_up", as: "agent", actor: "agent", title: "Start fix: the dimmer file", text: "Add the config file.", params: {} }))); await wait(10);
  await openItem("issue-9472");
  await expand(2);
  const ask = () => expandedCard().querySelector(".ask-reporter input");
  ok("fix card: a switch to ask the reporter to test, off by default and without a reason", !!ask() && !ask().checked && expandedCard().querySelector(".ask-reporter").textContent === "Ask the reporter to test" && !expandedCard().querySelector(".ask-reporter-why"));
  ask().click();
  calls = __calls.length;
  cardBtn("Start fix").click(); await wait(20);
  ok("fix card: the switch goes to the server as input.askReporter", __calls.length === calls + 1 && __calls.at(-1).input.askReporter === true);
  document.getElementById("d-close").click(); await wait(5);
  items(routeMap("issue-9472", "r3", (r) => ({ ...r, type: "follow_up", as: "agent", actor: "agent", title: "Start fix: the dimmer file", text: "Add the config file.", draftHash: "hx", params: { askReporter: true, askReporterWhy: "Only the reporter has this device revision." } }))); await wait(10);
  await openItem("issue-9472");
  await expand(2);
  ok("fix card: the agent's preset turns the switch on and shows why", ask().checked && expandedCard().querySelector(".ask-reporter-why")?.textContent === "Only the reporter has this device revision.");
  ask().click();
  cardBtn("Start fix").click(); await wait(20);
  ok("fix card: he can turn a preset off", __calls.at(-1).input.askReporter === false);
  document.getElementById("d-close").click(); await wait(5);
  items(F); await wait(10);

  // revise on a PR we already control: instructions and a button, no threads on the card
  const reviseItem = (text) => with_("pr-9475", (d) => ({
    ...d, hint: "Change: drop the 0x00c8 file",
    threads: [{ id: "t1", author: "copilot-pull-request-reviewer", path: "src/restore.ts", line: 12, summary: "Guard the empty list.", verdict: "valid" }],
    routes: [{ id: "r1", type: "revise", as: "agent", title: "Change: drop the 0x00c8 file", text, recommended: true, draftHash: "hr" }, d.routes[1]],
  }));
  document.getElementById("d-close").click(); await wait(5);
  items(reviseItem("Drop the 0x00c8 file, the 0x00c9 file covers both.")); await wait(10);
  ok("revise: the row says Change with the agent's proposal", (() => { const hint = document.querySelector('.row[data-id="pr-9475"] .r-hint'); return hint?.querySelector(".h-act").textContent === "Change" && hint.classList.contains("act-agent") && /: drop the 0x00c8 file$/.test(hint.textContent); })());
  await openItem("pr-9475");
  ok("revise: an agent card with the proposal in the instructions field", openCard().classList.contains("intent-agent") && openCard().querySelector("textarea").value === "Drop the 0x00c8 file, the 0x00c9 file covers both."
    && openCard().querySelector(".card-label").textContent === "Instructions for the agent");
  ok("revise: the button says Change and the quiet line names who commits", !!cardBtn("Change") && cardBtn("Change").classList.contains("intent-agent") && /Commits as widgets-bot/.test(openCard().querySelector(".card-actions").textContent));
  ok("revise: the quiet line says what follows the push", /Then Gary reviews the new head/.test(openCard().querySelector(".card-actions").textContent));
  ok("revise: no take-over wording and no thread list on the card", !/Continues in the contributor's PR/.test(openCard().textContent) && !/Take over/.test(openCard().textContent) && !openCard().querySelector(".decisions"));
  ok("revise: the open threads keep their own list", !document.getElementById("d-threads").hidden && /Guard the empty list/.test(document.getElementById("d-threads").textContent));
  openCard().querySelector("textarea").value = "  "; openCard().querySelector("textarea").dispatchEvent(new Event("input"));
  calls = __calls.length;
  cardBtn("Change").click(); await wait(20);
  ok("revise: empty instructions are not sent", __calls.length === calls && /Write the instructions first/.test(openCard().textContent));
  openCard().querySelector("textarea").value = "Drop the 0x00c8 file only."; openCard().querySelector("textarea").dispatchEvent(new Event("input"));
  cardBtn("Change").click(); await wait(20);
  ok("revise sends the edited instructions without decisions and without a confirm", __calls.length === calls + 1 && __calls.at(-1).routeId === "r1" && __calls.at(-1).text === "Drop the 0x00c8 file only." && __calls.at(-1).input.decisions === undefined);
  document.getElementById("d-close").click(); await wait(5);
  items(F); await wait(10);
  document.getElementById("d-close").click(); await wait(5);

  // "Not this": dismissing a suggestion
  await openItem("issue-9471");
  ok("every card has a quiet dismiss control", cards().every((c) => !!c.querySelector(".card-x")) && !cards()[0].querySelector(".card-x").classList.contains("btn"));
  ok("the dismiss box is hidden until asked", cards().every((c) => c.querySelector(".dismiss-box").hidden));
  cards()[2].querySelector(".card-x").click(); await wait(5);
  const dbox = cards()[2].querySelector(".dismiss-box");
  ok("a collapsed card's x reveals the reason field without expanding", !dbox.hidden && cards()[2].querySelector(".card-body").hidden && dbox.querySelector("input").placeholder === "Why not? (optional)"
    && [...dbox.querySelectorAll("button")].map((b) => b.textContent).join() === "Dismiss suggestion,Cancel");
  [...dbox.querySelectorAll("button")][1].click(); await wait(5);
  ok("Cancel hides it again", dbox.hidden);
  cards()[1].querySelector(".card-x").click(); await wait(5);
  ok("compact rows have the control too", !cards()[1].querySelector(".dismiss-box").hidden);
  const why = cards()[1].querySelector(".dismiss-box input");
  why.value = "The reporter still sees it on 15.4"; why.dispatchEvent(new Event("input"));
  calls = __calls.length;
  [...cards()[1].querySelectorAll(".dismiss-box button")][0].click(); await wait(20);
  const dr = __calls.at(-1);
  ok("Dismiss suggestion calls dismiss_route with the reason", __calls.length === calls + 1 && dr.tool === "dismiss_route" && dr.itemId === "issue-9471" && dr.routeId === "r2" && dr.text === "The reporter still sees it on 15.4");
  ok("the dismissed card disappears at once", cards().length === 3 && !cards().some((c) => /restore fixed it/.test(c.textContent)));
  items(with_("issue-9471", (d) => ({ ...d, routes: d.routes.filter((r) => r.id !== "r2") }))); await wait(10);
  ok("the server's update keeps the remaining cards", cards().length === 3);
  window.__reply = () => ({ ok: false, result: "The board is out of date, reload it." });
  cards()[0].querySelector(".card-x").click(); await wait(5);
  [...cards()[0].querySelectorAll(".dismiss-box button")][0].click(); await wait(20);
  ok("a refused dismissal keeps the card and says why", cards().length === 3 && /out of date/.test(cards()[0].textContent));
  window.__reply = () => ({ ok: true, result: { dryRun: true } });
  // The last route: the dialog says what happens before the item leaves the board
  const single = with_("issue-9477", (d) => ({ ...d, routes: [d.routes[0]] }));
  items(single); await wait(10);
  await openItem("issue-9477");
  cards()[0].querySelector(".card-x").click(); await wait(5);
  [...cards()[0].querySelectorAll(".dismiss-box button")][0].click(); await wait(20);
  ok("after the last route the dialog shows the farewell line", /Suggestion dismissed\. The agent will propose something else\./.test(document.getElementById("d-routes").textContent) && dlgR.open);
  items(single.filter(([id]) => id !== "issue-9477").concat([["issue-9477", { ...single.find(([id]) => id === "issue-9477")[1], routes: [] }]])); await wait(20);
  ok("the line stays while the item drops off the board", dlgR.open && /Suggestion dismissed/.test(document.getElementById("d-routes").textContent) && !document.querySelector('.row[data-id="issue-9477"]'));
  await wait(2600);
  ok("then the dialog closes", !dlgR.open);
  items(F); await wait(10);

  // Learning: prefill clicks report the decision, proposals live in their own dialog
  const learnBtn = document.getElementById("learn");
  ok("no proposals: the header shows no lightbulb", learnBtn.hidden);
  await openItem("issue-9471");
  const decTa = openCard().querySelector("textarea");
  decTa.value = "A PR is welcome, the check goes in getNodeProtocolInfo()."; decTa.dispatchEvent(new Event("input"));
  const nDec = window.__decisions.length;
  cardBtn("Copy reply, open GitHub").click(); await wait(20);
  ok("a prefill click posts the decision with the textarea's text", window.__decisions.length === nDec + 1 && JSON.stringify(window.__decisions.at(-1)) === JSON.stringify({ instance: "widgets", itemId: "issue-9471", routeId: "r1", text: "A PR is welcome, the check goes in getNodeProtocolInfo()." }));
  window.__decisionFails = true;
  const opened = window.__opened.length;
  cardBtn("Open GitHub to close", cards()[1]).click(); await wait(20);
  ok("a failing decision post does not block the copy and open, and shows no error", window.__opened.length === opened + 1 && window.__decisions.at(-1).text === "" && window.__decisions.at(-1).routeId === "r2"
    && !document.querySelector("#d-routes .status.failed") && !/fail/i.test(document.getElementById("d-foot").textContent));
  window.__decisionFails = false;
  calls = __calls.length;
  await expand(2);
  cardBtn("Start fix").click(); await wait(20);
  ok("bot and agent routes post no decision", window.__decisions.length === nDec + 2);
  document.getElementById("d-close").click(); await wait(5);
  items(F); await wait(10);
  const P = window.makeProposalFixtures(iso);
  const planBefore = document.querySelector("#plan .sum")?.textContent;
  window.__subs["proposals"](__mkSnap(P)); await wait(10);
  ok("proposals show a lightbulb with their count", !learnBtn.hidden && learnBtn.textContent === "2" && learnBtn.getAttribute("aria-label") === "2 suggestions");
  ok("proposals stay out of the plan and the budget", document.querySelector("#plan .sum")?.textContent === planBefore && !document.querySelector('#board .row[data-id="p1"]'));
  learnBtn.click(); await wait(10);
  const ldlg = document.getElementById("learn-dialog");
  const pcards = () => [...ldlg.querySelectorAll(".pcard")];
  ok("rule proposals keep their heading and intro, and no settings group shows", !document.getElementById("learn-rules").hidden && document.getElementById("learn-settings").hidden
    && document.getElementById("learn-rules-title").textContent === "What your decisions suggest" && /^You decided differently from the agent more than once\. Add a rule/.test(document.querySelector("#learn-rules .learn-intro").textContent)
    && document.getElementById("learn-title").textContent === "Suggestions");
  ok("the dialog lists the proposals as cards", ldlg.open && pcards().length === 2 && /closing feature requests/.test(pcards()[0].textContent) && /invited yourself/.test(pcards()[0].querySelector(".card-why").textContent));
  ok("evidence is collapsed and counted", !pcards()[0].querySelector("details").open && pcards()[0].querySelector("summary").textContent === "Based on 3 decisions" && pcards()[1].querySelector("summary").textContent === "Based on 4 decisions");
  ok("where the rule goes", /Adds to rules\/classification\.md under “Feature requests” in the project profile/.test(pcards()[0].textContent) && /Adds to your personal rules under “Voice”/.test(pcards()[1].textContent));
  ok("an evidence line links to an item still on the board, others stay plain", !!pcards()[0].querySelector("li .ev-link") && pcards()[0].querySelectorAll("li .ev-link").length === 1 && pcards()[0].querySelectorAll("li .ev-ref").length === 2);
  const ruleTa = pcards()[0].querySelector("textarea");
  ok("the rule text is editable and the buttons are Add rule and Not this", /Never suggest closing/.test(ruleTa.value) && [...pcards()[0].querySelectorAll(".card-actions button")].map((b) => b.textContent).join() === "Add rule,Not this"
    && pcards()[0].querySelector(".card-actions .btn").classList.contains("intent-think"));
  ruleTa.value = "Never suggest closing a feature request a maintainer asked for."; ruleTa.dispatchEvent(new Event("input"));
  calls = __calls.length;
  [...pcards()[0].querySelectorAll(".card-actions button")][0].click(); await wait(20);
  ok("Add rule sends accept_proposal with the edited text", __calls.length === calls + 1 && __calls.at(-1).tool === "accept_proposal" && __calls.at(-1).proposalId === "p1" && __calls.at(-1).text === "Never suggest closing a feature request a maintainer asked for.");
  ok("the card then says where it went", /Added to rules\/classification\.md/.test(pcards()[0].textContent) && learnBtn.textContent === "1");
  window.__subs["proposals"](__mkSnap(P.slice(1))); await wait(10);
  ok("the accepted card stays when the server stops serving it", pcards().length === 2 && /Added to rules\/classification\.md/.test(pcards()[0].textContent));
  [...pcards()[1].querySelectorAll(".card-actions button")][1].click(); await wait(5);
  const pwhy = pcards()[1].querySelector(".dismiss-box input");
  ok("Not this reveals an optional reason", !pcards()[1].querySelector(".dismiss-box").hidden && pwhy.placeholder === "Why not? (optional)");
  pwhy.value = "I like the thanks in bug reports"; pwhy.dispatchEvent(new Event("input"));
  calls = __calls.length;
  [...pcards()[1].querySelectorAll(".dismiss-box button")][0].click(); await wait(20);
  ok("Not this sends dismiss_proposal with the reason and the card disappears", __calls.at(-1).tool === "dismiss_proposal" && __calls.at(-1).proposalId === "p2" && __calls.at(-1).text === "I like the thanks in bug reports" && pcards().length === 1);
  document.getElementById("learn-close").click(); await wait(10);
  ok("after closing, the lightbulb hides when nothing is left", learnBtn.hidden);
  window.__subs["proposals"](__mkSnap([["p3", { ...P[1][1], title: "Link the troubleshooting page in every log request" }]])); await wait(10);
  window.__reply = () => ({ ok: false, result: "The proposal is gone." });
  learnBtn.click(); await wait(10);
  [...pcards()[0].querySelectorAll(".card-actions button")][0].click();
  for (let i = 0; i < 50 && !/The proposal is gone/.test(pcards()[0]?.textContent ?? ""); i++) await wait(20);
  ok("a refused action shows its reason on the card", /The proposal is gone/.test(pcards()[0].textContent));
  window.__reply = () => ({ ok: true, result: { dryRun: true } });
  pcards()[0].querySelector("details").open = true;
  learn.gone.clear();
  window.__subs["proposals"](__mkSnap(P)); await wait(10);
  pcards()[0].querySelector("details").open = true;
  // The proposals snapshot may still re-render the list, which replaces a link clicked too early. Click the current one
  for (let i = 0; i < 20 && !(!ldlg.open && dlgR.open && detail.id === "issue-9471"); i++) {
    pcards()[0]?.querySelector(".ev-link")?.click();
    await wait(25);
  }
  ok("an evidence link opens the item's dialog", !ldlg.open && dlgR.open && detail.id === "issue-9471");
  document.getElementById("d-close").click(); await wait(5);
  window.__subs["proposals"](__mkSnap([])); await wait(5);

  // Only valid threads start on Fix
  await openItem("pr-9474");
  ok("optional, not needed and not judged threads start on Dismiss", (() => {
    const lis = [...openCard().querySelectorAll(".decisions > li")];
    return lis.every((li) => li.querySelector('.seg[aria-pressed="true"]').textContent === (li.querySelector(".vlabel").textContent === "valid" ? "Fix" : "Dismiss"));
  })());
  items(with_("pr-9474", (d) => ({ ...d, threads: [...d.threads, { id: "t5", author: "someone", path: "x.ts", summary: "Unjudged one" }] }))); await wait(10);
  await openItem("pr-9474");
  ok("an unjudged thread starts on Dismiss", [...openCard().querySelectorAll(".decisions > li")].at(-1).querySelector('.seg[aria-pressed="true"]').textContent === "Dismiss");
  items(F); await wait(10);

  // Items the agent could not analyze: one "open" route and a notice
  await openItem("issue-9481");
  ok("blocked: a compact Open on GitHub row with his avatar and no dismiss", cards().length === 1 && cards()[0].classList.contains("compact") && cards()[0].classList.contains("intent-away")
    && avatarOf(cardBtn("Open on GitHub", cards()[0]), "octocat") && !cards()[0].querySelector(".card-x") && /Read it yourself/.test(cards()[0].textContent));
  ok("blocked: the notice names the safety filter", /triggered the model's safety filter/.test(document.querySelector("#d-routes .blocked-note")?.textContent ?? "")
    && !!(document.querySelector("#d-routes .blocked-note").compareDocumentPosition(cards()[0]) & Node.DOCUMENT_POSITION_FOLLOWING));
  calls = __calls.length;
  const nDecOpen = window.__decisions.length;
  cardBtn("Open on GitHub", cards()[0]).click(); await wait(20);
  ok("Open on GitHub opens the plain thread URL and never calls the server", window.__opened.at(-1) === "https://github.com/acme/widgets/issues/9481" && __calls.length === calls && window.__decisions.length === nDecOpen + 1);
  ok("blocked: Analyze again stays in the footer", !!document.querySelector("#d-foot .foot-analyze") && !document.querySelector("#d-foot .foot-analyze").disabled);
  await openItem("issue-9482");
  ok("blocked after three tries says so", /could not analyze this after three tries/.test(document.querySelector("#d-routes .blocked-note")?.textContent ?? ""));
  document.getElementById("d-close").click(); await wait(5);
  for (let i = 0; i < 4; i++) for (const b of document.querySelectorAll(".show-all")) if (!b.hidden && !/less/i.test(b.textContent)) b.click();
  await wait(5);
  // Opening it on GitHub marked it handled; for this check it belongs on the list
  localHandled.delete("issue-9481"); render(); await wait(5);
  for (let i = 0; i < 4; i++) for (const b of document.querySelectorAll(".show-all")) if (!b.hidden && !/less/i.test(b.textContent)) b.click();
  await wait(5);
  ok("the list row shows a quiet not-analyzed icon", !!document.querySelector('.row[data-id="issue-9481"] .r-meta svg[aria-label="Not analyzed by the agent"]') && !document.querySelector('.row[data-id="issue-9471"] .r-meta svg[aria-label="Not analyzed by the agent"]'));

  // Paused: the header says so live, server writes are refused calmly
  const pausedEl = document.getElementById("paused");
  ok("not paused: no marker", pausedEl.hidden);
  window.__board.instances[0].paused = true; window.dispatchEvent(new Event("board:info")); await wait(10);
  ok("paused: the header shows a calm marker with the resume hint", !pausedEl.hidden && pausedEl.textContent === "Paused" && /gary resume/.test(pausedEl.title));
  await openItem("issue-9472");
  ok("paused: bot buttons carry a small paused hint and stay clickable", /paused/.test(openCard().querySelector(".card-actions .paused-hint")?.textContent ?? "") && !cardBtn("Ask for a debug log").disabled);
  window.__reply = (b) => (b.tool === "request_logs" ? { ok: false, result: "Gary is paused. Nothing was sent.", paused: true } : { ok: true, result: { dryRun: true } });
  cardBtn("Ask for a debug log").click(); await wait(5);
  cardBtn("Confirm: ask for a debug log as widgets-bot").click(); await wait(20);
  ok("paused: the refusal shows as information, not as an error", /Gary is paused\. Nothing was sent\./.test(openCard().querySelector(".status.info")?.textContent ?? "") && !openCard().querySelector(".status.failed"));
  await expand(3);
  ok("paused: prefill buttons have no paused hint", !openCard().querySelector(".paused-hint"));
  await openItem("issue-9471");
  await expand(2);
  ok("paused: agent routes have no paused hint", !openCard().querySelector(".paused-hint") && !!cardBtn("Start fix"));
  window.__reply = () => ({ ok: true, result: { dryRun: true } });
  window.__board.instances[0].paused = false; window.dispatchEvent(new Event("board:info")); await wait(10);
  await openItem("issue-9472");
  ok("resumed: the marker and the hints go away without a reload", pausedEl.hidden && !document.querySelector("#d-routes .paused-hint"));
  document.getElementById("d-close").click(); await wait(5);

  // A smaller model did the analysis
  const FALLBACK = "The full analysis was stopped by the safety filter. Code-level conclusions need your check.";
  await openItem("issue-9483");
  ok("fallback: a quiet Fallback model badge in the meta row with the tooltip", [...document.querySelectorAll("#d-meta .sbadge")].some((b) => b.textContent === "Fallback model" && b.title === FALLBACK && b.classList.contains("tone-muted")));
  await openItem("issue-9471");
  ok("no badge without analyzedBy", ![...document.querySelectorAll("#d-meta .sbadge")].some((b) => b.textContent === "Fallback model"));
  document.getElementById("d-close").click(); await wait(5);
  for (let i = 0; i < 4; i++) for (const b of document.querySelectorAll(".show-all")) if (!b.hidden && !/less/i.test(b.textContent)) b.click();
  await wait(5);
  ok("fallback: the list row shows a quiet icon with the same tooltip", !!document.querySelector('.row[data-id="issue-9483"] .r-meta svg[aria-label="' + FALLBACK + '"]') && !document.querySelector('.row[data-id="issue-9471"] .r-meta svg[aria-label="' + FALLBACK + '"]'));

  // Review suggestions render as diffs
  {
    const hdr = "@@ -10,6 +10,6 @@ export function parse(input) {\n \tconst parts = input.split(\",\");\n \tconst out = [];\n \tfor (const p of parts) {\n-\t\tout.push(p);\n+\t\tout.push(p.trim());\n \t}\n \treturn out;";
    const noHdr = " \tconst parts = input.split(\",\");\n \tconst out = [];\n \tfor (const p of parts) {\n+\t\tout.push(p.trim());\n \t}\n \treturn out;";
    items([...F, ["pr-9490", { kind: "pr", number: 9490, title: "Trim parsed parts", url: "https://github.com/acme/widgets/pull/9490", author: "someone", authorType: "contributor", section: "easy", effortMinutes: 5, priority: 1, updatedAt: iso(1000), reviewDepth: "full",
      routes: [{ id: "r1", type: "review", as: "bot", title: "Request changes: three suggestions", recommended: true, draftHash: "h1", text: "Three small things.", params: { event: "request_changes", comments: [
        { id: "e1", path: "src/parse.ts", line: 13, startLine: 13, text: "Trim before pushing.", original: "\t\tout.push(p.trim());", suggestion: "\t\tout.push(p.trim().toLowerCase());", diffHunk: hdr },
        { id: "e2", path: "src/parse.ts", line: 13, text: "Lower-case it too.\n```suggestion\n\t\tout.push(p.trim().toLowerCase());\n```", diffHunk: hdr },
        { id: "e3", path: "src/parse.ts", line: 13, text: "Same here.\n```suggestion\n\t\tout.push(p.trim().toLowerCase());\n```", diffHunk: noHdr },
      ] } }] }]]); await wait(10);
    await openItem("pr-9490");
    const bodies = [...openCard().querySelectorAll(".checklist .c-body")];
    const rows = (b) => [...b.querySelectorAll(".hunk span")].map((s) => s.className + ":" + s.textContent.trimEnd());
    ok("explicit fields: original red, suggestion green, hunk lines above as dimmed context, prose without a fence",
      rows(bodies[0]).join("|") === ["h-ctx: \tconst parts = input.split(\",\");", "h-ctx: \tconst out = [];", "h-ctx: \tfor (const p of parts) {", "h-del:-\t\tout.push(p.trim());", "h-add:+\t\tout.push(p.trim().toLowerCase());"].join("|")
      && bodies[0].querySelector(".c-text").textContent === "Trim before pushing." && !/```/.test(bodies[0].textContent));
    ok("fenced fallback: the commented line red, the replacement green, context around it", rows(bodies[1]).includes("h-del:-\t\tout.push(p.trim());") && rows(bodies[1]).includes("h-add:+\t\tout.push(p.trim().toLowerCase());")
      && rows(bodies[1]).filter((r) => r.startsWith("h-ctx")).length >= 2 && bodies[1].querySelector(".c-text").textContent === "Lower-case it too." && !bodies[1].querySelector("code.ic"));
    ok("a hunk without a header still shows the replacement as an addition", rows(bodies[2]).some((r) => r === "h-add:+\t\tout.push(p.trim().toLowerCase());") && !/```/.test(bodies[2].textContent));
    ok("context lines are muted", getComputedStyle(bodies[0].querySelector(".hunk .h-ctx")).color !== getComputedStyle(bodies[0].querySelector(".hunk .h-add")).color);
    items(F); await wait(10);
  }

  // The rounds selector: label and buttons share one vertical center
  await openItem("pr-9475");
  {
    const row = [...openCard().querySelectorAll(".seg-row")].find((r) => /Rounds/.test(r.textContent));
    const mid = (el) => { const b = el.getBoundingClientRect(); return b.top + b.height / 2; };
    const label = row.querySelector(".card-label"), group = row.querySelector(".seg-group");
    ok("rounds row: label and buttons centered within 1px", Math.abs(mid(label) - mid(group)) <= 1 && [...group.querySelectorAll(".seg")].every((s) => Math.abs(mid(s) - mid(group)) <= 1));
  }
  document.getElementById("d-close").click(); await wait(5);

  // Format: a compact agent row that does not take over the PR
  await openItem("pr-9484");
  const fmt = cards()[0];
  ok("format: a compact teal row titled by the route with Format & fix lint", fmt.classList.contains("compact") && fmt.classList.contains("intent-agent") && /Format: fix formatting and lint/.test(fmt.querySelector(".card-head").textContent)
    && !!cardBtn("Format & fix lint", fmt)?.querySelector(".actor-icon") && cardBtn("Format & fix lint", fmt).classList.contains("intent-agent"));
  ok("format: the quiet line names the bot and keeps the PR with the contributor", fmt.querySelector(".compact-note")?.textContent === "Commits as widgets-bot. Does not take over the PR.");
  calls = __calls.length;
  cardBtn("Format & fix lint", fmt).click(); await wait(20);
  ok("format: queues without a confirm", __calls.length === calls + 1 && __calls.at(-1).tool === "format" && __calls.at(-1).itemId === "pr-9484");
  items(routeMap("pr-9484", "r1", (r) => ({ ...r, done: { status: "queued", result: "" } }))); await wait(10);
  ok("format: reads as requested afterwards", /Requested\. The agent has it on its list\./.test(cards()[0].textContent));
  items(F); await wait(10);
  // Autofix badge
  await openItem("pr-9484");
  const af = [...document.querySelectorAll("#d-meta .sbadge")].find((b) => /^Autofix/.test(b.textContent));
  ok("autofix: a quiet badge with files and the tooltip with files and lines", af?.textContent === "Autofix: 3 files" && af.title === "The formatter and lint autofix would change 3 files, 41 lines." && af.classList.contains("tone-muted"));
  await openItem("pr-9485");
  ok("autofix: nothing when it would change nothing", ![...document.querySelectorAll("#d-meta .sbadge")].some((b) => /Autofix/.test(b.textContent)));
  await openItem("pr-9473");
  ok("autofix: nothing when absent", ![...document.querySelectorAll("#d-meta .sbadge")].some((b) => /Autofix/.test(b.textContent)));
  document.getElementById("d-close").click(); await wait(5);
  for (let i = 0; i < 4; i++) for (const b of document.querySelectorAll(".show-all")) if (!b.hidden && !/less/i.test(b.textContent)) b.click();
  await wait(5);
  ok("autofix: no list row icon", !!document.querySelector('.row[data-id="pr-9484"]') && ![...document.querySelectorAll('.row[data-id="pr-9484"] .r-meta svg')].some((s) => /autofix/i.test(s.getAttribute("aria-label") || "")));
  state.reveal.clear(); render();
  // A posted analysis gets a tall editor
  await openItem("issue-9486");
  const pa = openCard().querySelector("textarea");
  ok("post analysis: a tall, resizable editor of about 12 rows", pa.rows === 12 && pa.getBoundingClientRect().height >= 280 && getComputedStyle(pa).resize === "vertical" && /What we change/.test(pa.value));
  document.getElementById("d-close").click(); await wait(5);

  // ---------- accounts and projects come from the server ----------
  const acct = (login) => ({ login, avatarUrl: "https://github.com/" + login + ".png?size=80" });
  const ZW = window.__board;
  ok("title and storage come from the board info", document.getElementById("board-title").textContent === "widgets triage" && document.title === "widgets triage" && document.getElementById("dry-run").hidden);
  // What the server sends per route for an account mode: "none" has no bot, "own" runs bot routes under his login
  const PUSHING = new Set(["address_review", "take_over", "revise", "drive", "follow_up"]);
  const PREFILL = new Set(["reply", "request_logs", "reopen", "follow_up"]);
  const served = (mode) => F.map(([id, d]) => [id, { ...d, routes: d.routes.map((r) => {
    const as = r.as;
    if (as === "agent") return { ...r, actor: mode === "none" && PUSHING.has(r.type) ? "unavailable" : "agent" };
    if (as === "me") return { ...r, actor: "me" };
    if (r.type === "move") return { ...r, actor: mode === "own" ? "own" : "unavailable", actors: { transfer: mode === "own" ? "own" : "unavailable", close: "me" } };
    const comments = Array.isArray(r.params?.comments) ? r.params.comments : [];
    if (PREFILL.has(r.type) || (r.type === "review" && !comments.length)) return { ...r, actor: "me" };
    return { ...r, actor: mode === "own" ? "own" : "unavailable" };
  }) }]);

  // A second project without a bot
  const OLD = ["triage", "board"].join("-") + ":contoso/gadgets:drafts";
  localStorage.setItem(OLD, JSON.stringify({ "x|r1|h": "legacy" }));
  const gadgetsOnly = (accountMode, dryRun) => ({ me: acct("jdoe"), dryRun, instances: [window.__instanceInfo("gadgets", "contoso-gadgets", { bot: null, accountMode, botCommands: {}, relatedRepos: ["widgets-desktop"] })] });
  applyBoardInfo(gadgetsOnly("none", true));
  ok("a second project names the page and shows the dry run marker", document.getElementById("board-title").textContent === "contoso-gadgets triage" && !document.getElementById("dry-run").hidden);
  ok("per-repo keys move to the instance's keys once", localStorage.getItem(OLD) === null && /legacy/.test(localStorage.getItem("gary:gadgets:drafts") || ""));
  items(served("none")); await wait(10);
  await openItem("issue-9472");
  ok("no bot: request_logs is a prefill with his avatar", !!cardBtn("Copy request, open GitHub") && /jdoe/.test(cardBtn("Copy request, open GitHub").querySelector("img")?.src ?? "") && !!openCard().querySelector("textarea.tall"));
  calls = __calls.length;
  cardBtn("Copy request, open GitHub").click(); await wait(20);
  ok("no bot: the prefill copies and opens GitHub, never the server", /loglevel `debug`/.test(window.__clip) && window.__opened.at(-1) === "https://github.com/acme/widgets/issues/9472" && __calls.length === calls);
  await expand(2);
  ok("no bot: follow_up as bot becomes the new-issue form of the configured repo", !!cardBtn("Open GitHub to file the issue"));
  cardBtn("Open GitHub to file the issue").click(); await wait(20);
  ok("the new-issue URL uses the board's repo", window.__opened.at(-1).startsWith("https://github.com/contoso/gadgets/issues/new?title="));
  await openItem("issue-9471");
  ok("no bot: unavailable routes are hidden", cards().length === 3 && !cards().some((c) => /Start fix/.test(c.textContent)));
  const mv = cards().find((c) => /Move/.test(c.textContent));
  mv.querySelector(".card-head").click(); await wait(5);
  ok("no bot: a move offers only closing with the canned text, in his name", [...openCard().querySelectorAll(".card-actions button")].map((b) => b.textContent).join() === "Copy text, open GitHub to close");
  await openItem("pr-9473");
  ok("no bot: a review with inline comments, the chore and take_over are hidden", cards().length === 1 && /Merge/.test(cards()[0].textContent));
  await openItem("disc-9476");
  ok("without an escalate command there is no escalate route", !cards().some((c) => /escalate/.test(c.textContent)) && cards().length === 1);
  await openItem("issue-9477");
  ok("no bot: reply as bot becomes a prefill", cards().some((c) => /Reply/.test(c.textContent)));
  cards().find((c) => /Reply/.test(c.textContent)).querySelector(".card-head").click(); await wait(5);
  ok("no bot: the prefill has no confirm and no bot name", !!cardBtn("Copy reply, open GitHub") && !/bot/.test(openCard().querySelector(".card-actions").textContent));

  // Own mode: bot routes run under his login after the click
  applyBoardInfo(gadgetsOnly("own", false));
  items(served("own")); await wait(10);
  await openItem("pr-9473");
  ok("own: the review runs under his login with his avatar", /jdoe/.test(cardBtn("Request changes")?.querySelector("img")?.src ?? "") && /Runs right away under your GitHub login/.test(openCard().textContent));
  cardBtn("Request changes").click(); await wait(5);
  ok("own: the confirm says as you", !!cardBtn("Confirm: request changes as you"));
  calls = __calls.length;
  cardBtn("Confirm: request changes as you").click(); await wait(20);
  ok("own: the click goes to the server", __calls.length === calls + 1 && __calls.at(-1).routeId === "r1");
  ok("own: take_over commits as him", (() => { const c = cards()[3]; c.querySelector(".card-head").click(); return /Commits as jdoe/.test(c.textContent); })());
  await openItem("issue-9471");
  cards()[3].querySelector(".card-head").click(); await wait(5);
  ok("own: a move transfers as him and closes as a prefill", avatarOf(cardBtn("Transfer to widgets-desktop"), "jdoe") && !!cardBtn("Copy text, open GitHub to close") && !openCard().querySelector(".card-head .avatar, .card-head .actor-icon:not(.chev)"));
  document.getElementById("d-close").click(); await wait(5);
  ok("nothing names the widgets project in the second project's page chrome", !/widgets/i.test(document.title + document.querySelector("header").textContent));

  applyBoardInfo(ZW);
  items(F); await wait(10);
