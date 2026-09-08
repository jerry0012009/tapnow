import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { downloadToDirectory, hashFile, indexReferences, reconcileAssets, localFile, parseRange, verifySaved, type Asset, type LocalDirectory, type LocalFile } from "../utils/backup/engine";
import { discoverAssetReferences } from "../utils/backup/discover";

class MemoryDirectory implements LocalDirectory {
  directories = new Map<string, MemoryDirectory>();
  files = new Map<string, File>();
  constructor(public name = "root") {}
  async getDirectoryHandle(name: string, { create = false } = {}) {
    if (!this.directories.has(name)) {
      if (!create) throw new DOMException("missing", "NotFoundError");
      this.directories.set(name, new MemoryDirectory(name));
    }
    return this.directories.get(name)!;
  }
  async getFileHandle(name: string, { create = false } = {}): Promise<LocalFile> {
    if (!this.files.has(name)) {
      if (!create) throw new DOMException("missing", "NotFoundError");
      this.files.set(name, new File([], name));
    }
    return {
      getFile: async () => this.files.get(name)!,
      createWritable: async () => {
        let chunks: any[] = [];
        return {
          write: async data => { chunks.push(data); },
          close: async () => { this.files.set(name, new File(chunks, name)); },
          abort: async () => { chunks = []; }
        };
      }
    };
  }
  async removeEntry(name: string) { this.files.delete(name); }
}
const makeAsset = (value: unknown = { src: "https://files.tapnow.media/sample" }): Asset =>
  indexReferences(discoverAssetReferences("canvas", "node", value)).assets[0];
const response = (bytes: Uint8Array | string, status = 200, headers = {}) =>
  new Response(bytes, { status, headers: { "content-type": "image/png", ...headers } });
function options(fetcher: (...args: any[]) => Promise<Response>, limit = Infinity) {
  let claimed = 0;
  return {
    fetch: fetcher as typeof fetch, retryDelayMs: 0,
    claim(bytes: number) { if (claimed + bytes > limit) throw new Error("storage-budget-exceeded"); claimed += bytes; },
    release(bytes: number) { claimed -= bytes; },
    used: () => claimed
  };
}
test("streamed full response is persisted, reread and hashed", async () => {
  const root = new MemoryDirectory();
  const result = await downloadToDirectory(root, makeAsset(), options(async () => response("abc")));
  assert.equal(result.status, "verified");
  assert.equal(result.bytes, 3);
  assert.equal(result.sha256, createHash("sha256").update("abc").digest("hex"));
  assert.equal(await verifySaved(root, result), true);
  assert.equal(root.directories.get("partial")!.files.size, 0);
});
test("range downloading supports files exceeding the old 10-chunk limit", async () => {
  const root = new MemoryDirectory(), total = 44 * 1024 * 1024 + 3;
  let requests = 0;
  const expected = createHash("sha256");
  const opts = options(async (_url, init) => {
    const [start, requestedEnd] = init.headers.Range.match(/\d+/g).map(Number);
    const end = Math.min(total - 1, requestedEnd);
    const bytes = new Uint8Array(end - start + 1).fill(23);
    expected.update(bytes); requests++;
    return response(bytes, 206, { "content-range": `bytes ${start}-${end}/${total}`, etag: '"v1"' });
  });
  const result = await downloadToDirectory(root, makeAsset(), opts);
  assert.equal(requests, 12);
  assert.equal(result.status, "verified");
  assert.equal(result.bytes, total);
  assert.equal(result.sha256, expected.digest("hex"));
});
test("range parser rejects wrong offsets, unknown totals and invalid bounds", () => {
  for (const value of ["bytes 1-5/10", "bytes 0-10/10", "bytes 0-5/*", "bytes 0--1/0"]) {
    assert.throws(() => parseRange(value, 0));
  }
  assert.deepEqual(parseRange("bytes 4-5/6", 4), { from: 4, to: 5, total: 6 });
});
test("partial body is never marked verified", async () => {
  const result = await downloadToDirectory(new MemoryDirectory(), makeAsset(), options(async () =>
    response("abc", 206, { "content-range": "bytes 0-9/10" })));
  assert.equal(result.status, "retryable");
  assert.match(result.reason!, /Truncated range/);
});
test("range-ignoring continuation and changing ETag are rejected", async () => {
  for (const changed of [false, true]) {
    const result = await downloadToDirectory(new MemoryDirectory(), makeAsset(), options(async (_url, init) => {
      if (init.headers.Range.startsWith("bytes=0-")) return response("a", 206, { "content-range": "bytes 0-0/2", etag: '"v1"' });
      return changed ? response("b", 206, { "content-range": "bytes 1-1/2", etag: '"v2"' }) : response("ab", 200);
    }));
    assert.equal(result.status, "retryable");
    assert.match(result.reason!, changed ? /ETag changed/ : /ignored continuation/);
  }
});
test("404 and 410 are retained after retries; network errors can recover", async () => {
  for (const status of [404, 410]) {
    const result = await downloadToDirectory(new MemoryDirectory(), makeAsset(), options(async () => response("", status)));
    assert.equal(result.status, "unavailable-after-recovery");
    assert.equal(result.attempts, 4);
  }
  let count = 0;
  const result = await downloadToDirectory(new MemoryDirectory(), makeAsset(), options(async () => {
    if (!count++) throw new TypeError("Failed to fetch");
    return response("abc");
  }));
  assert.equal(result.status, "verified");
  assert.equal(result.attempts, 2);
});
test("file-ID-only targets are resolved without a main-site bearer token", async () => {
  const asset = makeAsset({ currentSourceFileId: "file-ID" });
  const result = await downloadToDirectory(new MemoryDirectory(), asset, options(async (url, init) => {
    assert.equal(url, "https://files.tapnow.media/api/conversation/storage/uploads/file-ID");
    assert.equal(init.credentials, "omit");
    assert.equal(init.headers.Authorization, undefined);
    return response("abc");
  }));
  assert.equal(result.status, "verified");
});
test("quota, abort and HTML error pages leave no verified result", async () => {
  const root = new MemoryDirectory(), opts = options(async () => response("abc"), 2);
  const result = await downloadToDirectory(root, makeAsset(), opts);
  assert.equal(result.status, "retryable");
  assert.match(result.reason!, /storage-budget/);
  assert.equal(opts.used(), 0);
  assert.equal(root.directories.get("partial")!.files.size, 0);
  const aborted = new AbortController(); aborted.abort();
  const paused = await downloadToDirectory(root, makeAsset(), { ...opts, signal: aborted.signal });
  assert.equal(paused.status, "queued");
  const html = await downloadToDirectory(root, makeAsset(), options(async () => response("error", 200, { "content-type": "text/html" })));
  assert.notEqual(html.status, "verified");
});
test("readback detects altered content and path traversal is rejected", async () => {
  const root = new MemoryDirectory();
  const result = await downloadToDirectory(root, makeAsset(), options(async () => response("abc")));
  const file = await localFile(root, result.file!);
  const writable = await file.createWritable(); await writable.write("bad"); await writable.close();
  assert.equal(await verifySaved(root, result), false);
  assert.notEqual(await hashFile(await file.getFile()), result.sha256);
  await assert.rejects(() => localFile(root, "../secret"));
});
test("incremental scan retains missing old targets and clears the marker when rediscovered", () => {
  const old = makeAsset({ currentSourceFileId: "old-file" }), current = makeAsset();
  const previous = { ...old, status: "unavailable-after-recovery", attempts: 4 };
  const targets = reconcileAssets([current], [previous]);
  assert.equal(targets.length, 2);
  assert.equal(targets[1].fileId, "old-file");
  assert.equal(targets[1].notInLatestScan, true);
  const rediscovered = reconcileAssets([old], [{ ...previous, notInLatestScan: true }]);
  assert.equal(rediscovered.length, 1);
  assert.equal(rediscovered[0].notInLatestScan, false);
});
