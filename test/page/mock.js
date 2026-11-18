<script>
try { localStorage.clear(); } catch {}
window.__subs = {}; window.__writes = []; window.__calls = [];
// The fake action server answers per call: window.__reply(body) returns { ok, result } or throws like the shim
window.__reply = () => ({ ok: true, result: { dryRun: true } });
const mkSnap = (docs) => ({ docs: docs.map(([id, d]) => ({ id, data: () => d })), metadata: { fromCache: false } });
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
window.__board = window.__board || { name: "widgets", repo: "acme/widgets", repoUrl: "https://github.com/acme/widgets", me: acct("octocat"), bot: acct("widgets-bot"), accountMode: "bot", botCommands: { escalate: "@widgets-bot escalate" }, relatedRepos: ["widgets-desktop"], reviewBots: ["copilot"], dryRun: false, decision: async (body) => { window.__decisions.push(body); if (window.__decisionFails) throw new Error("down"); } };
window.__decisions = [];
window.claude = { use: async (n) => (n === "db" ? db : n === "mcp" ? mcp : n === "board" ? window.__board : null) };
</script>
