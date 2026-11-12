import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

// Contract fixtures from the public 2026-11 frontend, not authenticated live tests.
const output = path.resolve("artifacts/private/companion-compat");
await fs.mkdir(output, { recursive: true });
const profile = process.env.TAPNOW_TEST_PROFILE || await fs.mkdtemp(path.join(output, "profile-"));
const zip = process.argv[2];
const extension = zip
  ? path.join(profile, "extension")
  : path.resolve(process.env.TAPNOW_TEST_EXTENSION || ".output/companion/chrome-mv3");
if (zip) execFileSync("unzip", ["-q", path.resolve(zip), "-d", extension]);
const manifest = JSON.parse(await fs.readFile(path.join(extension, "manifest.json"), "utf8"));
const pkg = JSON.parse(await fs.readFile("package.json", "utf8"));
assert.equal(manifest.version, pkg.version);
const context = await chromium.launchPersistentContext(profile, {
  executablePath: process.env.TAPNOW_BROWSER_WRAPPER,
  chromiumSandbox: true,
  headless: false,
  ignoreDefaultArgs: true,
  args: ["--no-first-run", "--no-default-browser-check", "--disable-background-networking", `--user-data-dir=${profile}`, "--remote-debugging-pipe", ...(process.env.TAPNOW_BUNDLE_HARNESS || process.env.TAPNOW_UI_INSTALL ? [] : [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`]), "about:blank"],
  serviceWorkers: "allow",
  viewport: { width: 1440, height: 1000 }
});
const a = "00000000-0000-4000-8000-000000000001";
const b = "00000000-0000-4000-8000-000000000002";
const project = "00000000-0000-4000-8000-000000000003";
const requests = [];
let sandboxEvidence;
if (process.env.TAPNOW_VERIFY_SANDBOX) {
  const browserCdp = await context.browser().newBrowserCDPSession();
  const { processInfo } = await browserCdp.send("SystemInfo.getProcessInfo");
  const browserProcess = processInfo.find(item => item.type === "browser");
  const label = (await fs.readFile(`/proc/${browserProcess.id}/attr/current`, "utf8")).trim();
  assert.equal(label, "tapnow-cft157 (unconfined)");
  const status = await fs.readFile(`/proc/${browserProcess.id}/status`, "utf8");
  assert.equal(status.match(/^Uid:\s+(\d+)/m)?.[1], "1000");
  const securityPage = await context.newPage();
  try {
    await securityPage.goto("chrome://sandbox/");
    const cdp = await context.newCDPSession(securityPage);
    let strings = [];
    for (let i = 0; i < 30; i++) {
      strings = (await cdp.send("DOMSnapshot.captureSnapshot", { computedStyles: [] })).strings;
      if (strings.includes("You are adequately sandboxed.")) break;
      await securityPage.waitForTimeout(100);
    }
    assert.ok(strings.includes("You are adequately sandboxed."));
    const current = (await browserCdp.send("SystemInfo.getProcessInfo")).processInfo;
    const renderers = [];
    for (const process of current.filter(item => item.type === "renderer")) {
      const status = await fs.readFile(`/proc/${process.id}/status`, "utf8");
      renderers.push({ seccomp: status.match(/^Seccomp:\s+(\d+)/m)?.[1], noNewPrivs: status.match(/^NoNewPrivs:\s+(\d+)/m)?.[1] });
    }
    assert.ok(renderers.length && renderers.every(item => item.seccomp === "2" && item.noNewPrivs === "1"));
    sandboxEvidence = { label, uid: 1000, adequatelySandboxed: true, rendererSeccomp: 2, rendererNoNewPrivs: 1 };
    console.log("Sandbox evidence", JSON.stringify(sandboxEvidence));
  } finally {
    await securityPage.close();
  }
}
const regressions = [];
function checkLifecycle(name, check) {
  try { check(); }
  catch (error) {
    if (!process.env.TAPNOW_EXPECT_REGRESSIONS) throw error;
    regressions.push({ name, error: error.message });
  }
}
let contentBundle;
let direct = false;
let delay = 0;
const graph = (id) => ({
  nodes: [
    { id: "text-upstream", type: "text", data: { text: `UPSTREAM-${id}`, prompt: "NEVER-UPSTREAM-PROMPT" } },
    { id: "image-target", type: "image", data: { prompt: `SAVED-${id}` } },
    { id: "image-offscreen", type: "image", data: { src: "https://files.tapnow.media/reference", __metadata: { width: 640, height: 360 } } },
    { id: "text-next", type: "text", data: { text: "NEXT" } }
  ],
  connections: [
    { id: "incoming", source: "text-upstream", target: "image-target" },
    { id: "incoming-image", source: "image-offscreen", target: "image-target" },
    { id: "outgoing", source: "image-target", target: "text-next" }
  ]
});
const fixture = (v2) => `<!doctype html><html><head><style>
body{margin:0;background:#e7ece9;font:14px system-ui}main{padding:60px}.react-flow__node{width:380px;padding:24px;background:white;border:1px solid #aaa;margin:20px}textarea{width:320px;height:100px}[data-canvas-active=false]{display:none}
</style></head><body>${v2 ? `<main data-canvas-instance="${b}" data-canvas-active="false"><div class="react-flow__node selected" data-id="image-stale">STALE CANVAS</div></main><main data-canvas-instance="${a}" data-canvas-active="true">` : "<main>"}
<div class="react-flow__node selected" data-id="image-target" ${v2 ? 'data-plane-node="active"' : ""}>
<div data-testid="canvas-node-prompt-textarea"><span data-type="mention" data-id="WRONG-MENTION">Reference</span>${v2 ? "" : '<textarea>LIVE-CLASSIC</textarea>'}</div></div>
${v2 ? '<div data-node-generation-workbench><div data-generation-input-shell><div data-testid="canvas-node-prompt-textarea"><textarea>LIVE-V2</textarea></div></div></div>' : ""}
<div class="react-flow__pane">Canvas</div></main></body></html>`;

try {
  // Browser/worker requests not handled by the fixture must never reach the internet.
  await context.route("**/*", route => route.abort("blockedbyclient"));
  if (process.env.TAPNOW_UI_INSTALL) {
    const manager = await context.newPage();
    await manager.goto("chrome://extensions/");
    await manager.locator("#devMode").click();
    await manager.locator("#loadUnpacked").click();
    console.log(`Select unpacked directory in the isolated browser: ${extension}`);
    await manager.locator("extensions-item").first().waitFor({ timeout: 180000 });
    await manager.close();
  }
  if (process.env.TAPNOW_BUNDLE_HARNESS) {
    const background = await fs.readFile(path.join(extension, "background.js"), "utf8");
    const content = await fs.readFile(path.join(extension, "content-scripts/tapnow.js"), "utf8");
    contentBundle = content;
    await context.addInitScript(() => {
      const settings = { llmEnabled: true, llmIncludeImages: false };
      const local = { apiKey: "fixture-not-a-real-key", companionTrialDefaultsVersion: 1 };
      globalThis.fixtureRequests = [];
      const listeners = [];
      globalThis.chrome = {
        runtime: {
          id: "fixture-extension",
          onMessage: { addListener: listener => listeners.push(listener) },
          sendMessage: message => new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("Fixture message timed out")), 5000);
            for (const listener of listeners) {
              if (listener(message, { tab: { url: location.href } }, value => { clearTimeout(timer); resolve(value); })) return;
            }
            clearTimeout(timer);
            reject(new Error("No matching background listener"));
          })
        },
        storage: Object.fromEntries([["sync", settings], ["local", local]].map(([name, values]) => [name, {
          get: async defaults => ({ ...defaults, ...values }),
          set: async update => Object.assign(values, update),
          remove: async key => { delete values[key]; }
        }]))
      };
      const nativeFetch = globalThis.fetch;
      globalThis.fetch = async (url, options) => {
        if (!String(url).startsWith("https://api.acucompute.com/")) return nativeFetch(url, options);
        globalThis.fixtureRequests.push(JSON.parse(options.body));
        return new Response(JSON.stringify({ output_text: JSON.stringify({ decision: "allow", summary: "FIXTURE-REVIEW-OK", issues: [], suggestions: [] }) }), { headers: { "Content-Type": "application/json" } });
      };
    });
    await context.addInitScript({ content: `${background}\nwindow.addEventListener('DOMContentLoaded', () => { ${content}\n });` });
  }
  const page = await context.newPage();
  let nativeCdp;
  const isolatedContexts = [];
  if (!process.env.TAPNOW_BUNDLE_HARNESS) {
    nativeCdp = await context.newCDPSession(page);
    nativeCdp.on("Runtime.executionContextCreated", ({ context: execution }) => {
      if (execution.auxData?.type === "isolated" && execution.origin.startsWith("chrome-extension://")) isolatedContexts.push(execution);
    });
    await nativeCdp.send("Runtime.enable");
  }
  const focusEvents = [];
  page.on("console", message => {
    if (message.text().startsWith("[TapNow Companion] focus")) focusEvents.push(message.text());
  });
  await page.route("https://app.tapnow.ai/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith("/api/")) {
      requests.push({ method: route.request().method(), path: url.pathname });
      const id = url.pathname.split("/")[5];
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      await route.fulfill({ json: url.pathname.endsWith("/nodes") ? { data: { relations: {} } } : { code: 0, data: direct ? graph(id) : { canvas: graph(id) } } });
    } else await route.fulfill({ contentType: "text/html", body: fixture(url.pathname.startsWith("/p/")) });
  });
  await page.addInitScript(() => localStorage.setItem("access_token", "fixture-only"));
  const host = page.locator("#tapnow-companion-host");
  const panel = host.locator(".panel");
  async function draft() {
    return JSON.parse(await host.locator(".debug pre").first().textContent());
  }
  async function open() {
    await host.locator(".launcher").click();
    await panel.locator(".meta").waitFor();
    return draft();
  }
  for (const v2 of [false, true]) {
    direct = v2;
    await page.goto(`https://app.tapnow.ai/${v2 ? `p/${project}?c=${a}` : `canvas/${a}?classic=1`}`);
    await host.waitFor();
    await page.locator(".react-flow__node[data-id=image-target] [data-type=mention]").click();
    await page.locator("textarea").click();
    // Canvas chrome must not erase the focused node/editor.
    await page.locator(".react-flow__pane").click();
    const data = await open();
    assert.equal(data.canvasId, a);
    assert.equal(data.nodeId, "image-target");
    assert.equal(data.prompt, v2 ? "LIVE-V2" : "LIVE-CLASSIC");
    assert.ok(JSON.stringify(data).includes(`UPSTREAM-${a}`));
    assert.ok(!JSON.stringify(data.textMaterials).includes("NEVER-UPSTREAM-PROMPT"));
    assert.ok(!JSON.stringify(data).includes("image-stale"));
    assert.equal(data.images[0].sourceNodeId, "image-offscreen");
    assert.equal(data.images[0].url, "https://files.tapnow.media/reference");
    assert.equal(data.outgoingNodes[0].id, "text-next");
    await host.locator(".detect").click();
    await page.waitForFunction(() => !document.querySelector("#tapnow-companion-host").shadowRoot.querySelector(".detect").disabled);
    await page.screenshot({ path: path.join(output, v2 ? "v2-panel.png" : "classic-panel.png") });
    if (v2) {
      await host.locator(".close-action").click();
      await page.locator(".react-flow__node[data-id=image-target]").evaluate((node) => node.remove());
      const detached = await open();
      assert.equal(detached.nodeId, "image-target", "GPU unmount preserves remembered node identity");
      assert.equal(detached.nodeInfo.id, "image-target");
    }
  }
  await page.evaluate((id) => history.pushState({}, "", `?c=${id}`), b);
  await panel.waitFor({ state: "hidden" });
  await page.evaluate(() => {
    document.querySelector('[data-canvas-active="true"]').setAttribute("data-canvas-active", "false");
    const next = document.querySelector('[data-canvas-instance]');
    next.setAttribute("data-canvas-active", "true");
    next.querySelector(".react-flow__node").setAttribute("data-id", "image-target");
  });
  const nextDraft = await open();
  assert.equal(nextDraft.canvasId, b);
  assert.equal(nextDraft.prompt, `SAVED-${b}`);
  assert.ok(!JSON.stringify(nextDraft).includes(`UPSTREAM-${a}`));
  await host.locator(".close-action").click();
  delay = 1800;
  await host.locator(".launcher").click();
  await page.waitForTimeout(150);
  await page.evaluate((id) => history.pushState({}, "", `?c=${id}`), a);
  await page.waitForTimeout(4500);
  assert.equal(await panel.isVisible(), false, "old async draft must not reopen after route change");
  delay = 0;
  await page.evaluate((id) => history.pushState({}, "", `/p/${id}?t=c`), a);
  await page.waitForTimeout(1200);
  assert.equal(await host.locator(".launcher").isEnabled(), true);
  await page.evaluate((id) => history.pushState({}, "", `/p/${id}`), project);
  await page.waitForTimeout(1200);
  assert.equal(await host.locator(".launcher").isDisabled(), true);
  await page.evaluate(() => history.pushState({}, "", "/home"));
  await host.waitFor({ state: "hidden" });
  await page.evaluate((id) => history.pushState({}, "", `/canvas/${id}`), a);
  await host.waitFor({ state: "visible" });
  assert.equal(await host.count(), 1);
  assert.ok(requests.every((r) => r.method === "GET"));
  assert.ok(!requests.some((r) => r.path.includes(project)));
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await page.goto(`https://app.tapnow.ai/canvas/${a}?classic=1`);
    await host.waitFor();
    await page.locator("textarea").click();
    const data = await open();
    assert.equal(data.nodeId, "image-target");
    const box = await panel.boundingBox();
    assert.ok(box && box.x >= 0 && box.x + box.width <= viewport.width);
    await page.screenshot({ path: path.join(output, `panel-${viewport.width}.png`) });
    await host.locator(".close-action").click();
  }
  if (process.env.TAPNOW_LIFECYCLE) {
    await page.setViewportSize({ width: 1440, height: 1000 });
    direct = true;
    await page.goto(`https://app.tapnow.ai/p/${project}?c=${a}`);
    await host.waitFor();
    await page.locator("textarea").click();
    await page.locator("textarea").evaluate(field => {
      const replacement = field.cloneNode();
      replacement.value = "REDRAW-LIVE-42\nsecond line";
      field.replaceWith(replacement);
    });
    const redrawn = await open();
    checkLifecycle("redrawn live editor", () => assert.equal(redrawn.prompt, "REDRAW-LIVE-42\nsecond line", "redraw must read current editor, not saved API prompt"));
    await host.locator(".close-action").click();
    delay = 700;
    await host.locator(".launcher").click();
    await page.waitForTimeout(50);
    await page.evaluate(([a, b]) => {
      history.pushState({}, "", `?c=${b}`);
      history.pushState({}, "", `?c=${a}`);
    }, [a, b]);
    await page.waitForTimeout(1800);
    const stalePanel = await panel.isVisible();
    checkLifecycle("fast A-B-A route", () => assert.equal(stalePanel, false, "fast A-B-A navigation must invalidate old draft"));
    delay = 0;
    let worker = page;
    if (!process.env.TAPNOW_BUNDLE_HARNESS) {
      for (const candidate of context.serviceWorkers()) {
        if (!/^chrome-extension:\/\/.+\/background\.js$/.test(candidate.url())) continue;
        const candidateManifest = await candidate.evaluate(() => chrome.runtime.getManifest());
        if (candidateManifest.name === manifest.name && candidateManifest.version === manifest.version) {
          worker = candidate;
          break;
        }
      }
      assert.notEqual(worker, page, "the tested Companion Service Worker must be running");
    }
    if (!process.env.TAPNOW_BUNDLE_HARNESS) {
      assert.match(worker.url(), /^chrome-extension:\/\/.+\/background\.js$/);
      assert.equal(await worker.evaluate(() => chrome.runtime.getManifest().version), manifest.version);
      assert.equal(await page.evaluate(() => typeof chrome?.runtime?.sendMessage), "undefined", "page main world must not provide the extension runtime");
    }
    if (!process.env.TAPNOW_BUNDLE_HARNESS) await worker.evaluate(async () => {
      await chrome.storage.sync.set({ llmEnabled: true, llmIncludeImages: false });
      await chrome.storage.local.set({ apiKey: "fixture-not-a-real-key" });
      globalThis.fixtureRequests = [];
      globalThis.fetch = async (url, options) => {
        if (!String(url).startsWith("https://api.acucompute.com/")) throw new Error("External fetch blocked by fixture");
        globalThis.fixtureRequests.push(JSON.parse(options.body));
        return new Response(JSON.stringify({ output_text: JSON.stringify({ decision: "allow", summary: "FIXTURE-REVIEW-OK", issues: [], suggestions: [] }) }), { headers: { "Content-Type": "application/json" } });
      };
    });
    // Reload only the fixture so content settings are read from genuine extension storage.
    await page.reload();
    await host.waitFor();
    await page.locator("textarea").click();
    await open();
    await host.locator(".detect").click();
    await panel.getByText("FIXTURE-REVIEW-OK", { exact: true }).waitFor();
    assert.equal(await worker.evaluate(() => globalThis.fixtureRequests.length), 1, "one click must send one background review");
    await host.locator(".close-action").click();
    await page.evaluate(() => document.querySelector("#tapnow-companion-host").remove());
    await host.waitFor();
    await page.locator("textarea").click();
    await open();
    await host.locator(".detect").click();
    await panel.getByText("FIXTURE-REVIEW-OK", { exact: true }).waitFor();
    assert.equal(await worker.evaluate(() => globalThis.fixtureRequests.length), 2, "host remount must not duplicate background reviews");
    assert.equal(await host.count(), 1);
    const beforeFocus = focusEvents.length;
    await page.evaluate(() => {
      const root = document.querySelector('[data-canvas-instance][data-canvas-active="true"]');
      root.querySelector(".react-flow__node").append(root.querySelector("textarea"));
    });
    await page.locator("textarea").dispatchEvent("pointerdown");
    await page.waitForTimeout(50);
    checkLifecycle("removed host listeners", () => assert.equal(focusEvents.length - beforeFocus, 1, "removed host listeners must be disposed"));
    if (contentBundle || nativeCdp) {
      if (await panel.isVisible()) await host.locator(".close-action").click();
      if (nativeCdp) {
        const isolated = isolatedContexts.at(-1);
        assert.ok(isolated, "extension isolated world must exist");
        const reinjected = await nativeCdp.send("Runtime.evaluate", {
          expression: await fs.readFile(path.join(extension, "content-scripts/tapnow.js"), "utf8"),
          contextId: isolated.id, awaitPromise: true
        });
        assert.equal(reinjected.exceptionDetails, undefined);
      } else await page.addScriptTag({ content: contentBundle });
      await host.waitFor();
      const beforeReinjectedFocus = focusEvents.length;
      await page.locator("textarea").dispatchEvent("pointerdown");
      await page.waitForTimeout(50);
      checkLifecycle("reinjected listeners", () => assert.equal(focusEvents.length - beforeReinjectedFocus, 1, "WXT invalidation must remove the old script listeners"));
      await open();
      await host.locator(".detect").click();
      await panel.getByText("FIXTURE-REVIEW-OK", { exact: true }).waitFor();
      await page.waitForTimeout(1200);
      assert.equal(await worker.evaluate(() => globalThis.fixtureRequests.length), 3);
      assert.equal(await host.count(), 1, "invalidated mount timer must not recreate a duplicate host");
    }
    console.log(regressions.length ? JSON.stringify({ reproducedRegressions: regressions }, null, 2) : "PASS: redraw, fast A-B-A invalidation, built background review handler, remount and reinjection cleanup");
  }
  console.log("PASS: classic/V2 routes, payloads, live editor, mentions, cached canvases, SPA switches, async race, read-only GETs, desktop/mobile");
  console.log(`Tested extension ${manifest.version}: ${zip || extension}`);
  await fs.writeFile(path.join(output, "latest-run.json"), JSON.stringify({
    version: manifest.version,
    browserVersion: context.browser().version(),
    executionMode: process.env.TAPNOW_BUNDLE_HARNESS ? "built-bundles-with-local-runtime-adapter" : "native-extension",
    nativeExtensionRuntimeValidated: !process.env.TAPNOW_BUNDLE_HARNESS,
    fixtureOnly: true,
    externalRequestsBlocked: true,
    lifecycleCases: Boolean(process.env.TAPNOW_LIFECYCLE),
    regressions,
    sandboxEvidence,
    testedAt: new Date().toISOString()
  }, null, 2));
  if (process.env.TAPNOW_EXPECT_REGRESSIONS) assert.ok(regressions.length, "old bundle must reproduce a regression");
} finally {
  await context.close();
  if (!process.env.TAPNOW_TEST_PROFILE) await fs.rm(profile, { recursive: true, force: true });
}
