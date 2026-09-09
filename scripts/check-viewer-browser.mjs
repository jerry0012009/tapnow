import { chromium } from "playwright";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
const base = process.argv[2] || "http://127.0.0.1:8788";
const output = "artifacts/private/viewer-acceptance";
await fs.mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const result = [];
try {
  for (const [name, viewport] of [["desktop", { width: 1440, height: 1000 }], ["laptop", { width: 1280, height: 800 }], ["mobile", { width: 390, height: 844 }]]) {
    const page = await browser.newPage({ viewport, ...(name === "mobile" ? { isMobile: true, hasTouch: true } : {}) });
    const errors = [], remote = [], media = [];
    page.on("pageerror", e => errors.push(e.message));
    page.on("request", request => {
      if (!request.url().startsWith(base)) remote.push(request.url());
      if (request.url().includes("/api/media/")) media.push(request.url());
    });
    await page.goto(base);
    await page.locator("#inspector h2").waitFor();
    assert.equal(media.length, 0, "graph must not preload original files");
    const counts = await page.locator("#graph-count").innerText();
    assert.match(counts, /1,238/);
    assert.match(counts, /全部节点/);
    await page.screenshot({ path: `${output}/${name}-overview.png`, fullPage: true });
    await page.locator(".segmented label").filter({ hasText: "当前关系" }).click();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "page horizontal overflow");
    const beforeZoom = await page.locator("#zoom").innerText();
    await page.locator("#zoom-in").click();
    assert.notEqual(await page.locator("#zoom").innerText(), beforeZoom);
    await page.locator("#fit").click();
    const graph = await page.evaluate(async () => (await fetch("/api/graph")).json());
    const graphBox = await page.locator("#graph").boundingBox();
    const clickTarget = await page.evaluate(() => {
      const cy = document.querySelector("#graph")._cyreg.cy;
      const node = cy.nodes().filter(n => !n.hasClass("out-of-scope") && !n.selected())[0];
      return { id: node.id(), ...node.renderedPosition() };
    });
    await page.mouse.click(graphBox.x + clickTarget.x, graphBox.y + clickTarget.y);
    await page.waitForFunction(id => document.querySelector("#inspector .inspector-heading code")?.textContent === id, clickTarget.id);
    await page.waitForFunction(() => document.querySelector("#preview img")?.naturalWidth > 0, {}, { timeout: 60000 });
    assert.equal(media.length, 1, "one node click should load one local preview without a second click");
    const panBefore = await page.evaluate(() => ({ ...document.querySelector("#graph")._cyreg.cy.pan() }));
    await page.mouse.move(graphBox.x + 15, graphBox.y + 100);
    await page.mouse.down();
    await page.mouse.move(graphBox.x + 75, graphBox.y + 130, { steps: 10 });
    await page.mouse.up();
    const panAfter = await page.evaluate(() => ({ ...document.querySelector("#graph")._cyreg.cy.pan() }));
    assert.notDeepEqual(panAfter, panBefore, "dragging must pan the actual canvas");
    await page.locator("#fit").click();
    await page.screenshot({ path: `${output}/${name}-placeholder.png`, fullPage: true });
    await page.waitForTimeout(1500);
    const dimensions = await page.locator("#preview img").evaluate(img => ({ width: img.naturalWidth, height: img.naturalHeight }));
    assert.ok(dimensions.width > 100 && dimensions.height > 100);
    await page.screenshot({ path: `${output}/${name}-local-image.png`, fullPage: true });
    await page.locator(".segmented label").filter({ hasText: "全部节点" }).click();
    await page.waitForTimeout(500);
    assert.match(await page.locator("#graph-count").innerText(), /原始位置/);
    await page.locator("#focus").click();
    const actualPositions = await page.evaluate(() => document.querySelector("#graph")._cyreg.cy.nodes().map(n => ({ id: n.id(), ...n.position() })));
    for (const actual of actualPositions) {
      const saved = graph.nodes.find(n => n.id === actual.id);
      assert.ok(Math.abs(actual.x - saved.position.x - saved.width / 2) < .001, `saved X changed: ${actual.id}`);
      assert.ok(Math.abs(actual.y - saved.position.y - saved.height / 2) < .001, `saved Y changed: ${actual.id}`);
    }
    await page.screenshot({ path: `${output}/${name}-original.png`, fullPage: true });
    await page.locator("#node-search").fill("not-a-real-node-zzzz");
    assert.equal(await page.locator("#node-picker").isDisabled(), true);
    await page.locator("#node-search").fill("n83");
    assert.ok(await page.locator("#node-picker option").count());
    await page.locator("#node-search").press("Enter");
    const multi = graph.nodes.find(n => (n.roleCounts?.["备选"] || 0) >= 2);
    if (multi) {
      await page.locator("#node-search").fill(multi.id);
      await page.locator("#node-search").press("Enter");
      await page.waitForFunction(id => document.querySelector("#inspector .inspector-heading code")?.textContent === id, multi.id);
      await page.waitForFunction(id => document.querySelector("#graph")._cyreg.cy.getElementById(id).hasClass("with-media"), multi.id, { timeout: 60000 });
      const gallery = await page.evaluate(id => {
        const node = document.querySelector("#graph")._cyreg.cy.getElementById(id);
        return { background: node.style("background-image"), label: node.data("mediaLabel") };
      }, multi.id);
      assert.match(gallery.background, /data:image\/webp/);
      assert.match(gallery.label, /\d+ 张本地图片/);
      assert.match(await page.locator("#asset-list").innerText(), /图片 1\//);
    }
    await page.waitForTimeout(400);
    await page.locator('button[data-view="assets"]').click();
    await page.locator("tbody tr").first().waitFor();
    await page.locator('button[data-view="graph"]').click();
    await page.locator("#inspector h2").waitFor();
    const textNode = graph.nodes.find(n => n.type === "text") || graph.nodes.find(n => n.prompt);
    assert.ok(textNode, "a node with text or prompt is required");
    await page.locator("#node-search").fill(textNode.id);
    await page.locator("#node-search").press("Enter");
    await page.waitForFunction(id => document.querySelector("#inspector .inspector-heading code")?.textContent === id, textNode.id);
    assert.ok(await page.locator("#inspector .prompt").count(), "text/prompt properties must be visible");
    const failedNode = graph.nodes.find(n => n.failedCount);
    assert.ok(failedNode, "real failed-resource fixture is required");
    await page.locator("#node-search").fill(failedNode.id);
    await page.locator("#node-search").press("Enter");
    await page.locator(".asset-load:disabled").first().waitFor();
    assert.match(await page.locator("#asset-list").innerText(), /恢复后仍不可得|下载失败/);
    assert.deepEqual(errors, [], "browser runtime errors");
    assert.deepEqual(remote, [], "remote requests");
    result.push({ name, counts, dimensions, originalRequests: media.length, originalCoordinatesChecked: actualPositions.length,
      nodeClick: true, oneClickPreview: true, canvasPan: true, promptProperties: true, standaloneTextNode: textNode.type === "text", failedResource: true,
      noPageOverflow: true, noRuntimeErrors: true, noRemoteRequests: true });
    await page.close();
  }
} finally { await browser.close(); }
await fs.writeFile(`${output}/results.json`, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
