import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { chromium } from "playwright";

const canvasId =
  process.env.TAPNOW_CANVAS_ID ??
  "350073d9-2b5a-4a79-b057-4f9e644c75d4";
const baseUrl = "https://app.tapnow.ai";
const outputDir = path.resolve(
  process.env.TAPNOW_EXPORT_DIR ??
    `artifacts/private/export-${canvasId}-${new Date()
      .toISOString()
      .replaceAll(":", "-")
      .replaceAll(".", "-")}`,
);
const maxAssets = Number(process.env.TAPNOW_MAX_ASSETS ?? 100);
const maxAssetBytes = Number(process.env.TAPNOW_MAX_ASSET_BYTES ?? 200_000_000);

await fs.mkdir(path.join(outputDir, "media"), { recursive: true });

const browser = await chromium.connectOverCDP(
  process.env.TAPNOW_CDP_URL ?? "http://127.0.0.1:9223",
);
const context = browser.contexts()[0];
const page = context
  .pages()
  .find((candidate) => candidate.url().includes("app.tapnow.ai"));
if (!page) throw new Error("No authenticated TapNow page was found.");

const accessToken = await page.evaluate(() =>
  localStorage.getItem("access_token"),
);
if (!accessToken) throw new Error("TapNow access token is missing.");

const headers = { Authorization: `Bearer ${accessToken}` };
const endpoints = {
  canvas: `/api/canvas/v1/canvases/${canvasId}?with_nodes=true&with_connections=true`,
  nodes: `/api/canvas/v1/canvases/${canvasId}/nodes?limit=100&include_relations=true`,
  connections: `/api/canvas/v1/canvases/${canvasId}/connections?limit=100`,
};
const responses = {};

for (const [name, endpoint] of Object.entries(endpoints)) {
  const response = await context.request.get(`${baseUrl}${endpoint}`, {
    headers,
  });
  if (!response.ok()) {
    throw new Error(`${name} export failed with HTTP ${response.status()}`);
  }
  responses[name] = await response.json();
  await fs.writeFile(
    path.join(outputDir, `${name}.json`),
    JSON.stringify(responses[name], null, 2),
  );
}

function collectUrls(value, result = new Set()) {
  if (typeof value === "string") {
    if (/^https?:\/\//i.test(value)) result.add(value);
    return result;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectUrls(item, result);
    return result;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) collectUrls(item, result);
  }
  return result;
}

function extensionFor(contentType, url) {
  const byType = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/gif": ".gif",
    "video/mp4": ".mp4",
    "video/webm": ".webm",
    "audio/mpeg": ".mp3",
    "audio/wav": ".wav",
    "text/csv": ".csv",
    "application/json": ".json",
  };
  const normalizedType = contentType.split(";")[0].trim().toLowerCase();
  if (byType[normalizedType]) return byType[normalizedType];
  const pathnameExtension = path.extname(new URL(url).pathname);
  return pathnameExtension.length <= 8 ? pathnameExtension : "";
}

const urls = [...collectUrls(responses)].filter((url) => {
  const hostname = new URL(url).hostname;
  return (
    hostname.endsWith("tapnow.ai") ||
    hostname.endsWith("tapnow.media")
  );
});
const mediaManifest = [];
let downloadedBytes = 0;

for (const [index, url] of urls.slice(0, maxAssets).entries()) {
  if (downloadedBytes >= maxAssetBytes) break;
  try {
    const response = await context.request.get(url, {
      headers: {
        Referer: `${baseUrl}/`,
      },
    });
    if (!response.ok()) {
      mediaManifest.push({ url, status: response.status(), downloaded: false });
      continue;
    }
    const body = await response.body();
    if (downloadedBytes + body.length > maxAssetBytes) {
      mediaManifest.push({
        url,
        status: response.status(),
        downloaded: false,
        reason: "total size limit",
      });
      break;
    }
    const contentType = response.headers()["content-type"] ?? "";
    const hash = crypto.createHash("sha256").update(url).digest("hex").slice(0, 16);
    const outputName = `${String(index + 1).padStart(3, "0")}-${hash}${extensionFor(
      contentType,
      url,
    )}`;
    await fs.writeFile(path.join(outputDir, "media", outputName), body);
    downloadedBytes += body.length;
    mediaManifest.push({
      url,
      status: response.status(),
      downloaded: true,
      file: outputName,
      bytes: body.length,
      contentType,
    });
  } catch (error) {
    mediaManifest.push({
      url,
      downloaded: false,
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}

const nodes = responses.nodes?.data?.nodes ?? [];
const connections = responses.connections?.data?.connections ?? [];
const summary = {
  exportedAt: new Date().toISOString(),
  canvasId,
  canvasName:
    responses.canvas?.data?.canvas?.name ??
    responses.canvas?.data?.canvas?.title ??
    null,
  nodeCount: nodes.length,
  connectionCount: connections.length,
  nodeTypes: Object.fromEntries(
    Object.entries(
      nodes.reduce((counts, node) => {
        const type = node.type ?? node.node_type ?? "unknown";
        counts[type] = (counts[type] ?? 0) + 1;
        return counts;
      }, {}),
    ).sort(),
  ),
  referencedAssetCount: urls.length,
  downloadedAssetCount: mediaManifest.filter((item) => item.downloaded).length,
  downloadedBytes,
};

await fs.writeFile(
  path.join(outputDir, "media-manifest.json"),
  JSON.stringify(mediaManifest, null, 2),
);
await fs.writeFile(
  path.join(outputDir, "summary.json"),
  JSON.stringify(summary, null, 2),
);

console.log(JSON.stringify({ outputDir, ...summary }, null, 2));
await browser.close();
