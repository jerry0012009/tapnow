import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { isDeepStrictEqual } from "node:util";

const root = path.resolve(process.argv[2] || "");
if (!process.argv[2]) throw new Error("Usage: node scripts/verify-backup.mjs BACKUP_DIR [BASELINE_DIR]");
const read = async (dir, name) => (await fs.readFile(path.join(dir, name), "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
const [assets, nodes, edges, references] = await Promise.all(["assets.ndjson", "nodes.ndjson", "connections.ndjson", "references.ndjson"].map(name => read(root, name)));
const verified = assets.filter(a => a.status === "verified");
const files = new Map(verified.map(a => [a.file, a]));
const problems = [];
const verifiedFiles = new Map();
const realRoot = await fs.realpath(root);
let physicalBytes = 0;
for (const [relative, asset] of files) {
  try {
    if (typeof relative !== "string" || !relative.startsWith("objects/")) throw new Error("invalid object path");
    const file = await fs.realpath(path.resolve(root, relative));
    if (!file.startsWith(`${realRoot}${path.sep}`)) throw new Error("outside backup");
    const hash = crypto.createHash("sha256"); let bytes = 0;
    for await (const chunk of createReadStream(file, { highWaterMark: 1024 * 1024 })) { hash.update(chunk); bytes += chunk.length; }
    const digest = hash.digest("hex");
    if (digest !== asset.sha256 || bytes !== asset.bytes) throw new Error("length or digest mismatch");
    physicalBytes += bytes; verifiedFiles.set(relative, { sha256: digest, bytes });
  } catch (error) { problems.push({ file: relative, error: error.message }); }
}
for (const asset of verified) {
  const file = verifiedFiles.get(asset.file);
  if (!file || file.sha256 !== asset.sha256 || file.bytes !== asset.bytes) problems.push({ assetId: asset.assetId || asset.referenceId, error: "target does not match file" });
}
const ids = new Set(nodes.map(n => n.id));
const assetIds = new Set(assets.map(a => a.assetId || a.referenceId));
const statuses = {};
for (const asset of assets) statuses[asset.status] = (statuses[asset.status] || 0) + 1;
const result = {
  verifiedAt: new Date().toISOString(), verifiedBy: "independent-node-stream-sha256",
  nodeCount: nodes.length, connectionCount: edges.length, referenceCount: references.length, targetCount: assets.length,
  statuses, verifiedTargets: verified.length, verifiedUniqueFiles: verifiedFiles.size,
  physicalBytes, referencedBytes: verified.reduce((s, a) => s + a.bytes, 0),
  unresolvedReferences: references.filter(r => !assetIds.has(r.assetId)).length,
  danglingConnections: edges.filter(e => !ids.has(e.source) || !ids.has(e.target)).length,
  problems, integrityPassed: !problems.length, passed: !problems.length
};
const report = JSON.parse(await fs.readFile(path.join(root, "report.json"), "utf8"));
result.runId = report.runId || null;
result.producer = report.producer || "legacy-executor";
if (process.argv[3]) {
  const baseline = path.resolve(process.argv[3]);
  const [oldAssets, oldNodes, oldEdges] = await Promise.all(["assets.ndjson", "nodes.ndjson", "connections.ndjson"].map(name => read(baseline, name)));
  const key = a => `${a.url || ""}|${a.fileId || ""}`;
  const oldByKey = new Map(oldAssets.map(a => [key(a), a])), byKey = new Map(assets.map(a => [key(a), a]));
  const compareRows = (before, after) => {
    const byId = new Map(after.map(n => [n.id, n]));
    return { missing: before.filter(n => !byId.has(n.id)).length, modified: before.filter(n => byId.has(n.id) && !isDeepStrictEqual(n, byId.get(n.id))).length, extra: after.filter(n => !before.some(old => old.id === n.id)).length };
  };
  result.baseline = {
    missingTargets: oldAssets.filter(a => !byKey.has(key(a))).length,
    extraTargets: assets.filter(a => !oldByKey.has(key(a))).length,
    formerlyVerifiedNotVerified: oldAssets.filter(a => a.status === "verified" && byKey.get(key(a))?.status !== "verified").length,
    hashDifferences: verified.filter(a => oldByKey.get(key(a))?.status === "verified" && oldByKey.get(key(a)).sha256 !== a.sha256).length,
    nodes: compareRows(oldNodes, nodes), connections: compareRows(oldEdges, edges)
  };
  result.baselineMatches = [result.baseline.missingTargets, result.baseline.extraTargets,
    result.baseline.formerlyVerifiedNotVerified, result.baseline.hashDifferences,
    ...Object.values(result.baseline.nodes), ...Object.values(result.baseline.connections)].every(value => value === 0);
}
result.passed = result.integrityPassed && result.unresolvedReferences === 0 && result.baselineMatches !== false;
await fs.writeFile(path.join(root, "verification.json"), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
if (!result.passed) process.exitCode = 1;
