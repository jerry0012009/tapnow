import crypto from "node:crypto";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import process from "node:process";
import { chromium } from "playwright";

const canvasId =
  process.env.TAPNOW_BACKUP_CANVAS_ID ??
  "3e87d521-d950-4d83-a077-2eae20e51602";
const cdpUrl = process.env.TAPNOW_CDP_URL ?? "http://127.0.0.1:9223";
const root =
  process.env.TAPNOW_REAL_BACKUP_DIR ??
  path.resolve(`artifacts/private/real-backup-${canvasId}`);
const objectRoot = path.join(root, "objects", "sha256");
const statePath = path.join(root, "checkpoint.json");
const referencesPath = path.join(root, "references.ndjson");
const resultsPath = path.join(root, "assets.ndjson");
const concurrency = Math.max(
  1,
  Math.min(8, Number(process.env.TAPNOW_BACKUP_CONCURRENCY ?? 4)),
);
const chunkBytes = 4 * 1024 * 1024;
const maxAttempts = 4;
const safetyReserveBytes = 512 * 1024 * 1024;

await fs.mkdir(objectRoot, { recursive: true });

function now() {
  return new Date().toISOString();
}

function statfsBudget() {
  const stats = fsSync.statfsSync(root);
  const availableBytes = Number(stats.bavail) * Number(stats.bsize);
  const budgetBytes = Math.floor(availableBytes / 3);
  return {
    availableBytes,
    budgetBytes,
    usableBytes: Math.max(0, budgetBytes - safetyReserveBytes),
    measuredAt: now(),
  };
}

function record(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

function normalizeUrl(value) {
  try {
    const url = new URL(value);
    url.hash = "";
    return url.toString();
  } catch {
    return value;
  }
}

function discover(value, pathName, canvasId, nodeId, output) {
  if (typeof value === "string") {
    if (/^https?:\/\//i.test(value)) {
      output.push({
        canvasId,
        nodeId,
        fieldPath: pathName,
        url: normalizeUrl(value),
      });
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      discover(item, `${pathName}[${index}]`, canvasId, nodeId, output),
    );
    return;
  }
  const object = record(value);
  for (const [key, child] of Object.entries(object)) {
    const childPath = `${pathName}.${key}`;
    if (
      typeof child === "string" &&
      /file.?id|source.?file.?id/i.test(key) &&
      child.trim()
    ) {
      output.push({
        canvasId,
        nodeId,
        fieldPath: childPath,
        fileId: child.trim(),
        url: null,
      });
    }
    discover(child, childPath, canvasId, nodeId, output);
  }
}

async function loadSnapshot(page) {
  return page.evaluate(async (canvasId) => {
    const token = localStorage.getItem("access_token");
    if (!token) throw new Error("TapNow access token is not available.");
    const get = async (endpoint) => {
      const response = await fetch(endpoint, {
        credentials: "include",
        headers: { Authorization: `Bearer ${token}` },
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(`${endpoint} HTTP ${response.status}`);
      }
      return body;
    };
    const canvas = await get(
      `/api/canvas/v1/canvases/${encodeURIComponent(canvasId)}?with_nodes=true&with_connections=true`,
    );
    async function collect(kind) {
      const items = [];
      const cursors = new Set();
      let cursor = null;
      for (;;) {
        const query = new URLSearchParams({ limit: "500" });
        if (kind === "nodes") query.set("include_relations", "true");
        if (cursor) query.set("cursor", cursor);
        const body = await get(
          `/api/canvas/v1/canvases/${encodeURIComponent(canvasId)}/${kind}?${query}`,
        );
        const data = body?.data ?? {};
        items.push(...(Array.isArray(data[kind]) ? data[kind] : []));
        if (!data.has_more) return items;
        if (!data.next_cursor || cursors.has(data.next_cursor)) {
          throw new Error(`${kind} pagination cursor repeated or missing`);
        }
        cursors.add(data.next_cursor);
        cursor = data.next_cursor;
      }
    }
    return {
      canvas,
      nodes: await collect("nodes"),
      connections: await collect("connections"),
    };
  }, canvasId);
}

async function readJsonLines(filePath) {
  try {
    const text = await fs.readFile(filePath, "utf8");
    return text
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

async function requestAsset(request, url, start = 0, end = null) {
  const headers = { Referer: "https://app.tapnow.ai/" };
  if (end !== null) headers.Range = `bytes=${start}-${end}`;
  const response = await request.get(url, {
    headers,
    timeout: 30_000,
    maxRedirects: 5,
  });
  const body = await response.body();
  return { response, body };
}

async function downloadAsset(request, asset) {
  const sourceUrl =
    asset.url ||
    (asset.fileId
      ? `https://files.tapnow.media/api/conversation/storage/uploads/${encodeURIComponent(asset.fileId)}`
      : null);
  if (!sourceUrl) {
    return {
      ...asset,
      status: "unavailable-after-recovery",
      reason: "file-id-only-no-known-url",
    };
  }
  let attempt = 0;
  let lastError = "";
  while (attempt < maxAttempts) {
    attempt++;
    try {
      const probe = await requestAsset(request, sourceUrl, 0, 0);
      if (!probe.response.ok() && probe.response.status() !== 206) {
        throw new Error(`HTTP ${probe.response.status()}`);
      }
      const headers = probe.response.headers();
      const contentType = headers["content-type"] || "application/octet-stream";
      const contentRange = headers["content-range"] || "";
      const rangeMatch = contentRange.match(/bytes\s+\d+-\d+\/(\d+|\*)/i);
      const contentLength = Number(
        rangeMatch?.[1] && rangeMatch[1] !== "*"
          ? rangeMatch[1]
          : headers["content-length"] || probe.body.length,
      );
      const chunks = [];
      if (contentLength > chunkBytes || probe.response.status() === 206) {
        for (let start = 0; start < contentLength; start += chunkBytes) {
          const end = Math.min(contentLength - 1, start + chunkBytes - 1);
          const part = await requestAsset(request, sourceUrl, start, end);
          if (part.response.status() !== 206) {
            throw new Error(`range HTTP ${part.response.status()} at ${start}`);
          }
          const range = part.response.headers()["content-range"] || "";
          if (!range.startsWith(`bytes ${start}-`)) {
            throw new Error(`invalid content-range at ${start}: ${range}`);
          }
          chunks.push(part.body);
        }
      } else {
        chunks.push(probe.body);
      }
      const bytes = Buffer.concat(chunks);
      const hash = crypto.createHash("sha256").update(bytes).digest("hex");
      const budget = runBudget;
      const committedBytes = Number(state.committedBytes || 0);
      if (committedBytes + bytes.length > budget.usableBytes) {
        return {
          ...asset,
          status: "storage-budget-exceeded",
          reason: "one-third-disk-budget",
          bytes: bytes.length,
          budget,
        };
      }
      const extension =
        contentType.split(";")[0].split("/")[1]?.replace(/[^a-z0-9]/gi, "") ||
        "bin";
      const relativeFile = `objects/sha256/${hash.slice(0, 2)}/${hash}.${extension}`;
      const filePath = path.join(root, relativeFile);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      try {
        await fs.access(filePath);
      } catch {
        const tempPath = `${filePath}.partial-${process.pid}`;
        await fs.writeFile(tempPath, bytes);
        await fs.rename(tempPath, filePath);
      }
      return {
        ...asset,
        status: "verified",
        file: relativeFile,
        sha256: hash,
        bytes: bytes.length,
        contentType,
        etag: headers.etag || null,
        lastModified: headers["last-modified"] || null,
        attempts: attempt,
      };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      if (attempt < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** (attempt - 1)));
      }
    }
  }
  return {
    ...asset,
    status: /HTTP (?:404|410)\b/.test(lastError)
      ? "unavailable-after-recovery"
      : "retryable",
    reason: lastError,
    attempts: maxAttempts,
  };
}

const browser = await chromium.connectOverCDP(cdpUrl);
const context = browser.contexts()[0];
const page = context.pages().find((candidate) =>
  candidate.url().startsWith("https://app.tapnow.ai/"),
);
if (!page) throw new Error("No authenticated TapNow page is open.");

const snapshot = await loadSnapshot(page);
const refs = [];
for (const node of snapshot.nodes) {
  discover(
    node.data,
    "data",
    canvasId,
    String(node.id || ""),
    refs,
  );
}
const deduped = [
  ...new Map(
    refs.map((item) => [
      `${item.canvasId}|${item.nodeId}|${item.fieldPath}|${item.url || ""}|${item.fileId || ""}`,
      item,
    ]),
  ).values(),
];
const assets = [
  ...new Map(
    deduped.map((item) => [
      `${item.url || ""}|${item.fileId || ""}`,
      item,
    ]),
  ).values(),
];
const assetIdByKey = new Map(
  assets.map((item, index) => [
    `${item.url || ""}|${item.fileId || ""}`,
    `asset-${index + 1}`,
  ]),
);
await fs.writeFile(path.join(root, "canvas.json"), JSON.stringify(snapshot.canvas, null, 2));
await fs.writeFile(
  path.join(root, "nodes.ndjson"),
  snapshot.nodes.map((item) => JSON.stringify(item)).join("\n") + "\n",
);
await fs.writeFile(
  path.join(root, "connections.ndjson"),
  snapshot.connections.map((item) => JSON.stringify(item)).join("\n") + "\n",
);
await fs.writeFile(
  referencesPath,
  deduped
    .map((item, index) =>
      JSON.stringify({
        ...item,
        referenceId: `ref-${index + 1}`,
        assetId:
          assetIdByKey.get(`${item.url || ""}|${item.fileId || ""}`) || null,
      }),
    )
    .join("\n") + "\n",
);

let state = {
  version: 1,
  canvasId,
  nextIndex: 0,
  committedBytes: 0,
  verified: 0,
  failed: 0,
  startedAt: now(),
  updatedAt: now(),
};
try {
  state = { ...state, ...JSON.parse(await fs.readFile(statePath, "utf8")) };
} catch {
  // Start a new run when there is no checkpoint.
}
const previous = new Map(
  (await readJsonLines(resultsPath)).map((item) => [item.referenceId, item]),
);
const refsWithIds = assets.map((item, index) => ({
  ...item,
  referenceId: `asset-${index + 1}`,
}));
const queue = refsWithIds.filter((item, index) => {
  if (index < state.nextIndex && previous.get(item.referenceId)?.status === "verified") {
    return false;
  }
  return true;
});
let cursor = 0;
const results = [...previous.values()];
const resultById = new Map(results.map((item) => [item.referenceId, item]));
const runBudget = statfsBudget();
let writeQueue = Promise.resolve();

async function persist() {
  const snapshot = {
    ...state,
    budget: runBudget,
  };
  const lines = [...resultById.values()]
    .map((item) => JSON.stringify(item))
    .join("\n");
  writeQueue = writeQueue.then(async () => {
    await fs.writeFile(statePath, JSON.stringify(snapshot, null, 2));
    await fs.writeFile(resultsPath, `${lines}${lines ? "\n" : ""}`);
  });
  await writeQueue;
}

async function worker() {
  for (;;) {
    const index = cursor++;
    if (index >= queue.length) return;
    const asset = queue[index];
    const result = await downloadAsset(context.request, asset);
    resultById.set(asset.referenceId, result);
    state.nextIndex = Math.max(
      state.nextIndex,
      refsWithIds.findIndex((item) => item.referenceId === asset.referenceId) + 1,
    );
    state.committedBytes = [...resultById.values()]
      .filter((item) => item.status === "verified")
      .reduce((sum, item) => sum + Number(item.bytes || 0), 0);
    state.verified = [...resultById.values()].filter((item) => item.status === "verified").length;
    state.failed = [...resultById.values()].filter((item) => item.status !== "verified").length;
    state.updatedAt = now();
    await persist();
    if ((state.verified + state.failed) % 10 === 0) {
      console.error(
        `[${now()}] processed=${state.verified + state.failed}/${refsWithIds.length} verified=${state.verified} failed=${state.failed} bytes=${state.committedBytes}`,
      );
    }
  }
}

console.error(
  `[${now()}] canvas=${canvasId} nodes=${snapshot.nodes.length} connections=${snapshot.connections.length} refs=${refsWithIds.length} queue=${queue.length} budget=${JSON.stringify(runBudget)}`,
);
await Promise.all(Array.from({ length: concurrency }, worker));
const finalResults = [...resultById.values()];
const report = {
  schema_version: 1,
  canvasId,
  canvasName: snapshot.canvas?.data?.canvas?.name ?? null,
  nodeCount: snapshot.nodes.length,
  connectionCount: snapshot.connections.length,
  referenceCount: deduped.length,
  uniqueAssetCount: refsWithIds.length,
  uniqueUrlCount: new Set(refsWithIds.map((item) => item.url).filter(Boolean)).size,
  verifiedCount: finalResults.filter((item) => item.status === "verified").length,
  failedCount: finalResults.filter((item) => item.status !== "verified").length,
  verifiedBytes: finalResults
    .filter((item) => item.status === "verified")
    .reduce((sum, item) => sum + Number(item.bytes || 0), 0),
  statuses: Object.fromEntries(
    [...new Set(finalResults.map((item) => item.status))].map((status) => [
      status,
      finalResults.filter((item) => item.status === status).length,
    ]),
  ),
  budget: runBudget,
  finishedAt: now(),
};
await fs.writeFile(path.join(root, "report.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
await browser.close();
