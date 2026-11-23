  // ---------- round 18 ----------
  // The maintainer answers each finding where it is shown, and one click sends all answers with Analyze again
  {
    const base = "https://github.com/acme/widgets";
    const findings = [
      { id: "f1", key: "f1", severity: "question", text: "Does the device accept 0x00 here?" },
      { key: "#1-0a1b2c3d", severity: "minor", text: "The log line lacks the node id." },
      { id: "f3", key: "f3", severity: "major", text: "A value of 200 passes the range check.", routeId: "r1" },
    ];
    const pr = { kind: "pr", number: 9991, title: "Answers", url: base + "/pull/9991", author: "octocat", authorType: "maintainer", section: "review", effortMinutes: 5, priority: 1, updatedAt: iso(1000), reviewDepth: "full", reviewedAt: "2026-11-19T10:00:00.000Z",
      findings, findingAnswers: [{ finding: "f0", findingText: "An old finding.", text: "That was on purpose.", at: "2026-11-18T09:00:00.000Z" }],
      routes: [{ id: "r1", type: "revise", as: "agent", actor: "agent", title: "Change: check the range", text: "Reject values above 99.", recommended: true, draftHash: "h1" }] };
    const dlg18 = document.getElementById("detail");
    const lis = () => [...document.querySelectorAll("#d-findings .findings li")];
    const reply = (li) => li.querySelector(".f-reply");
    const box = (li) => li.querySelector(".f-answer");
    const analyzeBtn = () => document.querySelector("#d-foot .foot-analyze");
    const type = (ta, v) => { ta.value = v; ta.dispatchEvent(new Event("input")); };
    const openIt = async () => { if (dlg18.open) { document.getElementById("d-close").click(); await wait(5); } openDetail("pr-9991"); await wait(10); };
    items([["pr-9991", pr]]); await wait(10);
    await openIt();

    ok("answers: every finding has a Reply link, also the one on its card", lis().length === 2 && lis().every((li) => reply(li)?.textContent === "Reply" && !reply(li).hidden && box(li).hidden)
      && dlg18.querySelectorAll(".card .f-reply")[0]?.textContent === "Reply", document.getElementById("d-findings").innerHTML.slice(0, 300));
    ok("answers: the answer to a finding that is gone is under Earlier answers", document.querySelector(".earlier-answers summary")?.textContent === "Earlier answers (1)"
      && /An old finding\./.test(document.querySelector(".earlier-answers").textContent) && /You answered: That was on purpose\./.test(document.querySelector(".earlier-answers").textContent));
    ok("answers: without an answer the button reads Analyze again", analyzeBtn().textContent === "Analyze again");

    reply(lis()[0]).click(); await wait(5);
    const ta1 = box(lis()[0]).querySelector("textarea");
    ok("answers: Reply opens a box under the finding and focuses it", !box(lis()[0]).hidden && reply(lis()[0]).hidden && document.activeElement === ta1);
    type(ta1, "Yes, 0x00 means off."); await wait(5);
    ok("answers: one answer changes the button label", analyzeBtn().textContent === "Send 1 answer and analyze again", analyzeBtn().textContent);

    items([["pr-9991", { ...pr, updatedAt: iso(500) }]]); await wait(10);
    ok("answers: the draft survives a re-render", !box(lis()[0]).hidden && box(lis()[0]).querySelector("textarea").value === "Yes, 0x00 means off.");
    // A reload starts with empty in-memory drafts and reads the stored ones
    document.getElementById("d-close").click(); await wait(5);
    state.drafts.clear();
    await openIt();
    ok("answers: the draft survives a reload", !box(lis()[0]).hidden && box(lis()[0]).querySelector("textarea").value === "Yes, 0x00 means off." && analyzeBtn().textContent === "Send 1 answer and analyze again");

    reply(lis()[1]).click(); await wait(5);
    type(box(lis()[1]).querySelector("textarea"), "Not needed."); await wait(5);
    ok("answers: two answers are counted", analyzeBtn().textContent === "Send 2 answers and analyze again");
    box(lis()[1]).querySelector(".f-reply").click(); await wait(5);
    ok("answers: Cancel closes the box and drops the draft", box(lis()[1]).hidden && !reply(lis()[1]).hidden && analyzeBtn().textContent === "Send 1 answer and analyze again" && !/a:#1-0a1b2c3d/.test(localStorage.getItem("gary:widgets:drafts") || JSON.stringify(localStorage)));
    reply(lis()[1]).click(); await wait(5);
    ok("answers: after Cancel the box opens empty", box(lis()[1]).querySelector("textarea").value === "");
    type(box(lis()[1]).querySelector("textarea"), "Not needed, the prefix has it."); await wait(5);
    type(document.querySelector("#d-analyze textarea"), "Also check the tests."); await wait(5);

    __reply = () => ({ ok: false, result: "An answer names a finding the item no longer has. Reload the board." });
    if (document.getElementById("d-analyze").hidden) { analyzeBtn().click(); await wait(20); }
    const panelSend = () => document.querySelector('#d-analyze [data-focus-key="more:send"]');
    ok("answers: the button opens the instructions box and sends nothing yet", !document.getElementById("d-analyze").hidden && panelSend().textContent === "Send 2 answers to the agent" && /optional/.test(document.querySelector("#d-analyze label").textContent), panelSend().textContent);
    panelSend().click(); await wait(20);
    ok("answers: a refusal shows the server's reason and keeps the drafts", /no longer has/.test(document.querySelector("#d-foot .foot-status").textContent) && analyzeBtn().textContent === "Send 2 answers and analyze again", document.querySelector("#d-foot .foot-status").textContent);
    __reply = () => ({ ok: true, result: "Sent 2 answers to the agent." });
    const before = __calls.length;
    if (document.getElementById("d-analyze").hidden) { analyzeBtn().click(); await wait(20); }
    panelSend().click(); await wait(20);
    const sent = __calls.slice(before);
    ok("answers: one click sends one reanalyze with the answers and the note", sent.length === 1 && sent[0].tool === "reanalyze" && sent[0].instance === "widgets" && sent[0].itemId === "pr-9991" && sent[0].text === "Also check the tests."
      && JSON.stringify(sent[0].input) === JSON.stringify({ answers: [{ finding: "f1", text: "Yes, 0x00 means off." }, { finding: "#1-0a1b2c3d", text: "Not needed, the prefix has it." }] }), sent);
    ok("answers: after sending the boxes close and the button reads Analyze again", lis().every((li) => box(li).hidden) && analyzeBtn().textContent === "Analyze again");

    const at = new Date().toISOString();
    items([["pr-9991", { ...pr, findingAnswers: [...pr.findingAnswers, { finding: "f1", findingText: findings[0].text, text: "Yes, 0x00 means off.", at }, { finding: "#1-0a1b2c3d", findingText: findings[1].text, text: "Not needed, the prefix has it.", at }] }]]); await wait(10);
    const line = lis()[0].querySelector(".f-answered");
    ok("answers: the item comes back with You answered and the date", line?.textContent === "You answered: Yes, 0x00 means off. · " + sinceDay(at) && /You answered: Not needed/.test(lis()[1].textContent), line?.textContent);
    ok("answers: Reply stays available after an answer", !reply(lis()[0]).hidden);
    document.getElementById("d-close").click(); await wait(5);
    items(F); await wait(5);
  }
