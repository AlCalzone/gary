  // ---------- round 25 ----------
  // Talk to Gary: the logo opens the chat dialog, which sends messages through the board's chat call and shows the answers
  // that arrive as board:chat events
  {
    const logo = document.getElementById("logo");
    const dlg = document.getElementById("chat-dialog");
    const input = document.getElementById("chat-input");
    const send = document.getElementById("chat-send");
    const status = document.getElementById("chat-status");
    const error = document.getElementById("chat-error");
    const msgs = () => [...dlg.querySelectorAll(".msg")];
    const calls = [];
    let answer = () => ({ ok: true, chat: null, master: { running: true } });
    window.__board.chat = async (body) => {
      calls.push(body);
      return answer(body);
    };
    const shut = async () => { if (dlg.open) { document.getElementById("chat-close").click(); await wait(5); } };
    const enter = (shiftKey = false) => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", shiftKey, bubbles: true, cancelable: true }));
    const queued = (text, extra) => ({ id: "m-aaaaaa1", role: "user", text, at: iso(5000), status: "queued", ...extra });
    try { localStorage.removeItem("gary:chat:id"); localStorage.removeItem("gary:chat:draft"); } catch {}
    // The logo images do not load from a file page, so the button stays hidden unless the test shows it
    const wasHidden = logo.hidden;
    logo.hidden = false;

    ok("chat: the logo is a button named Talk to Gary that opens a dialog", logo.tagName === "BUTTON" && logo.type === "button" && logo.getAttribute("aria-label") === "Talk to Gary" && logo.getAttribute("aria-haspopup") === "dialog");
    ok("chat: the logo wiggles on hover and focus", [...document.styleSheets].some((s) => { try { return [...s.cssRules].some((r) => /\.logo:hover img/.test(r.selectorText || "") && /logo-wiggle/.test(r.cssText)); } catch { return false; } }));
    ok("chat: the logo carries a speech bubble that grows in on hover and keyboard focus", !!logo.querySelector(".logo-talk svg") && logo.querySelector(".logo-talk").getAttribute("aria-hidden") === "true"
      && [...document.styleSheets].some((s) => { try { return [...s.cssRules].some((r) => /\.logo:focus-visible \.logo-talk/.test(r.selectorText || "")); } catch { return false; } }));
    logo.click(); await wait(20);
    ok("chat: a click opens the dialog and asks the server for the newest chat", dlg.open && calls.length === 1 && calls[0].op === "get" && calls[0].chatId === undefined, calls);
    const art = dlg.querySelector(".chat-art");
    const imgs = [...art.querySelectorAll("img")].map((i) => i.getAttribute("src")).join();
    ok("chat: the left side shows the full logo, one file per theme", imgs === "logo-full.svg,logo-full-dark.svg");
    const share = art.getBoundingClientRect().width / dlg.querySelector(".chat-split").getBoundingClientRect().width;
    ok("chat: the logo takes a quarter of the width, the chat the rest", share > 0.22 && share < 0.28, share);
    ok("chat: an empty chat offers three examples", [...dlg.querySelectorAll(".chat-example")].map((b) => b.textContent).join("|") === "Mark all FYI items for merged PRs as Got it|Explain my settings|Snooze everything from dependabot for 3 days");
    dlg.querySelectorAll(".chat-example")[1].click(); await wait(5);
    ok("chat: an example fills the box", input.value === "Explain my settings" && document.activeElement === input);

    // Send with Enter
    input.value = "First line"; enter(true); await wait(10);
    ok("chat: Send is a round arrow button inside the text box, and the placeholder explains Enter", send.closest(".chat-box") === input.parentElement && getComputedStyle(send).position === "absolute" && !!send.querySelector("svg") && send.getAttribute("aria-label") === "Send" && /Enter sends, Shift\+Enter starts a new line/.test(input.placeholder) && !document.querySelector(".chat-hint"));
    ok("chat: Shift+Enter sends nothing", calls.length === 1);
    input.value = "Snooze everything from dependabot for 3 days";
    let chatDoc = { id: "c-test000001", title: "Snooze", session: null, messages: [queued("Snooze everything from dependabot for 3 days")] };
    answer = (b) => (b.op === "send" ? { ok: true, chat: chatDoc, master: { running: true } } : { ok: true, chat: chatDoc, master: { running: true } });
    enter(); await wait(20);
    ok("chat: Enter sends the text to a new chat", calls.at(-1).op === "send" && calls.at(-1).chatId === null && calls.at(-1).text === "Snooze everything from dependabot for 3 days", calls.at(-1));
    ok("chat: the message shows with its time, and the box is empty", msgs().length === 1 && msgs()[0].classList.contains("user") && msgs()[0].querySelector(".msg-body").textContent === "Snooze everything from dependabot for 3 days"
      && /^\d\d:\d\d$/.test(msgs()[0].querySelector("time").textContent) && input.value === "");
    ok("chat: Gary is thinking while the answer is pending, and Send waits", /Gary is thinking/.test(status.textContent) && send.disabled);
    let stored = null;
    try { stored = localStorage.getItem("gary:chat:id"); } catch {}
    ok("chat: the page keeps no chat id of its own, the server knows the active chat", stored === null);

    // Gary's answer arrives as an event
    const answerText = "These match:\n\n- `widgets/pr-1` [acme/widgets#1](https://github.com/acme/widgets/pull/1)\n- see [this](https://evil.example/x) and https://github.com/acme/widgets/issues/2.\n\n<img src=x onerror=alert(1)> **Done.**\n\n```\n{ \"days\": 3 }\n```";
    chatDoc = { ...chatDoc, messages: [{ ...chatDoc.messages[0], status: "answered" }, { id: "m-aaaaaa2", role: "gary", text: answerText, at: iso(0), replyTo: "m-aaaaaa1" }] };
    window.dispatchEvent(new CustomEvent("board:chat", { detail: { master: { running: true } } })); await wait(5);
    ok("chat: an event without a chat changes nothing", msgs().length === 1);
    window.dispatchEvent(new CustomEvent("board:chat", { detail: { chat: chatDoc, master: { running: true } } })); await wait(5);
    const reply = msgs()[1];
    const links = reply ? [...reply.querySelectorAll("a")].map((a) => a.href) : [];
    ok("chat: the answer renders as Gary's message", !!reply && reply.classList.contains("gary") && reply.querySelector(".msg-who").textContent === "Gary");
    ok("chat: the answer renders lists, inline code, bold and a code block", reply.querySelectorAll("li").length === 2 && reply.querySelector("code.ic")?.textContent === "widgets/pr-1" && reply.querySelector("strong")?.textContent === "Done." && reply.querySelector("pre code")?.textContent === "{ \"days\": 3 }");
    ok("chat: only links to github.com become links", links.join() === "https://github.com/acme/widgets/pull/1,https://github.com/acme/widgets/issues/2" && /this \(https:\/\/evil\.example\/x\)/.test(reply.textContent), links);
    ok("chat: HTML in an answer stays text", !reply.querySelector("img") && reply.textContent.includes("<img src=x onerror=alert(1)>"));
    ok("chat: links open in a new tab without a referrer", [...reply.querySelectorAll("a")].every((a) => a.target === "_blank" && a.rel === "noopener noreferrer"));
    ok("chat: the thinking line is gone and Send works again", status.textContent === "" && !send.disabled);

    // A refused send keeps the text and shows the server's reason
    answer = (b) => (b.op === "send" ? { ok: false, result: "That is a lot of messages in one minute. Try again in 30 s.", retryAfter: 30 } : { ok: true, chat: chatDoc, master: { running: true } });
    input.value = "Again"; enter(); await wait(20);
    ok("chat: a refusal shows the server's reason and keeps the text", !error.hidden && error.textContent === "That is a lot of messages in one minute. Try again in 30 s." && input.value === "Again" && calls.at(-1).chatId === "c-test000001");
    answer = (b) => (b.op === "send" ? { ok: false, result: "The board server is not reachable.", unreachable: true } : { ok: true, chat: chatDoc, master: { running: true } });
    enter(); await wait(20);
    ok("chat: an unreachable server is said as such", error.textContent === "The board server is not reachable." && input.value === "Again");

    // The master is not running, and answers that do not come
    chatDoc = { ...chatDoc, messages: [...chatDoc.messages, queued("Again", { id: "m-aaaaaa3", at: iso(5000) })] };
    window.dispatchEvent(new CustomEvent("board:chat", { detail: { chat: chatDoc, master: { running: false, at: null } } })); await wait(5);
    ok("chat: without a running master the dialog says so and what helps", /master session is not running/.test(status.textContent) && /next hourly run/.test(status.textContent) && /triage-master skill/.test(status.textContent) && !/thinking/.test(status.textContent), status.textContent);
    chatDoc = { ...chatDoc, messages: [...chatDoc.messages.slice(0, 2), queued("Again", { id: "m-aaaaaa3", at: iso(3 * 60000) })] };
    window.dispatchEvent(new CustomEvent("board:chat", { detail: { chat: chatDoc, master: { running: true } } })); await wait(5);
    ok("chat: a message nobody picked up for 2 minutes is said as such, and Send works again", /has not picked up your message for 2 minutes/.test(status.textContent) && !send.disabled, status.textContent);
    chatDoc = { ...chatDoc, session: { harness: "t3code", id: "thread-1", link: "t3-thread://thread-1" }, messages: [...chatDoc.messages.slice(0, 2), queued("Again", { id: "m-aaaaaa3", at: iso(20 * 60000), status: "sent", sentAt: iso(11 * 60000) })] };
    window.dispatchEvent(new CustomEvent("board:chat", { detail: { chat: chatDoc, master: { running: true } } })); await wait(5);
    ok("chat: no answer for 10 minutes is said as such, with a link to the session", /No answer for 10 minutes/.test(status.textContent) && status.querySelector("a")?.getAttribute("href") === "t3-thread://thread-1" && !send.disabled, status.textContent);
    chatDoc = { ...chatDoc, messages: [...chatDoc.messages.slice(0, 2), queued("Again", { id: "m-aaaaaa3", status: "failed", reason: "Gary runs in a terminal, which cannot start a session." })] };
    window.dispatchEvent(new CustomEvent("board:chat", { detail: { chat: chatDoc, master: { running: true } } })); await wait(5);
    ok("chat: a failed message shows the master's reason under it", msgs()[2].querySelector(".msg-note.bad")?.textContent === "Not answered: Gary runs in a terminal, which cannot start a session." && status.textContent === "");

    // History: the chat comes back when the dialog opens again
    await shut();
    ok("chat: closing puts the focus back on the logo", !dlg.open && document.activeElement === logo);
    calls.length = 0;
    logo.click(); await wait(20);
    ok("chat: opening again loads the active chat from the server", calls[0]?.op === "get" && calls[0].chatId === undefined && msgs().length === 3, calls);
    input.value = "unsent"; input.dispatchEvent(new Event("input"));
    await shut(); input.value = "";
    logo.click(); await wait(20);
    ok("chat: a typed draft survives closing", input.value === "unsent");

    // New chat
    calls.length = 0;
    answer = (b) => (b.op === "new" ? { ok: true, chat: null, archived: ["c-test000001"], master: { running: true } } : { ok: true, chat: null, master: { running: true } });
    document.getElementById("chat-new").click(); await wait(20);
    ok("chat: New chat archives the chat on the server, empties the log and shows the examples", calls[0]?.op === "new" && msgs().length === 0 && dlg.querySelectorAll(".chat-example").length === 3, calls);
    calls.length = 0;
    await shut(); logo.click(); await wait(20);
    ok("chat: a new chat stays new after the dialog opens again", calls[0]?.op === "get" && msgs().length === 0, calls);
    window.dispatchEvent(new CustomEvent("board:chat", { detail: { chat: { id: "c-other00001", messages: [queued("From another board")] }, master: { running: true } } })); await wait(5);
    ok("chat: a chat started on another open board shows here too", msgs().length === 1 && msgs()[0].querySelector(".msg-body").textContent === "From another board");
    window.dispatchEvent(new CustomEvent("board:chat", { detail: { chat: null, master: { running: true } } })); await wait(5);
    ok("chat: New chat on another open board empties this one", msgs().length === 0);
    answer = (b) => (b.op === "send" ? { ok: true, chat: { id: "c-test000002", messages: [queued("unsent")] }, master: { running: true } } : { ok: true, master: { running: true } });
    enter(); await wait(20);
    ok("chat: the first message after New chat starts a new chat", calls.at(-1).op === "send" && calls.at(-1).chatId === null && msgs().length === 1);

    // The page reload waits for the open chat
    window.dispatchEvent(new Event("board:reload")); await wait(5);
    ok("chat: an open chat defers the page reload and its bar says so", dlg.open && reloadPending === true && !dlg.querySelector(".bar-reload").hidden && !document.getElementById("reload").hidden);
    reloadPending = false;
    for (const b of document.querySelectorAll("#reload, .bar-reload")) b.hidden = true;
    dlg.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await shut();

    // With the dialog closed, the logo marks an answer the maintainer has not seen
    const pendingDoc = { id: "c-test000002", messages: [queued("unsent", { at: iso(1000) })] };
    window.dispatchEvent(new CustomEvent("board:chat", { detail: { chat: pendingDoc, master: { running: true } } })); await wait(5);
    ok("chat: the logo stays as it is while Gary answers behind a closed dialog", !logo.classList.contains("unread") && logo.getAttribute("aria-label") === "Talk to Gary" && getComputedStyle(logo.querySelector("img")).animationName !== "logo-unread", logo.className);
    window.dispatchEvent(new CustomEvent("board:chat", { detail: { chat: { ...pendingDoc, messages: [{ ...pendingDoc.messages[0], status: "answered" }, { id: "m-aaaaaa9", role: "gary", text: "Done.", at: iso(0), replyTo: "m-aaaaaa1" }] }, master: { running: true } } })); await wait(5);
    ok("chat: an answer that came while the dialog was closed shows the bubble and tilts the logo", logo.classList.contains("unread") && /Gary answered/.test(logo.getAttribute("aria-label")) && getComputedStyle(logo.querySelector("img")).animationName === "logo-unread", logo.className);
    answer = () => ({ ok: true, chat: { ...pendingDoc, messages: [{ ...pendingDoc.messages[0], status: "answered" }, { id: "m-aaaaaa9", role: "gary", text: "Done.", at: iso(0), replyTo: "m-aaaaaa1" }] }, master: { running: true } });
    logo.click(); await wait(20);
    ok("chat: opening the chat clears the mark", !logo.classList.contains("unread") && logo.getAttribute("aria-label") === "Talk to Gary");
    await shut();
    ok("chat: a seen answer stays seen after the dialog closes", !logo.classList.contains("unread"));
    try { localStorage.removeItem("gary:chat:seen"); } catch {}
    await shut();
    try { localStorage.removeItem("gary:chat:id"); localStorage.removeItem("gary:chat:draft"); } catch {}
    delete window.__board.chat;
    logo.hidden = wasHidden;
  }
