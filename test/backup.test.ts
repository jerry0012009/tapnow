import test from "node:test";
import assert from "node:assert/strict";
import { collectPages } from "../utils/backup/pagination";
import { discoverAssetReferences } from "../utils/backup/discover";
import {
  calculateStorageBudget,
  canCommitBytes,
  STORAGE_BUDGET_FRACTION
} from "../utils/backup/storage";
import { createCheckpoint, transitionCheckpoint } from "../utils/backup/checkpoint";

test("collectPages drains cursor pages and reports duplicates", async () => {
  const pages = new Map<string | null, { items: Array<{ id: string }>; cursor: string | null }>([
    [null, { items: [{ id: "a" }, { id: "b" }], cursor: "next-1" }],
    ["next-1", { items: [{ id: "b" }, { id: "c" }], cursor: null }]
  ]);
  const result = await collectPages(
    async (cursor) => {
      const page = pages.get(cursor)!;
      return {
        items: page.items,
        hasMore: Boolean(page.cursor),
        nextCursor: page.cursor,
        total: 3
      };
    },
    (item) => item.id
  );
  assert.deepEqual(result.items.map((item) => item.id), ["a", "b", "c"]);
  assert.equal(result.diagnostic.duplicateItems, 1);
  assert.equal(result.diagnostic.complete, true);
});

test("collectPages detects a repeated cursor instead of looping", async () => {
  const result = await collectPages(
    async () => ({
      items: [{ id: "a" }],
      hasMore: true,
      nextCursor: "same",
      total: null
    }),
    (item) => item.id
  );
  assert.equal(result.diagnostic.repeatedCursors, 1);
  assert.equal(result.diagnostic.complete, false);
});

test("discoverAssetReferences keeps alternatives, history and file ids", () => {
  const references = discoverAssetReferences("canvas-1", "node-1", {
    src: "https://files.tapnow.media/current.jpg#fragment",
    currentSourceFileId: "file-current",
    options: [
      { url: "https://files.tapnow.media/alternative.jpg", fileId: "file-alt" }
    ],
    historyLocalQueues: [{ src: "https://files.tapnow.media/history.jpg" }]
  });
  assert.equal(references.length, 7);
  assert.equal(references[0].url, "https://files.tapnow.media/current.jpg");
  assert.equal(references[0].fileId, "file-current");
  assert.equal(references.some((item) => item.role === "alternative"), true);
  assert.equal(references.some((item) => item.role === "history"), true);
});

test("storage budget uses one third and prevents over-commit", () => {
  const budget = calculateStorageBudget(12_000_000_000, 1_000_000_000);
  assert.equal(budget.budgetBytes, Math.floor(12_000_000_000 * STORAGE_BUDGET_FRACTION));
  assert.equal(budget.usableBytes, 3_000_000_000);
  assert.equal(canCommitBytes(budget, 2_000_000_000, 1_000_000_000), true);
  assert.equal(canCommitBytes(budget, 2_000_000_001, 1_000_000_000), false);
});

test("checkpoint transitions preserve resumable state", () => {
  const initial = createCheckpoint("backup-1", "run-1", {
    kind: "canvas",
    ids: ["canvas-1"],
    includeChildren: false
  });
  const next = transitionCheckpoint(initial, "paused", {
    nextAssetIndex: 4,
    pendingAssetIds: ["asset-5"],
    committedBytes: 123
  });
  assert.equal(next.status, "paused");
  assert.equal(next.nextAssetIndex, 4);
  assert.deepEqual(next.pendingAssetIds, ["asset-5"]);
  assert.equal(next.committedBytes, 123);
});
