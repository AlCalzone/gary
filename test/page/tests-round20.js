  // ---------- round 20 ----------
  // Rule cleanup: edit proposals as a before and after diff, grouped edits on one card, and the button that asks for a check
  {
    const lb = document.getElementById("learn");
    const dlg = document.getElementById("learn-dialog");
    const ecards = () => [...dlg.querySelectorAll("#learn-edit-cards .pcard")];
    const btn = (c, text) => [...c.querySelectorAll("button")].find((b) => b.textContent === text);
    const lines = (c, t) => [...c.querySelectorAll(".rd-" + t + " .rd-text")].map((x) => x.textContent.replace(/^(Removed|Added): /, ""));
    const edit = (id, extra) => [id, {
      id, kind: "edit", title: "Name the category land", why: "The rule names the old section `easy`.", finding: "stale",
      evidence: [{ type: "name", gist: "easy is no category since round 19", file: "rules/classification.md", quote: "into `easy`" }],
      target: "profile", file: "rules/classification.md", before: "## Config PRs\nPut config PRs into `easy`.\n", after: "## Config PRs\nPut config PRs into `land`.\n", status: "open", ...extra,
    }];
    const single = edit("reconcile-stale");
    const del = edit("reconcile-vague", { title: "Drop the changelog rule", finding: "vague", file: "rules/review.md", before: "- Ask for a changelog entry.\n", after: "" });
    const longLine = "Ask for a test on every bug fix, also in config PRs and in PRs that only touch the device database, because the device files break the interview when a field is wrong.";
    const pairA = edit("reconcile-merge-a", { title: "Keep the test rule in one place", finding: "duplicate", file: "rules/review.md", before: "- Ask for a test on every bug fix.", after: "- " + longLine, group: "merge-tests",
      evidence: [{ type: "text", gist: "Both files ask for tests on bug fixes", file: "rules/review.md" }] });
    const pairB = edit("reconcile-merge-b", { title: "Keep the test rule in one place", finding: "duplicate", file: "rules/classification.md", before: "Bug fixes need a test.\n", after: "", group: "merge-tests",
      evidence: [{ type: "text", gist: "Both files ask for tests on bug fixes", file: "rules/review.md" }, { type: "log", gist: "The maintainer kept asking for tests", count: 4 }] });
    learn.gone.clear(); learn.known.clear(); learn.added.clear();

    // The group counts once
    window.__subs["proposals"](__mkSnap([single, del, pairB, pairA])); await wait(10);
    ok("edits: the lightbulb counts a group as one suggestion", !lb.hidden && lb.textContent === "3", lb.textContent);
    lb.click(); await wait(10);
    ok("edits: their own section with a short title", !document.getElementById("learn-edits").hidden && document.getElementById("learn-edits-title").textContent === "Rule cleanup" && ecards().length === 3);
    ok("edits: no rule textarea on an edit card", ecards().every((c) => !c.querySelector("textarea")));

    // One edit
    const one = ecards().find((c) => /category land/.test(c.querySelector(".p-title").textContent));
    ok("edit: the card names the finding", one.querySelector(".p-finding")?.textContent === "Old name");
    ok("edit: the file sits above the diff", one.querySelector(".rd-file")?.textContent === "rules/classification.md");
    ok("edit: the changed line is removed and added, the heading is context", lines(one, "del").join() === "Put config PRs into `easy`." && lines(one, "add").join() === "Put config PRs into `land`." && lines(one, "ctx").join() === "## Config PRs", [lines(one, "del"), lines(one, "add"), lines(one, "ctx")]);
    ok("edit: the marks are minus and plus, hidden from screen readers", one.querySelector(".rd-del .rd-mark").textContent === "−" && one.querySelector(".rd-add .rd-mark").textContent === "+" && one.querySelector(".rd-mark").getAttribute("aria-hidden") === "true");
    ok("edit: a screen reader hears removed and added", one.querySelector(".rd-del .rd-sr").textContent === "Removed: " && one.querySelector(".rd-add .rd-sr").textContent === "Added: ");
    ok("edit: the evidence folds away and names the stale text", /Evidence \(1\)/.test(one.querySelector(".evidence summary").textContent) && /into `easy`/.test(one.querySelector(".evidence").textContent));
    ok("edit: Apply and Not this", [...one.querySelectorAll(".card-actions button")].map((b) => b.textContent).join() === "Apply,Not this");

    // A delete
    const gone = ecards().find((c) => /changelog/.test(c.querySelector(".p-title").textContent));
    ok("delete: only the removed text shows", lines(gone, "del").join() === "- Ask for a changelog entry." && !gone.querySelector(".rd-add") && !gone.querySelector(".rd-ctx"));

    // Colors in both themes, and a long line that wraps at phone width
    const parse = (c) => {
      let m = /^rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)$/.exec(c);
      if (m) return [+m[1] / 255, +m[2] / 255, +m[3] / 255, m[4] === undefined ? 1 : +m[4]];
      m = /^color\(srgb ([\d.e-]+) ([\d.e-]+) ([\d.e-]+)(?: \/ ([\d.]+))?\)$/.exec(c);
      return m ? [+m[1], +m[2], +m[3], m[4] === undefined ? 1 : +m[4]] : null;
    };
    const over = (top, bottom) => [0, 1, 2].map((i) => top[i] * top[3] + bottom[i] * (1 - top[3])).concat(1);
    const bgOf = (el) => {
      const layers = [];
      for (let e = el; e; e = e.parentElement) { const c = parse(getComputedStyle(e).backgroundColor); if (c && c[3] > 0) { layers.push(c); if (c[3] >= 1) break; } }
      let out = [1, 1, 1, 1];
      for (const l of layers.reverse()) out = over(l, out);
      return out;
    };
    const lum = (c) => { const f = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4); return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
    const contrast = (el) => { const bg = bgOf(el); const fg = over(parse(getComputedStyle(el).color) ?? [0, 0, 0, 1], bg); const [a, b] = [lum(fg), lum(bg)].sort((x, y) => y - x); return (a + 0.05) / (b + 0.05); };
    const tint = (el) => parse(getComputedStyle(el).backgroundColor);
    const bad = [];
    for (const theme of ["light", "dark"]) {
      document.documentElement.dataset.theme = theme; await wait(5);
      for (const [label, el, min] of [["removed text", one.querySelector(".rd-del .rd-text"), 4.5], ["added text", one.querySelector(".rd-add .rd-text"), 4.5], ["minus", one.querySelector(".rd-del .rd-mark"), 3], ["plus", one.querySelector(".rd-add .rd-mark"), 3], ["context", one.querySelector(".rd-ctx .rd-text"), 4.5]]) {
        const c = contrast(el);
        if (c < min) bad.push(theme + " " + label + " " + c.toFixed(2));
      }
      const r = tint(one.querySelector(".rd-del")), a = tint(one.querySelector(".rd-add"));
      if (!r || !a || r[3] === 0 || a[3] === 0 || !(r[0] > r[1]) || !(a[1] > a[0])) bad.push(theme + " tints " + JSON.stringify([r, a]));
    }
    delete document.documentElement.dataset.theme;
    ok("diff: readable in light and dark, removed lines red, added lines green " + bad.join("; "), bad.length === 0);
    const pair = ecards().find((c) => /one place/.test(c.querySelector(".p-title").textContent));
    dlg.style.width = "340px"; await wait(5);
    const box = pair.querySelector(".rdiff");
    ok("diff: a long line wraps at phone width", box.scrollWidth <= box.clientWidth + 1 && pair.scrollWidth <= pair.clientWidth + 1 && getComputedStyle(pair.querySelector(".rd-add")).whiteSpace === "pre-wrap", [box.scrollWidth, box.clientWidth]);
    dlg.style.width = "";

    // A group: one card for both files, one Apply and one Dismiss
    ok("group: both files on one card, in id order", [...pair.querySelectorAll(".rd-file")].map((x) => x.textContent).join() === "rules/review.md,rules/classification.md");
    ok("group: one Apply and one Not this", [...pair.querySelectorAll(".card-actions button")].map((b) => b.textContent).join() === "Apply,Not this");
    ok("group: the shared evidence shows once", /Evidence \(2\)/.test(pair.querySelector(".evidence summary").textContent) && /4 decisions/.test(pair.querySelector(".evidence").textContent));
    let calls = __calls.length;
    btn(pair, "Apply").click(); await wait(20);
    ok("group: Apply sends one accept for the first member", __calls.length === calls + 1 && __calls.at(-1).tool === "accept_proposal" && __calls.at(-1).proposalId === "reconcile-merge-a" && __calls.at(-1).text === undefined, __calls.at(-1));
    ok("group: the card says what changed", /Changed rules\/review\.md and rules\/classification\.md/.test(pair.textContent) && !btn(pair, "Apply"));
    ok("group: it no longer counts", lb.textContent === "2");

    // Dismissing a delete with a reason
    calls = __calls.length;
    btn(gone, "Not this").click(); await wait(5);
    const why = gone.querySelector(".dismiss-box input");
    why.value = "Keep it"; btn(gone, "Dismiss suggestion").click(); await wait(20);
    ok("dismiss: sends the reason", __calls.length === calls + 1 && __calls.at(-1).tool === "dismiss_proposal" && __calls.at(-1).proposalId === "reconcile-vague" && __calls.at(-1).text === "Keep it");
    ok("dismiss: the card goes", !ecards().includes(gone));

    // A failed apply keeps the card and says why
    window.__reply = (b) => (b.tool === "accept_proposal" ? { ok: false, result: "The file changed since this proposal. Run reconcile again." } : { ok: true, result: {} });
    btn(one, "Apply").click(); await wait(20);
    ok("edit: a stale file shows the server's reason", /Run reconcile again/.test(one.querySelector(".z-status").textContent) && !!btn(one, "Apply"));
    window.__reply = () => ({ ok: true, result: { dryRun: true } });

    // Asking for a check
    const check = [...dlg.querySelectorAll("#learn-foot button")];
    ok("check: one Check rules button for the one instance", check.length === 1 && check[0].textContent === "Check rules");
    calls = __calls.length;
    check[0].click(); await wait(20);
    ok("check: it asks the server for a reconcile pass", __calls.length === calls + 1 && __calls.at(-1).tool === "request_reconcile" && __calls.at(-1).instance === "widgets", __calls.at(-1));
    ok("check: the button turns into a short note", /Check requested/.test(document.getElementById("learn-foot").textContent) && !document.querySelector("#learn-foot button"));

    document.getElementById("learn-close").click(); await wait(5);
    window.__subs["proposals"](__mkSnap([])); await wait(5);
    learn.gone.clear(); learn.known.clear(); learn.added.clear();
  }
