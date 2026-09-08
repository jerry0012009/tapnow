import test from "node:test";
import assert from "node:assert/strict";
import { buildBackupIndex, normalizeAsset } from "../scripts/lib/backup-index.mjs";
test("viewer maps shared assets to every referencing node and preserves all alternatives", () => {
  const nodes = [{ id: "a", position: { x: 0, y: 0 } }, { id: "b", position: { x: 1, y: 1 } }];
  const references = [
    { nodeId: "a", assetId: "one", fieldPath: "data.src" },
    { nodeId: "b", assetId: "one", fieldPath: "data.src" },
    { nodeId: "b", assetId: "two", fieldPath: "data.options[1]" }
  ];
  const index = buildBackupIndex(nodes, [], references, [
    { referenceId: "one", nodeId: "a", status: "verified" },
    { referenceId: "two", status: "retryable", reason: "HTTP 404" }
  ]);
  assert.equal(index.nodeDetail("b").assets.length, 2);
  assert.equal(index.nodeDetail("b").assets[0].asset.referenceId, "one");
  assert.equal(index.graph.nodes[1].status, "partial");
  assert.equal(index.graph.counts.nodesWithReferences, 2);
});
test("viewer resolves nested parent positions and reports dangling edges", () => {
  const index = buildBackupIndex([
    { id: "g", position: { x: 100, y: -40 } },
    { id: "g2", parent_id: "g", position: { x: 10, y: 20 } },
    { id: "n", parent_id: "g2", position: { x: 3, y: 5 } }
  ], [{ source: "n", target: "missing" }], [], []);
  assert.deepEqual(index.nodeDetail("n").absolutePosition, { x: 113, y: -15 });
  assert.equal(index.graph.counts.danglingConnections, 1);
});
test("viewer identifies reference gaps and cycles without infinite recursion", () => {
  const index = buildBackupIndex([
    { id: "a", parent_id: "b", position: { x: 1, y: 1 } },
    { id: "b", parent_id: "a", position: { x: 1, y: 1 } }
  ], [], [{ nodeId: "a", assetId: "lost" }], []);
  assert.equal(index.graph.counts.unresolvedReferences, 1);
  assert.ok(index.graph.diagnostics.some(d => d.type === "parent-cycle"));
  assert.equal(index.nodeDetail("a").assets[0].asset, null);
});
test("old 404 status is normalized without changing network failures", () => {
  assert.equal(normalizeAsset({ status: "retryable", reason: "Error: HTTP 404" }).status, "unavailable-after-recovery");
  assert.equal(normalizeAsset({ status: "retryable", reason: "Failed to fetch" }).status, "retryable");
});
test("every node type is retained, including full text, custom attributes and edges", () => {
  const types = ["text", "image", "video", "audio", "file", "document", "group", "future-type"];
  const nodes = types.map((type, i) => ({ id: `n${i}`, type, position: { x: i * 400, y: 20 },
    data: { text: type === "text" ? "Saved text <script>not executable</script>".repeat(100) : "", custom: { preserved: true } } }));
  const edges = nodes.slice(1).map((node, i) => ({ id: `e${i}`, source: nodes[i].id, target: node.id }));
  const index = buildBackupIndex(nodes, edges, [], []);
  assert.equal(index.graph.nodes.length, types.length);
  assert.deepEqual(index.graph.nodes.map(node => node.type), types);
  assert.equal(index.graph.nodes[0].text, nodes[0].data.text);
  assert.equal(index.graph.counts.connections, 7);
  for (const node of nodes) assert.deepEqual(index.nodeDetail(node.id).node, node);
});
