import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { chromium } from "playwright";

const [zipArg, backupArg] = process.argv.slice(2);
if (!zipArg || !backupArg) throw new Error("Usage: npm run extension:test-release -- RELEASE.zip REAL_CANVAS_DIRECTORY (Linux: DISPLAY + xdotool)");
const archive = path.resolve(zipArg), backup = path.resolve(backupArg);
const report = JSON.parse(await fs.readFile(path.join(backup, "report.json"), "utf8"));
const nodes = (await fs.readFile(path.join(backup, "nodes.ndjson"), "utf8")).trim().split("\n").map(JSON.parse);
const output = await fs.mkdtemp(path.resolve("artifacts/private/library-release-"));
const extension = path.join(output, "extension");
execFileSync("unzip", ["-q", archive, "-d", extension]);
const manifest = JSON.parse(await fs.readFile(path.join(extension, "manifest.json"), "utf8"));
const sha256 = createHash("sha256").update(await fs.readFile(archive)).digest("hex");
const context = await chromium.launchPersistentContext(path.join(output, "profile"), {
  channel: "chromium", headless: false, viewport: { width: 1440, height: 1000 },
  args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, "--no-sandbox"]
});
const errors = [], remote = [];
const result = { version: manifest.version, archiveSha256: sha256, canvasId: report.canvasId };
const page = await context.newPage();
page.on("pageerror", error => errors.push(error.message));
page.on("request", request => { if (/^https?:/.test(request.url())) remote.push(request.url()); });
const key = (...args) => execFileSync("xdotool", args);
try {
  const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
  const origin = new URL(worker.url()).host;
  await page.goto(`chrome-extension://${origin}/library.html`);
  await page.waitForFunction(() => !!window.lucide);
  // Exercise the graph's exact call signature before selecting any data.
  await page.evaluate(() => {
    const item = document.createElement("i");
    item.dataset.lucide = "search"; item.id = "release-icon-probe";
    document.body.append(item);
    window.lucide.createIcons({ attrs: { width: 18, height: 18 } });
    if (document.querySelector("#release-icon-probe")?.tagName.toLowerCase() !== "svg") throw new Error("Graph icon not rendered");
    document.querySelector("#release-icon-probe").remove();
  });
  await page.locator("#open-directory").click();
  await page.waitForTimeout(1000);
  key("key", "ctrl+l");
  key("type", "--clearmodifiers", "--delay", "1", backup);
  key("key", "Return");
  console.log(`Directory path entered. Finish the native chooser and allow read permission. Evidence: ${output}`);
  await page.locator("#inspector h2").waitFor({ timeout: 120000 });
  const counts = await page.evaluate(() => {
    const cy = document.querySelector("#graph")._cyreg.cy;
    return { nodes: cy.nodes().length, edges: cy.edges().length };
  });
  assert.equal(counts.nodes, report.nodeCount);
  assert.equal(counts.edges, report.connectionCount);
  assert.equal(await page.locator("#preview img").count(), 0, "No eager original-image loading");
  assert.ok(await page.locator("#zoom-in svg").count(), "Graph icons must render");
  await page.screenshot({ path: path.join(output, "overview.png"), fullPage: true });
  const zoom = await page.locator("#zoom").innerText();
  await page.locator("#zoom-in").click();
  assert.notEqual(await page.locator("#zoom").innerText(), zoom);
  await page.locator("#fit").click();
  await page.locator(".asset-load:not(:disabled)").first().click();
  await page.waitForFunction(() => document.querySelector("#preview img")?.naturalWidth > 0, null, { timeout: 60000 });
  result.image = await page.locator("#preview img").evaluate(img => ({
    width: img.naturalWidth, height: img.naturalHeight, localBlob: img.src.startsWith("blob:")
  }));
  assert.equal(result.image.localBlob, true);
  assert.ok(result.image.width > 100);
  await page.screenshot({ path: path.join(output, "local-image.png"), fullPage: true });
  const actual = await page.evaluate(() => document.querySelector("#graph")._cyreg.cy.nodes().map(n => ({ id: n.id(), ...n.position() })));
  assert.equal(actual.length, nodes.length);
  for (const node of actual) {
    const saved = nodes.find(n => n.id === node.id);
    assert.ok(saved, `Unexpected node ${node.id}`);
  }
  for (const [name, viewport] of [["laptop", { width: 1280, height: 800 }], ["mobile", { width: 390, height: 844 }]]) {
    await page.setViewportSize(viewport);
    await page.locator("#fit").click();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${name} overflow`);
    await page.screenshot({ path: path.join(output, `${name}.png`), fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.locator('button[data-view="assets"]').click();
  await page.locator("tbody tr").first().waitFor();
  await page.locator('button[data-view="graph"]').click();
  await page.locator("#inspector h2").waitFor();
  await page.locator("#verify-local").click();
  await page.waitForFunction(() => /本地快照完整性核对通过|核对未通过/.test(document.querySelector("#local-status").textContent), null, { timeout: 180000 });
  result.verification = await page.locator("#local-status").innerText();
  assert.match(result.verification, /本地快照完整性核对通过/);
  await page.screenshot({ path: path.join(output, "verified.png"), fullPage: true });
  assert.deepEqual(errors, []);
  assert.deepEqual(remote, [], "Local viewer must not request cloud resources");
  Object.assign(result, { ...counts, errors, remote, passed: true });
  await fs.writeFile(path.join(output, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  await page.screenshot({ path: path.join(output, "failure.png"), fullPage: true }).catch(() => {});
  throw error;
} finally {
  await context.close();
}
