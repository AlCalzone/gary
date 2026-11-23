  // ---------- round 17 ----------
  // A bot PR whose round for the maintainer's review waits while the session that opened it is active
  {
    const base = "https://github.com/acme/widgets";
    const common = { kind: "pr", author: "widgets-bot", authorType: "bot", section: "review", effortMinutes: 5, priority: 1, updatedAt: iso(1000), reviewDepth: "full",
      routes: [{ id: "r1", type: "merge", as: "me", actor: "me", title: "Merge", recommended: true, draftHash: "h1" }] };
    const SID = "9d269cae-776d-486e-9ca4-fd92ef5921be";
    const active = iso(2 * 60000);
    const reviewed = iso(4 * 60000);
    const until = iso(-28 * 60000);
    const origin = { found: true, sessionId: SID, dir: "~/repositories/widgets/master", resume: "cd ~/repositories/widgets/master && claude --resume " + SID, startedAt: iso(3 * 3600000), lastActiveAt: active, prompt: "Fix the LED." };
    const time = (t) => new Date(t).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    const r17 = [
      ["pr-9981", { ...common, number: 9981, title: "Held review", url: base + "/pull/9981", origin, hold: { feedbackAt: reviewed, feedbackKind: "review", lastActiveAt: active, until } }],
      ["pr-9982", { ...common, number: 9982, title: "Held, kind unknown", url: base + "/pull/9982", origin, hold: { feedbackAt: reviewed, feedbackKind: null, lastActiveAt: active, until } }],
      ["pr-9983", { ...common, number: 9983, title: "No hold", url: base + "/pull/9983", origin }],
    ];
    const box = () => document.getElementById("d-hold");
    const chip = (id) => document.querySelector('.row[data-id="' + id + '"] .hold-chip');
    items(r17); await wait(10);
    await openAll();

    ok("hold: the row shows a short marker", chip("pr-9981")?.textContent === "Waits for session" && /around /.test(chip("pr-9981").title), chip("pr-9981")?.outerHTML);
    ok("hold: a row without a hold has no marker", !chip("pr-9983"));
    await openItem("pr-9981");
    ok("hold: the dialog names the maintainer's review, the session and when Gary acts", !box().hidden && box().querySelector(".hold-line")?.textContent === "Your review from " + time(reviewed) + " waits: the session that opened this PR in ~/repositories/widgets/master was active at " + time(active) + ". Gary starts the round after 30 quiet minutes, around " + time(until) + ".", box().textContent);
    ok("hold: the dialog says how to act sooner", box().querySelector(".hold-sooner")?.textContent === "To act sooner, address it in that session yourself.");
    await openItem("pr-9982");
    ok("hold: without a known kind it says feedback", /^Your feedback from /.test(box().querySelector(".hold-line")?.textContent ?? ""), box().textContent);
    await openItem("pr-9983");
    ok("hold: without a hold the dialog shows no callout", box().hidden && box().textContent === "");
    document.getElementById("d-close").click(); await wait(5);

    items([["pr-9981", { ...r17[0][1], hold: { ...r17[0][1].hold, until: iso(60000) } }]]); await wait(10);
    ok("hold: a hold that already ended shows nothing", !chip("pr-9981"));
    items(F); await wait(5);
  }
