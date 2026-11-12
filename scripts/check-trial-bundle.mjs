import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";

const keyFile = process.env.TAPNOW_TRIAL_KEY_FILE;
if (!keyFile) throw new Error("TAPNOW_TRIAL_KEY_FILE is required; never pass the key on the command line");
const { apiKey } = JSON.parse(await fs.readFile(keyFile, "utf8"));
const sync = {};
const local = {};
const listeners = [];
let calls = 0;
let captured;
const area = values => ({
  get: async defaults => ({ ...defaults, ...values }),
  set: async update => { Object.assign(values, update); }
});
const context = vm.createContext({
  chrome: { runtime: { id: "trial-bundle-test", onMessage: { addListener: listener => listeners.push(listener) } }, storage: { sync: area(sync), local: area(local) } },
  console: { warn() {}, error() {} },
  URL, Response, TextEncoder, TextDecoder, AbortController, DOMException,
  Uint8Array, ArrayBuffer, Blob, ReadableStream, crypto: globalThis.crypto,
  performance, setTimeout, clearTimeout, btoa, atob,
  fetch: async (url, options) => {
    assert.equal(String(url), "https://api.acucompute.com/v1/responses");
    assert.ok(options.headers.Authorization === `Bearer ${apiKey}`, "bundled key must authenticate the request");
    captured = JSON.parse(options.body);
    calls++;
    return new Response(JSON.stringify({ output_text: JSON.stringify({ decision: "allow", summary: "fixture-ok", issues: [], suggestions: [] }) }), { headers: { "Content-Type": "application/json" } });
  }
});
vm.runInContext(await fs.readFile(".output/companion/chrome-mv3/background.js", "utf8"), context);
assert.equal(calls, 0, "startup must not call LLM");
const response = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("Background fixture timed out")), 5000);
  const accepted = listeners[0]({ type: "tapnow:llm-review", draft: {
    nodeId: "image-fixture", prompt: "fixture prompt",
    imageMaterials: [{ url: "https://files.tapnow.media/fixture", materialId: "image-1", role: "upstream-reference", dataUrl: "data:image/png;base64,AAAA" }]
  }, clientRequestId: "trial-fixture" }, {}, value => { clearTimeout(timer); resolve(value); });
  assert.equal(accepted, true);
});
assert.equal(response.ok, true, response.error);
assert.equal(calls, 1);
assert.equal(captured.model, "gpt-6.1-sol");
assert.ok(JSON.stringify(captured).includes("data:image/png;base64,AAAA"), "images must be included by default");
assert.equal(sync.llmEnabled, true);
assert.equal(sync.llmIncludeImages, true);
assert.ok(local.apiKey === apiKey, "key must be installed into local storage");
assert.equal("apiKey" in sync, false);
const popupFile = (await fs.readdir(".output/companion/chrome-mv3/chunks")).find(file => file.startsWith("popup-"));
const popup = await fs.readFile(`.output/companion/chrome-mv3/chunks/${popupFile}`, "utf8");
assert.ok(!popup.includes('id="llmEnabled"') && !popup.includes('id="llmIncludeImages"'));
console.log("PASS: built background uses embedded trial key, gpt-6.1-sol, image payload and real message handler; zero startup LLM calls; popup has no opt-in checkboxes. Network fully stubbed.");
