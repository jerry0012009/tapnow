import { chromium } from "playwright";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";

const root = path.resolve("artifacts/private/viewer-node-types");
await fs.mkdir(root, { recursive: true });
const types = ["text", "image", "video", "audio", "file", "document", "group", "future-type"];
const text = "镜头说明：车辆从画面左侧驶入，沿道路转弯。\n保留原始文字、换行以及全部节点属性。";
const nodes = types.map((type, i) => ({
  id: `test-${type}`, short_id: `n${i + 1}`, type, position: { x: i % 4 * 450, y: Math.floor(i / 4) * 350 },
  measured: { width: 320, height: 180 },
  data: { title: ["拍摄文字说明", "参考图片", "视频产物", "声音轨道", "附件", "说明文档", "节点分组", "自定义节点"][i],
    ...(type === "text" ? { text, prompt: "保留完整文字", custom: { format: "plain-text" } } : {}) }
}));
const edges = nodes.slice(1).map((node, i) => ({ id: `edge-${i}`, source: nodes[i].id, target: node.id }));
for (const [name, rows] of Object.entries({ nodes, connections: edges, references: [], assets: [] })) {
  await fs.writeFile(path.join(root, `${name}.ndjson`), rows.map(row => JSON.stringify(row)).join("\n"));
}
await fs.writeFile(path.join(root, "canvas.json"), JSON.stringify({ name: "混合节点测试（模拟数据）" }));
await fs.writeFile(path.join(root, "report.json"), JSON.stringify({ canvasName: "混合节点测试（模拟数据）", producer: "test-fixture",
  nodeCount: nodes.length, connectionCount: edges.length, referenceCount: 0, uniqueAssetCount: 0, verifiedCount: 0, status: "completed" }));
const server = spawn(process.execPath, ["scripts/serve-backup-viewer.mjs", root], {
  env: { ...process.env, HOST: "127.0.0.1", PORT: "0" }, stdio: ["ignore", "pipe", "pipe"]
});
let browser;
try {
  const base = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Viewer server startup timed out")), 10000);
    server.stdout.on("data", chunk => { const match = String(chunk).match(/http:\/\/127\.0\.0\.1:\d+/); if (match) { clearTimeout(timeout); resolve(match[0]); } });
    server.once("error", reject);
  });
  browser = await chromium.launch({ headless: true });
  const results = [];
  for (const [name, viewport] of [["desktop", { width: 1440, height: 1000 }], ["mobile", { width: 390, height: 844 }]]) {
    const page = await browser.newPage({ viewport });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(base);
    await page.locator("#inspector h2").waitFor();
    assert.equal(await page.locator(".prompt").last().innerText(), text);
    await page.locator(".segmented label").filter({ hasText: "全部节点" }).click();
    await page.locator("#fit").click();
    const rendered = await page.evaluate(() => {
      const cy = document.querySelector("#graph")._cyreg.cy;
      return cy.nodes().map(n => ({ id: n.id(), display: n.style("display"), label: n.data("label") }));
    });
    assert.deepEqual(rendered.map(n => n.id).sort(), nodes.map(n => n.id).sort());
    assert.ok(rendered.every(n => n.display !== "none"));
    assert.ok(rendered.find(n => n.id === "test-text").label.includes("镜头说明"));
    await page.screenshot({ path: path.join(root, `${name}-all-types.png`), fullPage: true });
    for (const node of nodes) {
      await page.locator("#node-search").fill(node.id);
      await page.locator("#node-search").press("Enter");
      await page.waitForFunction(id => document.querySelector(".inspector-heading code")?.textContent === id, node.id);
      assert.equal(await page.locator("#inspector h2").innerText(), node.data.title);
    }
    await page.locator("#node-search").fill("镜头说明");
    await page.locator("#node-search").press("Enter");
    await page.waitForFunction(() => document.querySelector(".inspector-heading code")?.textContent === "test-text");
    await page.locator(".segmented label").filter({ hasText: "当前关系" }).click();
    await page.screenshot({ path: path.join(root, `${name}-text-detail.png`), fullPage: true });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.deepEqual(errors, []);
    results.push({ viewport: name, allNodeTypes: types, allNodesRendered: rendered.length, fullTextMatches: true, textSearch: true, allInspectorsChecked: true });
    await page.close();
  }
  await fs.writeFile(path.join(root, "results.json"), JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
} finally {
  await browser?.close();
  server.kill();
  if (server.exitCode === null) await once(server, "exit");
}
