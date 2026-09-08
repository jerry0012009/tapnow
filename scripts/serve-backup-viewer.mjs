import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const backupRoot = path.resolve(
  process.argv[2] || process.env.TAPNOW_BACKUP_DIR || "artifacts/private/real-backup-3e87d521-d950-4d83-a077-2eae20e51602",
);
const port = Number(process.env.PORT || 8787);
const host = process.env.HOST || "127.0.0.1";
const viewerRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../viewer");

const files = {
  report: "report.json",
  canvas: "canvas.json",
  nodes: "nodes.ndjson",
  connections: "connections.ndjson",
  references: "references.ndjson",
  assets: "assets.ndjson",
};

function json(res, value, status = 200) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function safePath(relative) {
  const resolved = path.resolve(backupRoot, relative);
  return resolved === backupRoot || resolved.startsWith(`${backupRoot}${path.sep}`)
    ? resolved
    : null;
}

async function readJson(name) {
  const file = safePath(files[name]);
  if (!file) throw new Error("invalid backup path");
  return JSON.parse(await fs.readFile(file, "utf8"));
}

async function readNdjson(name, offset, limit, filter = "") {
  const file = safePath(files[name]);
  if (!file) throw new Error("invalid backup path");
  const text = await fs.readFile(file, "utf8");
  const rows = [];
  let matched = 0;
  const needle = filter.trim().toLowerCase();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let value;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    if (needle && !JSON.stringify(value).toLowerCase().includes(needle)) continue;
    if (matched++ < offset) continue;
    rows.push(value);
    if (rows.length >= limit) break;
  }
  return { items: rows, offset, limit, returned: rows.length, hasMore: rows.length === limit, filter };
}

async function readStatusSummary() {
  const file = safePath(files.assets);
  const counts = {};
  if (!file) return counts;
  const text = await fs.readFile(file, "utf8");
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const item = JSON.parse(line);
      const status = item.status === "retryable" && /^HTTP (404|410)\b/.test(item.reason || "")
        ? "unavailable-after-recovery"
        : item.status || "unknown";
      counts[status] = (counts[status] || 0) + 1;
    } catch {
      // Ignore a truncated final line; the viewer remains usable during a live run.
    }
  }
  return counts;
}

async function readAllNdjson(name) {
  const file = safePath(files[name]);
  if (!file) throw new Error("invalid backup path");
  const text = await fs.readFile(file, "utf8");
  return text.split("\n").filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}

async function serveStatic(req, res, pathname) {
  const relative = pathname === "/" ? "index.html" : pathname.slice(1);
  const file = path.resolve(viewerRoot, relative);
  if (file !== viewerRoot && !file.startsWith(`${viewerRoot}${path.sep}`)) return json(res, { error: "not found" }, 404);
  try {
    const body = await fs.readFile(file);
    const type = file.endsWith(".html") ? "text/html; charset=utf-8" : file.endsWith(".js") ? "text/javascript; charset=utf-8" : "text/css; charset=utf-8";
    res.writeHead(200, { "content-type": type, "cache-control": "no-store" });
    res.end(body);
  } catch {
    json(res, { error: "not found" }, 404);
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  try {
    if (url.pathname === "/api/info") return json(res, { backupRoot, available: await fs.stat(backupRoot).then(() => true).catch(() => false) });
    if (url.pathname === "/api/report") {
      const report = await readJson("report");
      const statuses = await readStatusSummary();
      return json(res, {
        ...report,
        statuses,
        verifiedCount: statuses.verified || 0,
        failedCount: Object.entries(statuses).filter(([status]) => status !== "verified").reduce((sum, [, count]) => sum + count, 0),
      });
    }
    if (url.pathname === "/api/canvas") return json(res, await readJson("canvas"));
    if (url.pathname === "/api/graph") {
      const [nodes, connections, assets] = await Promise.all([
        readAllNdjson("nodes"),
        readAllNdjson("connections"),
        readAllNdjson("assets"),
      ]);
      const assetsByNode = {};
      for (const asset of assets) {
        if (asset.nodeId && !assetsByNode[asset.nodeId]) assetsByNode[asset.nodeId] = asset;
      }
      return json(res, { nodes, connections, assetsByNode });
    }
    if (url.pathname === "/api/object") {
      const relative = url.searchParams.get("path") || "";
      const file = safePath(relative);
      if (!file || !relative.startsWith("objects/")) return json(res, { error: "invalid object path" }, 400);
      const body = await fs.readFile(file);
      res.writeHead(200, { "content-type": "application/octet-stream", "cache-control": "public, max-age=3600" });
      return res.end(body);
    }
    const match = url.pathname.match(/^\/api\/(nodes|connections|references|assets)$/);
    if (match) {
      const offset = Math.max(0, Number(url.searchParams.get("offset") || 0));
      const limit = Math.min(250, Math.max(1, Number(url.searchParams.get("limit") || 100)));
      return json(res, await readNdjson(match[1], offset, limit, url.searchParams.get("q") || ""));
    }
    return serveStatic(req, res, url.pathname);
  } catch (error) {
    return json(res, { error: error instanceof Error ? error.message : String(error) }, 500);
  }
});

server.listen(port, host, () => {
  console.log(`TapNow backup viewer: http://${host}:${port}/`);
  console.log(`Backup directory: ${backupRoot}`);
});
