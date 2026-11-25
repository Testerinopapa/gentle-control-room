// Run: node --test integrations/chatgpt-browser/tests/stage2-live-github.test.mjs
// Simulated ChatGPT DOM, actual extension code, real public GitHub HTTP.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { JSDOM } from "jsdom";
const source = name => readFileSync(new URL("../extension/" + name, import.meta.url), "utf8");
const repo = "testerinopapa/gentle-control-room";
const shas = ["68d7812184d74b7c10f623b643d26770f92721a5", "19f70cc9a13bd9f02a3f50764aeed72065880fbb"];
const href = sha => "https://github.com/" + repo + "/commit/" + sha;
const url = "https://chatgpt.com/c/stage2-regression";
function setup(html, transport = fetch) {
  const dom = new JSDOM(html, { url, runScripts: "outside-only" });
  const requests = [], raw = new Map();
  let listener, storageAccesses = 0;
  const chrome = {
    sidePanel: { setPanelBehavior: async () => {} },
    runtime: { getURL: name => "chrome-extension://diagnostic/" + name,
      onMessage: { addListener: fn => { listener = fn; } } },
    tabs: { get: async () => ({ id: 9, url }),
      onRemoved: { addListener() {} }, onUpdated: { addListener() {} } },
    scripting: { executeScript: async details => {
      assert.equal(details.target.tabId, 9);
      if (details.files) { for (const file of details.files) dom.window.eval(source(file)); return []; }
      return [{ result: await dom.window.eval("(" + details.func.toString() + ")()") }];
    }},
    storage: { get local() { storageAccesses++; throw Error("Unexpected normal history access"); },
      get session() { storageAccesses++; throw Error("Unexpected session history access"); } }
  };
  const ctx = vm.createContext({ chrome, URL, Date, JSON, TextEncoder, AbortController, setTimeout, clearTimeout,
    fetch: async (address, options) => {
      requests.push(address);
      const result = await transport(address, options);
      if (result.ok) raw.set(address, await result.clone().json());
      return result;
    } });
  ctx.importScripts = name => vm.runInContext(source(name), ctx);
  vm.runInContext(source("background.js"), ctx);
  vm.runInContext(source("codex-evidence.js"), ctx);
  return { requests, raw, storageAccesses: () => storageAccesses,
    send: () => new Promise(resolve => listener({ type: "testCodexGitHub", tabId: 9 },
      { url: "chrome-extension://diagnostic/sidepanel.html" }, resolve)),
    build: response => ctx.GcrCodexEvidence.build(response.data, response.snapshot),
    close: () => dom.window.close() };
}
const turn = (role, id, body) => '<div data-message-author-role="' + role +
  '" data-message-id="' + id + '">' + body + '</div>';
test("DOM links -> actual GitHub diffs -> linked Codex payload", { timeout: 45000 }, async () => {
  const h = setup(turn("user", "u1", "Connect GitHub patches to the Codex analysis workflow.") +
    turn("assistant", "a1", '<a href="' + href(shas[0]) + '">Implementation commit</a>') +
    turn("user", "u2", "Improve error diagnostics.") +
    turn("assistant", "a2", '<span role="link" data-url="' + href(shas[1]) + '">Error fix commit</span>'));
  try {
    const r = await h.send();
    assert.equal(r.ok, true, r.error);
    assert.equal(r.diagnostics.discovered, 2);
    assert.equal(r.diagnostics.retrieved, 2, JSON.stringify(r.diagnostics));
    assert.equal(r.diagnostics.unavailable, 0);
    assert.ok(r.diagnostics.sourceFiles.some(file => file.endsWith("background.js")));
    assert.equal(h.requests.length, 2);
    const built = h.build(r), payload = JSON.parse(built.json);
    assert.equal(built.commitCount, 2);
    assert.equal(built.matchedRequests, 2);
    for (const sha of shas) {
      const key = repo + "@" + sha, commit = payload.commits[key];
      assert.equal(commit.provenance, "conversation_link");
      assert.ok(commit.files.length);
      const raw = h.raw.get("https://api.github.com/repos/" + repo + "/commits/" + sha);
      for (const file of commit.files)
        assert.equal(file.patch, raw.files.find(f => f.filename === file.path)?.patch);
      assert.ok(payload.conversationCorrelation.requests.some(request =>
        request.candidateCommits.some(ref => ref.commit === key &&
          ref.evidence === "commit_link_in_assistant_reply")));
    }
    assert.equal(h.storageAccesses(), 0);
    console.log("PASS: " + built.commitCount + " real commits, " + r.diagnostics.sourceFiles.length +
      " source files, " + built.matchedRequests + " explicit request matches, " + built.bytes + " payload bytes");
  } finally { h.close(); }
});
test("missing links never trigger a hardcoded or history lookup", async () => {
  const h = setup(turn("user", "u1", "Fix a bug") + turn("assistant", "a1", "Done."),
    async () => { throw Error("No GitHub fetch expected"); });
  try {
    const r = await h.send();
    assert.equal(r.ok, false);
    assert.match(r.error, /no full GitHub commit URLs/i);
    assert.equal(h.requests.length, 0);
    assert.equal(h.storageAccesses(), 0);
  } finally { h.close(); }
});
test("GitHub HTTP failures remain visible, never fabricate patches", async () => {
  const h = setup(turn("user", "u1", "Fix the error") + turn("assistant", "a1",
    '<a href="' + href(shas[0]) + '">Commit</a>'), async () => new Response("", { status: 403 }));
  try {
    const r = await h.send();
    assert.equal(r.ok, true, r.error);
    assert.equal(r.diagnostics.discovered, 1);
    assert.equal(r.diagnostics.retrieved, 0);
    assert.equal(r.diagnostics.unavailable, 1);
    assert.match(r.diagnostics.failures[0].error, /403/);
    assert.equal(h.storageAccesses(), 0);
  } finally { h.close(); }
});
