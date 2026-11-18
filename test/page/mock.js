<script>
try { localStorage.clear(); } catch {}
window.__subs = {}; window.__writes = []; window.__calls = [];
// The fake action server answers per call: window.__reply(body) returns { ok, result } or throws like the shim
window.__reply = () => ({ ok: true, result: { dryRun: true } });
// The server keys every doc as <instance>/<id> and adds instance, id, ref and repo. Fixtures without an instance belong to widgets.
const REPOS = { widgets: "acme/widgets", gadgets: "contoso/gadgets" };
const mkSnap = (docs) => ({
  docs: docs.map(([key, d]) => {
    const slash = key.indexOf("/");
    const instance = (d && d.instance) || (slash > 0 ? key.slice(0, slash) : "widgets");
    const id = (d && d.id) || (slash > 0 ? key.slice(slash + 1) : key);
    const repo = (d && d.repo) || REPOS[instance] || "";
    const data = d && typeof d === "object"
      ? { ...d, instance, id, ...(typeof d.number === "number" && !d.ref ? { ref: repo + "#" + d.number, repo } : {}) }
      : d;
    return { id: key, data: () => data };
  }),
  metadata: { fromCache: false },
});
const db = {
  collection(name) {
    const q = { onSnapshot(cb) { window.__subs[name] = cb; return () => {}; }, orderBy() { return q; }, limit() { return q; } };
    return q;
  },
  doc(path) {
    return {
      onSnapshot(cb) { window.__subs[path] = cb; return () => {}; },
      async update(v) { window.__writes.push(["update", path, v]); },
      async set(v) { window.__writes.push(["set", path, v]); },
    };
  },
};
const mcp = {
  async listTools() { return { servers: [{ server: "host:gary", tools: ["reply"] }] }; },
  async callTool(server, tool, input) {
    window.__calls.push({ tool, ...input });
    const r = window.__reply({ tool, ...input });
    if (r && r.ok) return { payload: r };
    throw Object.assign(new Error("failed"), { code: "tool_error", result: { content: [{ type: "text", text: JSON.stringify(r) }] } });
  },
};
window.__mkSnap = mkSnap;
const acct = (login) => ({ login, avatarUrl: "https://github.com/" + login + ".png?size=80" });
const instanceInfo = (name, title, extra) => ({ name, title, kind: "maintainer", repos: [REPOS[name]], repoUrl: "https://github.com/" + REPOS[name], bot: acct(name + "-bot"), accountMode: "bot", paused: false, relatedRepos: [name + "-desktop"], botCommands: { escalate: "@" + name + "-bot escalate" }, reviewBots: ["copilot"], ...extra });
window.__instanceInfo = instanceInfo;
window.__board = window.__board || { me: acct("octocat"), dryRun: false, instances: [instanceInfo("widgets", "widgets")], decision: async (body) => { window.__decisions.push(body); if (window.__decisionFails) throw new Error("down"); } };
window.__decisions = [];
window.claude = { use: async (n) => (n === "db" ? db : n === "mcp" ? mcp : n === "board" ? window.__board : null) };
</script>
