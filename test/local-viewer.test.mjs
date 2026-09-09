import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { discoverBackups, loadLocalBackup, readFile, verifyLocalBackup } from "../viewer/local-source.js";

class Directory {
  kind = "directory";
  constructor(name = "canvas") { this.name = name; this.files = new Map(); this.dirs = new Map(); }
  async getDirectoryHandle(name) {
    if (!this.dirs.has(name)) throw new DOMException("missing directory", "NotFoundError");
    return this.dirs.get(name);
  }
  async getFileHandle(name) {
    if (!this.files.has(name)) throw new DOMException("missing file", "NotFoundError");
    return { getFile: async () => new File([this.files.get(name)], name) };
  }
  async *values() { yield* this.dirs.values(); }
}
function fixture() {
  const root = new Directory(), objects = new Directory("objects");
  root.dirs.set("objects", objects); objects.files.set("abc.png", "abc");
  const sha256 = createHash("sha256").update("abc").digest("hex");
  const asset = { assetId: "a", file: "objects/abc.png", bytes: 3, sha256, contentType: "image/png", status: "verified" };
  root.files.set("report.json", JSON.stringify({ canvasId: "c", nodeCount: 2, connectionCount: 1, referenceCount: 2, uniqueAssetCount: 2,
    runId: "run-1", status: "completed", updatedAt: "2026-09-09", diagnostics: { nodes: { complete: true }, connections: { complete: true } } }));
  root.files.set("canvas.json", '{"id":"c"}');
  root.files.set("nodes.ndjson", JSON.stringify({ id: "n", type: "text", position: { x: 10, y: 20 }, data: { text: "Real text retained" } }) +
    "\n" + JSON.stringify({ id: "m", type: "image", position: { x: 40, y: 50 } }));
  root.files.set("connections.ndjson", '{"id":"e","source":"n","target":"m"}');
  root.files.set("references.ndjson", '{"referenceId":"r","nodeId":"n","assetId":"a"}\n{"referenceId":"s","nodeId":"m","assetId":"b"}');
  root.files.set("assets.ndjson", JSON.stringify(asset) + "\n" + JSON.stringify({ ...asset, assetId: "b" }));
  return { root, objects, asset };
}
test("local viewer finds direct, backup-root and chosen-directory layouts", async () => {
  const { root } = fixture(), base = new Directory("tapnow-backup"), chosen = new Directory("chosen");
  base.dirs.set("c", root); chosen.dirs.set("tapnow-backup", base);
  for (const dir of [root, base, chosen]) assert.equal((await discoverBackups(dir)).length, 1);
});
test("local viewer retains text, edges, all target records and hashes shared files once", async () => {
  const { root } = fixture(), source = await loadLocalBackup(root);
  assert.equal((await source.get("/api/graph")).nodes.length, 2);
  assert.equal((await source.get("/api/node/n")).node.data.text, "Real text retained");
  assert.equal((await source.get("/api/assets?limit=1")).hasMore, true);
  const result = await verifyLocalBackup(source);
  assert.equal(result.passed, true);
  assert.equal(result.checkedFiles, 1);
  assert.equal(result.verifiedTargets, 2);
  assert.equal(result.physicalBytes, 3);
  assert.equal(source.report.verification, null, "never trust an old report as a current check");
});
test("missing, same-size corruption and conflicting shared-file hashes never pass", async () => {
  for (const kind of ["missing", "corrupt", "conflict"]) {
    const { root, objects, asset } = fixture();
    if (kind === "missing") objects.files.delete("abc.png");
    if (kind === "corrupt") objects.files.set("abc.png", "abd");
    if (kind === "conflict") root.files.set("assets.ndjson", JSON.stringify(asset) + "\n" + JSON.stringify({ ...asset, assetId: "b", sha256: "0".repeat(64) }));
    const result = await verifyLocalBackup(await loadLocalBackup(root));
    assert.equal(result.passed, false);
    assert.ok(result.issues.length);
  }
});
test("metadata mismatch, malformed rows and orphan references are not hidden", async () => {
  const { root } = fixture();
  root.files.set("references.ndjson", '{"referenceId":"r","nodeId":"absent","assetId":"gone"}');
  const source = await loadLocalBackup(root);
  assert.ok(source.issues.length >= 3);
  assert.equal((await verifyLocalBackup(source)).passed, false);
  root.files.set("nodes.ndjson", "{bad}");
  await assert.rejects(loadLocalBackup(root), /nodes.ndjson/);
});
test("path traversal is rejected and preview URLs are revocable", async () => {
  const { root, asset } = fixture();
  for (const path of ["../report.json", "objects/../../x", "/etc/passwd", "objects\\x", "C:/test", "objects//x"]) await assert.rejects(readFile(root, path));
  const source = await loadLocalBackup(root), media = await source.media(asset);
  assert.ok(media.url.startsWith("blob:"));
  assert.equal(await (await fetch(media.url)).text(), "abc");
  media.release();
  await assert.rejects(fetch(media.url));
});
test("cancelled checks and changes to manifests never produce a pass", async () => {
  const { root } = fixture(), source = await loadLocalBackup(root);
  const controller = new AbortController(); controller.abort();
  assert.equal((await verifyLocalBackup(source, { signal: controller.signal })).passed, false);
  root.files.set("nodes.ndjson", root.files.get("nodes.ndjson").replace("Real text", "Changed text"));
  const result = await verifyLocalBackup(source);
  assert.equal(result.passed, false);
  assert.ok(result.issues.some(x => x.kind === "changed"));
});
