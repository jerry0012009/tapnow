import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { buildBackupIndex, normalizeAsset } from "../scripts/lib/backup-index.mjs";

export async function readFile(root, relative) {
  const parts = String(relative).split("/");
  if (parts.some(p => !p || p === "." || p === ".." || /[\\:\0]/.test(p))) throw new Error("不安全的本地文件路径");
  let dir = root;
  for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part);
  return (await dir.getFileHandle(parts.at(-1))).getFile();
}
const json = async (root, name) => JSON.parse(await (await readFile(root, name)).text());
function rows(text, name) {
  const lines = text.split("\n");
  return lines.flatMap((line, index) => {
    if (!line.trim()) return [];
    try {
      const value = JSON.parse(line);
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
      return [value];
    } catch { throw new Error(`${name}.ndjson 第 ${index + 1} 行不是有效记录`); }
  });
}
export async function discoverBackups(root) {
  const found = [];
  async function candidate(handle, path) {
    try {
      const report = await json(handle, "report.json");
      found.push({ handle, path, name: String(report.canvasName || report.canvasId || handle.name), id: String(report.canvasId || handle.name) });
      return true;
    } catch (error) {
      if (error.name !== "NotFoundError" && error.name !== "TypeMismatchError") {
        found.push({ handle, path, name: `${handle.name}（报告不可读）`, id: handle.name });
        return true;
      }
      return false;
    }
  }
  if (await candidate(root, root.name)) return found;
  let base = root, prefix = root.name;
  try { base = await root.getDirectoryHandle("tapnow-backup"); prefix += "/tapnow-backup"; }
  catch (error) { if (error.name !== "NotFoundError") throw error; }
  for await (const entry of base.values()) {
    if (entry.kind === "directory") await candidate(entry, `${prefix}/${entry.name}`);
  }
  return found.sort((a, b) => a.name.localeCompare(b.name));
}
export async function loadLocalBackup(root) {
  const names = ["report.json", "canvas.json", "nodes.ndjson", "connections.ndjson", "references.ndjson", "assets.ndjson"];
  const contents = new Map(await Promise.all(names.map(async name => [name, await (await readFile(root, name)).text()])));
  const digest = text => bytesToHex(sha256(new TextEncoder().encode(text)));
  const fingerprints = new Map([...contents].map(([name, text]) => [name, digest(text)]));
  const report = JSON.parse(contents.get("report.json")), canvas = JSON.parse(contents.get("canvas.json"));
  if (!report || !canvas || typeof report !== "object" || typeof canvas !== "object" || Array.isArray(report) || Array.isArray(canvas)) throw new Error("画布或报告不是有效对象");
  const [nodes, connections, references, rawAssets] = ["nodes", "connections", "references", "assets"].map(n => rows(contents.get(`${n}.ndjson`), n));
  const assets = rawAssets.map(normalizeAsset);
  const index = buildBackupIndex(nodes, connections, references, assets);
  const issues = [];
  const add = (kind, message, more = {}) => issues.push({ kind, message, ...more });
  for (const [name, list, key] of [["nodes", nodes, "id"], ["connections", connections, "id"], ["references", references, "referenceId"], ["assets", assets, "assetId"]]) {
    const ids = new Set();
    for (const row of list) {
      const id = row[key] || (name === "assets" ? row.referenceId : null);
      if (!id || ids.has(id)) add("metadata", `${name} 存在缺失或重复 ID`, { id: id || null });
      ids.add(id);
    }
  }
  for (const [key, count] of [["nodeCount", nodes.length], ["connectionCount", connections.length], ["referenceCount", references.length], ["uniqueAssetCount", assets.length]]) {
    if (report[key] !== count) add("metadata", `报告 ${key}=${report[key]}，实际记录=${count}`);
  }
  if (canvas.id && report.canvasId !== canvas.id) add("metadata", "画布 ID 与报告不一致");
  if (index.graph.counts.unresolvedReferences) add("metadata", `${index.graph.counts.unresolvedReferences} 个引用没有对应资源记录`);
  if (index.graph.counts.danglingConnections) add("metadata", `${index.graph.counts.danglingConnections} 条连线端点缺失`);
  const nodeIds = new Set(nodes.map(n => n.id));
  const orphaned = references.filter(r => !nodeIds.has(r.nodeId)).length;
  if (orphaned) add("metadata", `${orphaned} 个引用的节点不在快照中`);
  for (const name of ["nodes", "connections"]) {
    if (report.diagnostics?.[name]?.complete !== true) add("metadata", `${name} 分页完整性未确认`);
  }
  const saved = assets.filter(a => a.status === "verified");
  const pending = assets.filter(a => ["queued", "discovered"].includes(a.status)).length;
  const summary = {
    ...report, nodeCount: nodes.length, connectionCount: connections.length, referenceCount: references.length,
    uniqueAssetCount: assets.length, verifiedCount: saved.length, pendingCount: pending,
    failedCount: assets.length - saved.length - pending, verification: null,
    verifiedBytes: saved.reduce((s, a) => s + Number(a.bytes || 0), 0),
    physicalFileCount: new Set(saved.map(a => a.file)).size,
    physicalBytes: [...new Map(saved.map(a => [a.file, Number(a.bytes || 0)])).values()].reduce((a, b) => a + b, 0)
  };
  const data = { nodes, connections, references, assets };
  return {
    root, report: summary, data, issues,
    async metadataUnchanged() {
      for (const [name, expected] of fingerprints) {
        if (digest(await (await readFile(root, name)).text()) !== expected) return false;
      }
      return true;
    },
    async get(path, signal) {
      signal?.throwIfAborted();
      const url = new URL(path, "https://local.invalid");
      if (url.pathname === "/api/report") return summary;
      if (url.pathname === "/api/canvas") return canvas;
      if (url.pathname === "/api/graph") return index.graph;
      if (url.pathname.startsWith("/api/node/")) {
        const detail = index.nodeDetail(decodeURIComponent(url.pathname.slice("/api/node/".length)));
        if (!detail) throw new Error("节点不存在");
        return detail;
      }
      const list = data[url.pathname.slice("/api/".length)];
      if (!list) throw new Error("未知的本地数据请求");
      const q = (url.searchParams.get("q") || "").toLowerCase();
      const matched = q ? list.filter(x => JSON.stringify(x).toLowerCase().includes(q)) : list;
      const offset = Math.max(0, Number(url.searchParams.get("offset")) || 0);
      const limit = Math.min(250, Math.max(1, Number(url.searchParams.get("limit")) || 100));
      const items = matched.slice(offset, offset + limit);
      return { items, returned: items.length, hasMore: matched.length > offset + limit };
    },
    async media(asset) {
      const recorded = index.byAsset.get(asset.assetId || asset.referenceId);
      if (!recorded?.canPreview || !recorded.file?.startsWith("objects/")) throw new Error("没有可读取的本地文件");
      const file = await readFile(root, recorded.file);
      if (file.size !== recorded.bytes) throw new Error("文件大小与清单不符，请执行完整性核对");
      const mime = String(recorded.contentType || "").split(";")[0];
      const safe = /^(image\/(png|jpeg|gif|webp|avif)|video\/(mp4|webm)|audio\/(mpeg|mp4|wav|ogg))$/.test(mime);
      const url = URL.createObjectURL(file.slice(0, file.size, safe ? mime : "application/octet-stream"));
      return { url, downloadUrl: url, release: () => URL.revokeObjectURL(url) };
    }
  };
}

export async function verifyLocalBackup(source, { signal, onProgress = () => {} } = {}) {
  const issues = [...source.issues], { assets } = source.data;
  const byPath = new Map();
  for (const asset of assets) {
    if (!asset.file) {
      issues.push({ kind: "missing", assetId: asset.assetId, message: asset.reason || "资源尚未保存", status: asset.status });
      continue;
    }
    const list = byPath.get(asset.file) || []; list.push(asset); byPath.set(asset.file, list);
  }
  let checkedFiles = 0, checkedBytes = 0, verifiedTargets = 0, verifiedUniqueFiles = 0;
  let aborted = false;
  for (const [filePath, targets] of byPath) {
    if (signal?.aborted) { aborted = true; break; }
    try {
      if (!filePath.startsWith("objects/")) throw new Error("文件不在 objects 目录中");
      const file = await readFile(source.root, filePath), hash = sha256.create();
      for (let offset = 0; offset < file.size; offset += 4 * 1024 * 1024) {
        signal?.throwIfAborted();
        hash.update(new Uint8Array(await file.slice(offset, offset + 4 * 1024 * 1024).arrayBuffer()));
        await new Promise(resolve => setTimeout(resolve, 0));
      }
      const digest = bytesToHex(hash.digest()); checkedBytes += file.size;
      let good = false;
      for (const asset of targets) {
        if (asset.bytes === file.size && asset.sha256 === digest) { verifiedTargets++; good = true; }
        else issues.push({ kind: "mismatch", assetId: asset.assetId, file: filePath, message: "SHA-256 或文件大小不匹配" });
      }
      if (good) verifiedUniqueFiles++;
    } catch (error) {
      if (signal?.aborted) { aborted = true; break; }
      for (const asset of targets) issues.push({ kind: "unreadable", assetId: asset.assetId, file: filePath, message: String(error.message || error) });
    }
    checkedFiles++;
    onProgress({ checkedFiles, totalFiles: byPath.size, verifiedTargets, checkedBytes });
  }
  // A writer may have updated the manifests while we were hashing.
  if (!await source.metadataUnchanged() || source.report.status === "running") {
    issues.push({ kind: "changed", message: "备份任务仍在运行或核对期间报告已变化，请完成备份后刷新并重新核对" });
  }
  const passed = !aborted && !issues.length && verifiedTargets === assets.length;
  return { passed, aborted, scope: "local-snapshot",
    scopeNote: "只核对所选本地快照、引用和文件；未与 TapNow 当前云端内容独立对照，不证明云端零遗漏。",
    runId: source.report.runId, verifiedAt: new Date().toISOString(),
    checkedFiles, totalFiles: byPath.size, verifiedUniqueFiles, verifiedTargets, targetCount: assets.length,
    physicalBytes: checkedBytes, issues };
}
