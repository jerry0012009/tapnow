import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { createReadStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { buildBackupIndex, normalizeAsset } from "./lib/backup-index.mjs";

const backupRoot = path.resolve(
  process.argv[2] || process.env.TAPNOW_BACKUP_DIR || "artifacts/private/real-backup-3e87d521-d950-4d83-a077-2eae20e51602",
);
const port = Number(process.env.PORT || 8787);
const host = process.env.HOST || "127.0.0.1";
const viewerRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../viewer");
const vendorFiles = {
  "/vendor/cytoscape.js": "../node_modules/cytoscape/dist/cytoscape.min.js",
  "/vendor/lucide.js": "../node_modules/lucide/dist/umd/lucide.min.js"
};
let cachedIndex, cachedAt = 0;
async function backupIndex() {
  if (!cachedIndex || Date.now() - cachedAt > 3000) {
    const data = await Promise.all(["nodes", "connections", "references", "assets"].map(readAllNdjson));
    cachedIndex = buildBackupIndex(...data); cachedAt = Date.now();
  }
  return cachedIndex;
}

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
  let hasMore = false;
  const needle = filter.trim().toLowerCase();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let value;
    value = name === "assets" ? normalizeAsset(JSON.parse(line)) : JSON.parse(line);
    if (needle && !JSON.stringify(value).toLowerCase().includes(needle)) continue;
    if (matched++ < offset) continue;
    if (rows.length === limit) { hasMore = true; break; }
    rows.push(value);
  }
  return { items: rows, offset, limit, returned: rows.length, hasMore, filter };
}

async function readAllNdjson(name) {
  const file = safePath(files[name]);
  if (!file) throw new Error("invalid backup path");
  const text = await fs.readFile(file, "utf8");
  return text.split("\n").filter(line => line.trim()).map(line => JSON.parse(line));
}

async function serveStatic(req, res, pathname) {
  if (vendorFiles[pathname]) {
    const body = await fs.readFile(path.resolve(viewerRoot, vendorFiles[pathname]));
    res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-cache" });
    return res.end(body);
  }
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
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'self'");
    if (!["GET", "HEAD"].includes(req.method)) return json(res, { error: "read only" }, 405);
    if (url.pathname === "/api/info") return json(res, { backupRoot, available: await fs.stat(backupRoot).then(() => true).catch(() => false) });
    if (url.pathname === "/api/report") {
      const report = await readJson("report");
      const assets = (await readAllNdjson("assets")).map(normalizeAsset);
      const statuses = {};
      for (const asset of assets) statuses[asset.status || "unknown"] = (statuses[asset.status || "unknown"] || 0) + 1;
      const saved = assets.filter(a => a.status === "verified");
      let verification = null;
      try {
        const candidate = JSON.parse(await fs.readFile(path.join(backupRoot, "verification.json"), "utf8"));
        if (candidate.runId === report.runId && candidate.verifiedTargets === saved.length && ["completed", "partial"].includes(report.status)) verification = candidate;
      } catch {}
      return json(res, {
        ...report,
        statuses,
        verifiedCount: statuses.verified || 0,
        verifiedBytes: saved.reduce((sum, asset) => sum + Number(asset.bytes || 0), 0),
        physicalBytes: [...new Map(saved.map(a => [a.file, Number(a.bytes || 0)])).values()].reduce((a, b) => a + b, 0),
        physicalFileCount: new Set(saved.map(a => a.file)).size,
        verification,
        failedCount: Object.entries(statuses).filter(([status]) => !["verified", "queued", "discovered"].includes(status)).reduce((sum, [, count]) => sum + count, 0),
        pendingCount: (statuses.queued || 0) + (statuses.discovered || 0),
      });
    }
    if (url.pathname === "/api/canvas") return json(res, await readJson("canvas"));
    if (url.pathname === "/api/graph") {
      return json(res, (await backupIndex()).graph);
    }
    const nodeMatch = url.pathname.match(/^\/api\/node\/(.+)$/);
    if (nodeMatch) {
      const detail = (await backupIndex()).nodeDetail(decodeURIComponent(nodeMatch[1]));
      return json(res, detail || { error: "node not found" }, detail ? 200 : 404);
    }
    const mediaMatch = url.pathname.match(/^\/api\/media\/(.+)$/);
    if (mediaMatch || url.pathname === "/api/object") {
      const index = await backupIndex();
      const asset = mediaMatch ? index.byAsset.get(decodeURIComponent(mediaMatch[1]))
        : [...index.byAsset.values()].find(a => a.file === url.searchParams.get("path"));
      if (!asset?.canPreview || !asset.file) return json(res, { error: "asset not saved" }, 404);
      const file = safePath(asset.file);
      if (!file || !asset.file.startsWith("objects/")) return json(res, { error: "invalid object path" }, 400);
      const [realRoot, realFile] = await Promise.all([fs.realpath(backupRoot), fs.realpath(file)]);
      if (!realFile.startsWith(`${realRoot}${path.sep}`)) return json(res, { error: "outside backup" }, 403);
      const stats = await fs.stat(realFile);
      if (stats.size !== asset.bytes) return json(res, { error: "saved file length mismatch" }, 409);
      const mime = String(asset.contentType || "").split(";")[0];
      const previewable = /^(image\/(png|jpeg|gif|webp|avif)|video\/(mp4|webm)|audio\/(mpeg|mp4|wav|ogg))$/.test(mime);
      res.setHeader("content-type", previewable ? mime : "application/octet-stream");
      res.setHeader("cache-control", "private, no-store");
      res.setHeader("accept-ranges", "bytes");
      if (!previewable || url.searchParams.has("download")) res.setHeader("content-disposition", `attachment; filename="${asset.sha256}"`);
      let start = 0, end = stats.size - 1, status = 200;
      if (req.headers.range) {
        const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
        if (!range || (!range[1] && !range[2])) { res.writeHead(416, { "content-range": `bytes */${stats.size}` }); return res.end(); }
        if (!range[1]) start = Math.max(0, stats.size - Number(range[2]));
        else { start = Number(range[1]); if (range[2]) end = Math.min(end, Number(range[2])); }
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= stats.size) { res.writeHead(416, { "content-range": `bytes */${stats.size}` }); return res.end(); }
        status = 206; res.setHeader("content-range", `bytes ${start}-${end}/${stats.size}`);
      }
      res.writeHead(status, { "content-length": end - start + 1 });
      if (req.method === "HEAD") return res.end();
      await pipeline(createReadStream(realFile, { start, end }), res).catch(() => {});
      return;
    }
    const match = url.pathname.match(/^\/api\/(nodes|connections|references|assets)$/);
    if (match) {
      const offset = Math.max(0, Math.floor(Number(url.searchParams.get("offset") || 0)));
      const limit = Math.min(250, Math.max(1, Math.floor(Number(url.searchParams.get("limit") || 100))));
      if (!Number.isFinite(offset) || !Number.isFinite(limit)) return json(res, { error: "invalid pagination" }, 400);
      return json(res, await readNdjson(match[1], offset, limit, url.searchParams.get("q") || ""));
    }
    return serveStatic(req, res, url.pathname);
  } catch (error) {
    if (res.headersSent) return res.destroy();
    return json(res, { error: error?.code === "ENOENT" ? "local file not found" : "unable to read backup" }, error?.code === "ENOENT" ? 404 : 500);
  }
});

server.listen(port, host, () => {
  console.log(`TapNow backup viewer: http://${host}:${server.address().port}/`);
  console.log(`Backup directory: ${backupRoot}`);
});
