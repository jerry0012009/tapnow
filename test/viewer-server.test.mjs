import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";

test("viewer serves only recorded local media and supports byte ranges", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tapnow-viewer-test-"));
  const outside = path.join(root, "secret.txt");
  const backup = path.join(root, "backup");
  let child;
  try {
    await fs.mkdir(path.join(backup, "objects"), { recursive: true });
    await fs.writeFile(outside, "secret");
    await fs.writeFile(path.join(backup, "objects/sample"), "0123456789");
    await fs.symlink(outside, path.join(backup, "objects/outside"));
    const assets = [
      { referenceId: "a", status: "verified", file: "objects/sample", bytes: 10, contentType: "image/png", sha256: "synthetic" },
      { referenceId: "symlink", status: "verified", file: "objects/outside", bytes: 6, contentType: "image/png" },
      { referenceId: "revalidating", status: "queued", file: "objects/sample", bytes: 10, contentType: "image/png", sha256: "a".repeat(64) },
      { referenceId: "missing", status: "retryable", reason: "HTTP 404" }
    ];
    for (const name of ["nodes", "references", "connections"]) await fs.writeFile(path.join(backup, `${name}.ndjson`), "");
    await fs.writeFile(path.join(backup, "assets.ndjson"), assets.map(a => JSON.stringify(a)).join("\n"));
    await fs.writeFile(path.join(backup, "report.json"), JSON.stringify({ uniqueAssetCount: 3, verifiedBytes: 9999 }));
    child = spawn(process.execPath, ["scripts/serve-backup-viewer.mjs", backup], { env: { ...process.env, PORT: "0", HOST: "127.0.0.1" }, stdio: ["ignore", "pipe", "pipe"] });
    const base = await new Promise((resolve, reject) => {
      let output = "";
      const timeout = setTimeout(() => reject(new Error("server start timeout")), 10000);
      child.stdout.on("data", chunk => {
        output += chunk; const url = /http:\/\/127\.0\.0\.1:\d+\//.exec(output);
        if (url) { clearTimeout(timeout); resolve(url[0].slice(0, -1)); }
      });
      child.on("error", reject);
    });
    let response = await fetch(`${base}/api/media/a`);
    assert.equal(response.status, 200); assert.equal(await response.text(), "0123456789");
    assert.equal(response.headers.get("content-type"), "image/png");
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    response = await fetch(`${base}/api/media/a`, { headers: { range: "bytes=3-6" } });
    assert.equal(response.status, 206); assert.equal(response.headers.get("content-range"), "bytes 3-6/10");
    assert.equal(await response.text(), "3456");
    response = await fetch(`${base}/api/media/a`, { headers: { range: "bytes=-2" } });
    assert.equal(await response.text(), "89");
    response = await fetch(`${base}/api/media/a`, { method: "HEAD" });
    assert.equal(response.headers.get("content-length"), "10"); assert.equal(await response.text(), "");
    assert.equal((await fetch(`${base}/api/media/a`, { headers: { range: "bytes=50-80" } })).status, 416);
    assert.equal((await fetch(`${base}/api/media/symlink`)).status, 403);
    assert.equal((await fetch(`${base}/api/media/missing`)).status, 404);
    assert.equal(await (await fetch(`${base}/api/media/revalidating`)).text(), "0123456789", "previously saved files remain viewable during incremental validation");
    assert.equal((await fetch(`${base}/api/object?path=objects/../../secret.txt`)).status, 404);
    assert.equal((await fetch(`${base}/api/assets?limit=NaN`)).status, 400);
    assert.equal((await fetch(`${base}/api/assets`, { method: "POST" })).status, 405);
    const report = await (await fetch(`${base}/api/report`)).json();
    assert.equal(report.verifiedBytes, 16);
    assert.equal(report.statuses["unavailable-after-recovery"], 1);
    assert.deepEqual(report.coverage.statusCounts, { verified: 2, "unavailable-after-recovery": 1, queued: 1 });
    assert.equal(report.coverage.assetsWithFile, 3);
    await fs.writeFile(path.join(backup, "assets.ndjson"), "{bad JSON\n");
    assert.equal((await fetch(`${base}/api/assets`)).status, 500, "corrupt rows must not be silently skipped");
  } finally {
    if (child) { child.kill(); await once(child, "exit"); }
    await fs.rm(root, { recursive: true, force: true });
  }
});
