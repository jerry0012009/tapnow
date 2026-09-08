import { browser } from "wxt/browser";
import { calculateStorageBudget } from "../../utils/backup/storage";
import { collectPages } from "../../utils/backup/pagination";
import { discoverAssetReferences } from "../../utils/backup/discover";
import { createCheckpoint, transitionCheckpoint } from "../../utils/backup/checkpoint";
import type { BackupScope } from "../../utils/backup/types";

type DirectoryHandle = {
  name: string;
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<DirectoryHandle>;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<FileHandle>;
};

type FileHandle = {
  createWritable(): Promise<{
    write(data: string | Blob | { type: "write"; position: number; data: Uint8Array }): Promise<void>;
    close(): Promise<void>;
  }>;
};

type DirectoryPickerWindow = Window & {
  showDirectoryPicker?: () => Promise<DirectoryHandle>;
};

const app = document.querySelector<HTMLDivElement>("#app")!;
app.innerHTML = `
  <style>
    :root { color-scheme: light; font-family: system-ui, -apple-system, sans-serif; }
    body { max-width: 980px; margin: 0 auto; padding: 28px; color: #0f172a; background: #f8fafc; }
    h1 { margin: 0 0 6px; font-size: 24px; }
    p { color: #475569; line-height: 1.5; }
    .toolbar { display:flex; gap:10px; flex-wrap:wrap; margin:18px 0; }
    button { min-height:38px; padding:0 14px; border:1px solid #cbd5e1; border-radius:7px; background:#fff; color:#0f172a; font-weight:700; cursor:pointer; }
    button.primary { background:#0f766e; border-color:#0f766e; color:#fff; }
    button:disabled { cursor:not-allowed; opacity:.55; }
    .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(220px,1fr)); gap:12px; }
    .metric { padding:14px; border:1px solid #dbe3ed; background:#fff; border-radius:8px; }
    .metric strong { display:block; font-size:22px; margin-top:4px; }
    .label { color:#64748b; font-size:12px; font-weight:700; }
    #status { margin-top:16px; padding:12px; border-left:4px solid #0f766e; background:#ecfdf5; white-space:pre-wrap; }
    .warning { border-left-color:#d97706 !important; background:#fffbeb !important; }
    code { overflow-wrap:anywhere; }
  </style>
  <h1>TapNow 备份中心</h1>
  <p>首版从当前已打开的 TapNow 画布开始。你选择的目录只保存本地备份；本页不上传数据到 learning 或第三方服务。</p>
  <div class="toolbar">
    <button id="choose" class="primary">选择备份目录</button>
    <button id="scan">扫描当前画布</button>
    <button id="backup" class="primary" disabled>保存当前画布快照</button>
  </div>
  <div class="grid">
    <div class="metric"><span class="label">目录</span><strong id="directory">未选择</strong></div>
    <div class="metric"><span class="label">画布</span><strong id="canvas">未扫描</strong></div>
    <div class="metric"><span class="label">节点 / 连线</span><strong id="graph">-</strong></div>
    <div class="metric"><span class="label">发现资源引用</span><strong id="assets">-</strong></div>
    <div class="metric"><span class="label">本机保存预算</span><strong id="budget">读取中</strong></div>
  </div>
  <div id="status" role="status">请保持一个已登录的 TapNow 画布标签页打开。</div>
`;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
let directory: DirectoryHandle | null = null;
let scanned: {
  canvas: unknown;
  nodes: unknown[];
  connections: unknown[];
  assets: ReturnType<typeof discoverAssetReferences>;
  canvasId: string;
  canvasName: string;
} | null = null;

function setStatus(text: string, warning = false) {
  $("status").textContent = text;
  $("status").classList.toggle("warning", warning);
}

async function activeTapNowTab() {
  const tabs = await browser.tabs.query({});
  const candidates = tabs
    .filter((tab) => tab.id && tab.url?.startsWith("https://app.tapnow.ai/canvas/"))
    .sort((left, right) => Number(right.active) - Number(left.active));
  const tab = candidates[0];
  if (!tab?.id) {
    throw new Error("请先打开一个已登录的 TapNow 画布标签页。");
  }
  return tab.id;
}

async function fetchJson(tabId: number, endpoint: string): Promise<unknown> {
  const response = await browser.tabs.sendMessage(tabId, {
    type: "tapnow:backup-fetch-json",
    endpoint
  });
  if (!response?.ok) {
    throw new Error(response?.error || `备份接口请求失败：${endpoint}`);
  }
  return response.body;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function listFromPayload(payload: unknown, key: string): unknown[] {
  const data = record(record(payload).data);
  const value = data[key];
  return Array.isArray(value) ? value : [];
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function writeBytes(
  root: DirectoryHandle,
  path: string,
  chunks: Uint8Array[]
) {
  const segments = path.split("/");
  const filename = segments.pop()!;
  let current = root;
  for (const segment of segments) {
    current = await current.getDirectoryHandle(segment, { create: true });
  }
  const file = await current.getFileHandle(filename, { create: true });
  const writable = await file.createWritable();
  let position = 0;
  for (const chunk of chunks) {
    await writable.write({ type: "write", position, data: chunk });
    position += chunk.length;
  }
  await writable.close();
}

async function downloadAsset(tabId: number, asset: ReturnType<typeof discoverAssetReferences>[number]) {
  if (!asset.url) {
    return {
      ...asset,
      status: "unavailable-after-recovery" as const,
      reason: "no-download-url-for-file-id"
    };
  }
  const chunks: Uint8Array[] = [];
  let offset = 0;
  let totalBytes: number | null = null;
  let metadata: Record<string, unknown> = {};
  for (let attempt = 0; attempt < 10; attempt++) {
    const response = await browser.tabs.sendMessage(tabId, {
      type: "tapnow:backup-fetch-asset",
      url: asset.url,
      start: offset,
      end: offset + 4_000_000 - 1
    });
    if (!response?.ok) {
      return { ...asset, status: "retryable" as const, reason: response?.error || "asset-fetch-failed" };
    }
    const chunk = base64ToBytes(response.dataBase64 || "");
    if (!chunk.length) break;
    chunks.push(chunk);
    offset += chunk.length;
    totalBytes = typeof response.totalBytes === "number" ? response.totalBytes : totalBytes;
    metadata = {
      contentType: response.contentType,
      etag: response.etag,
      lastModified: response.lastModified,
      totalBytes
    };
    if (response.complete || (totalBytes !== null && offset >= totalBytes)) break;
  }
  if (!chunks.length || (totalBytes !== null && offset !== totalBytes)) {
    return { ...asset, status: "retryable" as const, reason: "incomplete-asset-range", ...metadata };
  }
  const bytes = new Uint8Array(offset);
  let position = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, position);
    position += chunk.length;
  }
  return {
    ...asset,
    status: "verified" as const,
    bytes,
    sha256: await sha256(bytes),
    ...metadata
  };
}

async function scanCanvas() {
  const tabId = await activeTapNowTab();
  const url = (await browser.tabs.get(tabId)).url || "";
  const match = url.match(/\/canvas\/([^/?#]+)/);
  if (!match) throw new Error("当前页面不是具体画布页面。");
  const canvasId = decodeURIComponent(match[1]);
  const canvasPayload = await fetchJson(
    tabId,
    `/api/canvas/v1/canvases/${encodeURIComponent(canvasId)}?with_nodes=true&with_connections=true`
  );
  const canvas = record(record(canvasPayload).data).canvas || canvasPayload;
  const snapshot = record(canvas);
  const nodes = listFromPayload(canvasPayload, "nodes");
  const connections = listFromPayload(canvasPayload, "connections");

  const nodePages = await collectPages(
    async (cursor) => {
      const query = new URLSearchParams({
        limit: "500",
        include_relations: "true"
      });
      if (cursor) query.set("cursor", cursor);
      const payload = await fetchJson(
        tabId,
        `/api/canvas/v1/canvases/${encodeURIComponent(canvasId)}/nodes?${query}`
      );
      const data = record(record(payload).data);
      return {
        items: Array.isArray(data.nodes) ? data.nodes : [],
        hasMore: Boolean(data.has_more),
        nextCursor: typeof data.next_cursor === "string" ? data.next_cursor : null,
        total: typeof data.total === "number" ? data.total : null
      };
    },
    (item) => String(record(item).id || JSON.stringify(item))
  );
  const connectionPages = await collectPages(
    async (cursor) => {
      const query = new URLSearchParams({ limit: "500" });
      if (cursor) query.set("cursor", cursor);
      const payload = await fetchJson(
        tabId,
        `/api/canvas/v1/canvases/${encodeURIComponent(canvasId)}/connections?${query}`
      );
      const data = record(record(payload).data);
      return {
        items: Array.isArray(data.connections) ? data.connections : [],
        hasMore: Boolean(data.has_more),
        nextCursor: typeof data.next_cursor === "string" ? data.next_cursor : null,
        total: typeof data.total === "number" ? data.total : null
      };
    },
    (item) => String(record(item).id || JSON.stringify(item))
  );
  const completeNodes = nodePages.diagnostic.complete ? nodePages.items : nodes;
  const completeConnections = connectionPages.diagnostic.complete
    ? connectionPages.items
    : connections;
  const assets = completeNodes.flatMap((node) =>
    discoverAssetReferences(canvasId, String(record(node).id || "") || null, record(node).data)
  );
  scanned = {
    canvas: snapshot,
    nodes: completeNodes,
    connections: completeConnections,
    assets,
    canvasId,
    canvasName: String(snapshot.name || snapshot.title || canvasId)
  };
  $("canvas").textContent = scanned.canvasName;
  $("graph").textContent = `${completeNodes.length} / ${completeConnections.length}`;
  $("assets").textContent = String(assets.length);
  $("backup").removeAttribute("disabled");
  setStatus(
    `扫描完成：节点分页 ${nodePages.diagnostic.pages} 页，连线分页 ${connectionPages.diagnostic.pages} 页。\n` +
    `节点 ${completeNodes.length}，连线 ${completeConnections.length}，资源引用 ${assets.length}。`
  );
}

async function writeText(root: DirectoryHandle, path: string, value: unknown) {
  const segments = path.split("/");
  const filename = segments.pop()!;
  let current = root;
  for (const segment of segments) {
    current = await current.getDirectoryHandle(segment, { create: true });
  }
  const file = await current.getFileHandle(filename, { create: true });
  const writable = await file.createWritable();
  await writable.write(JSON.stringify(value, null, 2));
  await writable.close();
}

async function saveSnapshot() {
  if (!directory || !scanned) throw new Error("请先选择目录并扫描当前画布。");
  const tabId = await activeTapNowTab();
  const checkpoint = createCheckpoint(
    `tapnow-${scanned.canvasId}`,
    `run-${Date.now()}`,
    { kind: "canvas", ids: [scanned.canvasId], includeChildren: false } satisfies BackupScope
  );
  const estimate = await navigator.storage?.estimate?.();
  const availableBytes = Math.max(
    0,
    Number(estimate?.quota || 0) - Number(estimate?.usage || 0)
  );
  const budget = calculateStorageBudget(availableBytes);
  const runRoot = await directory.getDirectoryHandle("tapnow-backup", { create: true });
  const runId = checkpoint.runId;
  await writeText(runRoot, `runs/${runId}/canvas.json`, scanned.canvas);
  await writeText(runRoot, `runs/${runId}/nodes.json`, scanned.nodes);
  await writeText(runRoot, `runs/${runId}/connections.json`, scanned.connections);
  const assetResults = [];
  let committedBytes = 0;
  for (const asset of scanned.assets) {
    const result = await downloadAsset(tabId, asset);
    if (result.status === "verified") {
      const nextBytes = result.bytes.byteLength;
      if (!budget.usableBytes || committedBytes + nextBytes > budget.usableBytes) {
        assetResults.push({
          ...asset,
          status: "retryable",
          reason: "storage-budget-exceeded",
          expectedBytes: nextBytes
        });
        continue;
      }
      await writeBytes(runRoot, `objects/sha256/${result.sha256.slice(0, 2)}/${result.sha256}`, [result.bytes]);
      committedBytes += nextBytes;
      assetResults.push({
        ...result,
        bytes: undefined,
        file: `objects/sha256/${result.sha256.slice(0, 2)}/${result.sha256}`
      });
    } else {
      assetResults.push(result);
    }
  }
  await writeText(runRoot, `runs/${runId}/assets.json`, assetResults);
  await writeText(
    runRoot,
    `runs/${runId}/checkpoint.json`,
    transitionCheckpoint(checkpoint, "completed", {
      budget,
      nextAssetIndex: assetResults.length,
      committedBytes,
      failedAssetIds: assetResults
        .filter((asset) => asset.status !== "verified")
        .map((asset) => asset.referenceId)
    })
  );
  await writeText(runRoot, "manifest.json", {
    schema_version: 1,
    backup_id: `tapnow-${scanned.canvasId}`,
    latest_run_id: runId,
    canvas_id: scanned.canvasId,
    canvas_name: scanned.canvasName,
    node_count: scanned.nodes.length,
    connection_count: scanned.connections.length,
    asset_reference_count: scanned.assets.length,
    asset_download_status: assetResults.every((asset) => asset.status === "verified")
      ? "verified"
      : "partial",
    downloaded_asset_count: assetResults.filter((asset) => asset.status === "verified").length,
    downloaded_bytes: committedBytes,
    storage_budget: budget,
    note: "Asset files are content-addressed and verified with SHA-256; unresolved references remain in assets.json."
  });
  setStatus(
    `已保存画布快照到 ${directory.name}/tapnow-backup/runs/${runId}。\n` +
    `已保存元数据、节点、连线和资源字节：${assetResults.filter((asset) => asset.status === "verified").length}/${assetResults.length}，` +
    `字节 ${committedBytes}。未解决资源已记录，可通过增量运行补漏。`
  );
}

$("choose").addEventListener("click", async () => {
  try {
    const picker = (window as DirectoryPickerWindow).showDirectoryPicker;
    if (!picker) throw new Error("当前 Chrome 不支持目录选择 API。");
    directory = await picker();
    $("directory").textContent = directory.name;
    setStatus(`已选择目录：${directory.name}。现在可以扫描当前画布。`);
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error), true);
  }
});
$("scan").addEventListener("click", async () => {
  try {
    setStatus("正在通过当前 TapNow 页面读取画布和分页数据，请稍候。");
    await scanCanvas();
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error), true);
  }
});
$("backup").addEventListener("click", async () => {
  try {
    setStatus("正在写入本地快照。");
    await saveSnapshot();
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error), true);
  }
});

void navigator.storage?.estimate?.().then((estimate) => {
  const availableBytes = Math.max(
    0,
    Number(estimate?.quota || 0) - Number(estimate?.usage || 0)
  );
  const budget = calculateStorageBudget(availableBytes);
  $("budget").textContent = budget.usableBytes
    ? `${(budget.usableBytes / 1024 ** 3).toFixed(1)} GB（浏览器估算）`
    : "运行时测量";
});
