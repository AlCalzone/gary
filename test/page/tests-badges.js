  // Review badges, review threads and state badges
  items([["pr-95", simple(95, "easy", 5, 1, { kind: "pr", ci: "passing", reviewDepth: "pending", solved: true,
    reviews: [
      { author: "octocat", isBot: false, state: "approved", submittedAt: iso(3600000), url: "https://github.com/acme/widgets/pull/95#pullrequestreview-1" },
      { author: "copilot-pull-request-reviewer", isBot: true, state: "commented", submittedAt: iso(7200000), url: "https://github.com/acme/widgets/pull/95#pullrequestreview-2", openThreadCount: 2 },
      { author: "someone", state: "changes_requested", url: "javascript:alert(1)" },
      { author: "pending-person", state: "pending" },
      { author: "old", state: "dismissed", url: "https://github.com/acme/widgets/pull/95#pullrequestreview-3" },
    ],
    threads: [
      { author: "copilot-pull-request-reviewer", isBot: true, path: "src/a.ts", line: 12, url: "https://github.com/acme/widgets/pull/95#discussion_r1", summary: "Use `Map` instead of an object", verdict: "valid", note: "The keys are numbers.", body: "RAW BODY TEXT" },
      { author: "copilot-pull-request-reviewer", path: "src/b.ts", line: 3, url: "https://github.com/acme/widgets/pull/95#discussion_r2", summary: "Rename the variable", verdict: "wrong", body: "RAW BODY TEXT" },
      { author: "someone", path: "src/c.ts", summary: "Add a test", verdict: "optional" },
      { author: "someone", path: "src/d.ts", summary: "Check null", body: "RAW BODY TEXT" },
    ],
    findings: [1, 2, 3, 4].map((n) => ({ severity: "minor", text: "Finding " + n })),
  })]]);
  await wait(10);
  ok("row shows an open-comments icon with the count", document.querySelector('.row[data-id="pr-95"] .r-meta .wait')?.textContent.endsWith("4") && document.querySelector('.row[data-id="pr-95"] .r-meta svg[aria-label="4 open review comments"]'));
  openDetail("pr-95"); await wait(5);
  const rv = [...document.querySelectorAll("#d-reviews .rv")];
  ok("one badge per review with its state", rv.map((b) => b.className.split(" ")[1]).join() === "rv-approved,rv-commented,rv-changes_requested,rv-pending,rv-dismissed");
  ok("Copilot is shortened and shows its open thread count", /^Copilot·2/.test(rv[1].textContent.replace(/\s/g, "")));
  ok("badges link only to github.com, pending is no link", rv[0].tagName === "A" && rv[0].href.startsWith("https://github.com/") && rv[2].tagName === "SPAN" && rv[3].tagName === "SPAN" && rv[4].tagName === "A");
  ok("badge tooltip names the state and time", /octocat: Approved, 1h ago/.test(rv[0].title));
  ok("no review icon next to the kind icon in the dialog when badges exist", !document.querySelector("#d-ref svg[aria-label^='Review']"));
  const th = document.querySelector("#d-threads details.threads");
  ok("thread disclosure closed by default with counts", th && !th.open && /4 open review comments/.test(th.querySelector("summary").textContent) && /1 valid · 1 optional · 1 wrong/.test(th.querySelector("summary").textContent));
  ok("verdict chips", [...th.querySelectorAll("li .sev")].map((c) => c.textContent).join() === "fix,not needed,optional,not judged");
  ok("thread entries show summary, note, author and path, linked to GitHub", th.querySelector("li .t-summary code.ic")?.textContent === "Map" && th.querySelector("li .t-note").textContent === "The keys are numbers." && th.querySelector("li a.t-ref")?.textContent === "Copilot · src/a.ts:12");
  ok("no raw comment body anywhere", !/RAW BODY TEXT/.test(document.getElementById("detail").textContent + document.getElementById("board").textContent));
  ok("more than three findings start collapsed", !document.querySelector("#d-findings details.findings").open);
  const sb = [...document.querySelectorAll("#d-meta .sbadge")].map((b) => b.textContent);
  ok("dialog meta shows state badges with words " + sb.join("|"), ["CI passing", "Looks solved", "Not analyzed yet", "4 open comments"].every((t) => sb.includes(t)));
  const shapeOf = (sel) => document.querySelector(sel)?.innerHTML.replace(/<title>.*?<\/title>/, "");
  ok("approved, CI passing and looks solved use different shapes", new Set([shapeOf("#d-reviews .rv-approved svg"), [...document.querySelectorAll("#d-meta .sbadge")].find((b) => b.textContent === "CI passing").querySelector("svg").innerHTML, [...document.querySelectorAll("#d-meta .sbadge")].find((b) => b.textContent === "Looks solved").querySelector("svg").innerHTML]).size === 3);
  ok("kind status in words in the top bar", /Open|Ready|Has conflicts/.test(document.querySelector("#d-ref .kind-words")?.textContent ?? ""));
  document.getElementById("d-close").click(); await wait(5);

  // Second-line icons stay on one line
  items([["pr-96", simple(96, "easy", 5, 1, { kind: "pr", ci: "failing", reviewDepth: "pending", authorType: "bot", threads: [{ summary: "a" }, { summary: "b" }] })]]);
  await wait(10);
  const metaRow = document.querySelector('.row[data-id="pr-96"] .r-meta');
  const tops = [...metaRow.querySelectorAll("svg")].map((s) => Math.round(s.getBoundingClientRect().top));
  const wait2 = metaRow.querySelector(".wait");
  ok("second-line icons share one line and counts stay beside their icon " + tops.join(","), new Set(tops).size === 1 && wait2 && Math.abs(wait2.lastChild.parentElement.getBoundingClientRect().height - wait2.querySelector("svg").getBoundingClientRect().height) < 6 && metaRow.scrollWidth <= metaRow.clientWidth + 1);

  // Controls panel hidden by default, dot when filtered
  const ctl = document.querySelector(".ctl-btn");
  ok("panel hidden by default", document.getElementById("fpanel").hidden && !document.getElementById("filter-text").offsetParent);
  ctl.click(); await wait(5);
  ok("panel opens " + [...document.querySelectorAll("#fpanel .chip")].map((b) => JSON.stringify(b.textContent)).join(","), !document.getElementById("fpanel").hidden);
  [...document.querySelectorAll("#fpanel .chip")].find((b) => b.textContent === "Quickest first").click();
  document.getElementById("fpanel").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await wait(5);
  ok("panel closes on Escape and dot shows", document.getElementById("fpanel").hidden && ctl.dataset.active === "true");
  [...document.querySelectorAll("#fpanel .chip")].find((b) => b.textContent === "Section order").click();
  ok("dot clears", ctl.dataset.active === "false");
