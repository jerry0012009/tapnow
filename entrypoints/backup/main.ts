import { browser } from "wxt/browser";
import { collectPages } from "../../utils/backup/pagination";
import { discoverAssetReferences } from "../../utils/backup/discover";
import { downloadToDirectory, indexReferences, reconcileAssets, localFile, writeLocal, verifySaved, type LocalDirectory, type Result } from "../../utils/backup/engine";

const app = document.querySelector<HTMLDivElement>("#app")!;
app.innerHTML = `
<style>
:root{font-family:system-ui,sans-serif;color:#17212b;background:#f5f7f8}body{max-width:1100px;margin:auto;padding:24px}
h1{font-size:24px}.row{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin:14px 0}
button,input,select{font:inherit;padding:9px 12px;border:1px solid #bdc8cd;border-radius:6px;background:#fff}button{cursor:pointer}
.primary{background:#126f5e;color:#fff}.muted{color:#63717d;font-size:13px}#status{white-space:pre-wrap;line-height:1.55}
.metrics{display:flex;gap:24px;flex-wrap:wrap;border-block:1px solid #d6dfe2;padding:16px 0}.metrics b{display:block;font-size:22px;margin-top:5px}
progress{width:100%;height:18px}
</style>
<h1>TapNow 资产备份中心</h1>
<div class="row"><button id="choose" class="primary">选择备份目录</button><span id="directory">未选择</span></div>
<div class="row"><select id="canvas" aria-label="选择画布"></select><button id="connect">连接 / 刷新页面</button><button id="scan">扫描画布</button></div>
<div class="row"><label>本轮新增上限 <input id="limit" type="number" value="20" min="0.1" step="0.1"> GiB</label><span class="muted">用户设定上限，非磁盘剩余空间</span></div>
<div class="row"><button id="backup" class="primary" disabled>开始 / 增量补齐</button><button id="pause" disabled>暂停</button></div>
<div class="metrics"><span>节点 / 连线<b id="graph">-</b></span><span>引用 / 唯一目标<b id="assets">-</b></span><span>已验证 / 待处理 / 失败<b id="counts">-</b></span><span>已写入<b id="bytes">0 GB</b></span></div>
<progress id="progress" max="1" value="0"></progress><p id="status">请保持已登录的 TapNow 画布标签页打开。</p>`;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
let directory: LocalDirectory | null = null;
let snapshot: any = null;
let running = false;
let controller: AbortController | null = null;
const record = (v: unknown): Record<string, any> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, any> : {};
const setStatus = (v: string) => $("status").textContent = v;
const setBusy = (busy: boolean) => {
  running = busy;
  for (const id of ["choose", "connect", "scan", "canvas", "limit"]) ($<HTMLButtonElement>(id)).disabled = busy;
  $<HTMLButtonElement>("backup").disabled = busy || !directory || !snapshot;
  $<HTMLButtonElement>("pause").disabled = !busy;
};
async function tabs() {
  return (await browser.tabs.query({})).filter(tab => tab.id && /^https:\/\/app\.tapnow\.ai\/canvas\//.test(tab.url || ""));
}
async function connectedTabs() {
  const result = [];
  for (const tab of await tabs()) {
    try {
      if ((await browser.tabs.sendMessage(tab.id!, { type: "tapnow:backup-ping" }))?.ok) result.push(tab);
    } catch {}
  }
  return result;
}
async function api(tabId: number, endpoint: string) {
  let result;
  try {
    result = await browser.tabs.sendMessage(tabId, { type: "tapnow:backup-fetch-json", endpoint });
  } catch {
    throw new Error("未连接到 TapNow 页面。请点击“连接 / 刷新页面”，等待页面完成加载后再扫描。");
  }
  if (!result?.ok) throw new Error(result?.error || `请求失败：${endpoint}`);
  return result.body;
}
async function refreshCanvasList() {
  const select = $<HTMLSelectElement>("canvas"); select.replaceChildren();
  for (const tab of await connectedTabs()) { const option = document.createElement("option"); option.value = String(tab.id); option.textContent = tab.title || tab.url || ""; select.append(option); }
  if (!select.options.length) setStatus("未找到已连接的 TapNow 画布。请点击“连接 / 刷新页面”。");
}
async function connect() {
  const tab = (await tabs())[0];
  if (!tab?.id) throw new Error("请先打开一个已登录的 TapNow 画布页面。");
  setStatus("正在刷新 TapNow 页面并建立扩展连接...");
  await browser.tabs.reload(tab.id);
  await new Promise(resolve => setTimeout(resolve, 1800));
  await refreshCanvasList();
  if (!$<HTMLSelectElement>("canvas").options.length) throw new Error("页面已刷新，但仍未连接。请确认账号已登录且当前是画布页面。");
  setStatus("已连接到 TapNow 画布，现在可以扫描。");
}
async function scan() {
  snapshot = null;
  setStatus("正在读取节点、连线分页及资源引用...");
  const tabId = Number($<HTMLSelectElement>("canvas").value); if (!tabId) throw new Error("没有可用画布");
  const tab = await browser.tabs.get(tabId); const id = decodeURIComponent(tab.url!.match(/\/canvas\/([^/?#]+)/)![1]);
  const base = `/api/canvas/v1/canvases/${encodeURIComponent(id)}`;
  const page = async (kind: "nodes" | "connections") => collectPages(async cursor => {
    const q = new URLSearchParams({ limit: "500" }); if (kind === "nodes") q.set("include_relations", "true"); if (cursor) q.set("cursor", cursor);
    const data = record(record(await api(tabId, `${base}/${kind}?${q}`)).data);
    if (!Array.isArray(data[kind])) throw new Error(`${kind} 列表缺失`);
    return { items: data[kind], hasMore: Boolean(data.has_more), nextCursor: data.next_cursor || null, total: typeof data.total === "number" ? data.total : null };
  }, item => String(record(item).id));
  const canvasPayload = await api(tabId, `${base}?with_nodes=true&with_connections=true`);
  const nodes = await page("nodes"), connections = await page("connections");
  if (!nodes.diagnostic.complete || !connections.diagnostic.complete) throw new Error("分页不完整，未进入下载");
  const refs = nodes.items.flatMap(node => discoverAssetReferences(id, String(record(node).id), record(node).data));
  const indexed = indexReferences(refs);
  snapshot = { canvasId: id, canvasName: String(record(record(canvasPayload).data).canvas?.name || id), canvas: record(record(canvasPayload).data).canvas || canvasPayload, nodes: nodes.items, connections: connections.items, ...indexed, diagnostics: { nodes: nodes.diagnostic, connections: connections.diagnostic } };
  $("graph").textContent = `${nodes.items.length} / ${connections.items.length}`;
  $("assets").textContent = `${refs.length} / ${indexed.assets.length}`;
  $<HTMLButtonElement>("backup").disabled = !directory;
  setStatus(`插件扫描完成：${nodes.items.length} 节点，${connections.items.length} 连线，${indexed.assets.length} 唯一资源目标。`);
}
async function backup() {
  if (!directory || !snapshot) throw new Error("先选择目录并扫描画布");
  const maxBytes = Number($<HTMLInputElement>("limit").value) * 1024 ** 3; if (!Number.isFinite(maxBytes) || !(maxBytes > 0)) throw new Error("上限必须大于 0");
  const prepared = await browser.runtime.sendMessage({ type: "tapnow:prepare-backup" });
  if (!prepared?.ok) throw new Error("媒体请求准备失败，请在扩展管理页面重新加载扩展");
  const base = await directory.getDirectoryHandle("tapnow-backup", { create: true });
  const root = await base.getDirectoryHandle(snapshot.canvasId, { create: true });
  const previous = new Map<string, Result>();
  try { const file = await (await localFile(root, "assets.ndjson")).getFile(); for (const line of (await file.text()).split("\n").filter(Boolean)) { const x = JSON.parse(line); previous.set(x.assetId, x); } }
  catch (error) { if ((error as Error).name !== "NotFoundError") throw new Error("已有清单无法读取，未覆盖。请检查目录权限或文件格式。"); }
  const targets = reconcileAssets(snapshot.assets, previous.values());
  const results = new Map<string, Result>(targets.map(asset => [asset.assetId, { ...previous.get(asset.assetId), ...asset, status: "queued" }]));
  let processed = 0, added = 0, reused = 0, stopped = false, finished = false;
  controller = new AbortController();
  const runId = `run-${Date.now()}`; const ndjson = (xs: unknown[]) => xs.map(x => JSON.stringify(x)).join("\n") + "\n";
  if (previous.size) {
    try {
      const oldReport = JSON.parse(await (await (await localFile(root, "report.json")).getFile()).text());
      if (/^run-\d+$/.test(oldReport.runId)) await writeLocal(root, `runs/${oldReport.runId}/assets.ndjson`, ndjson([...previous.values()]));
    } catch (error) { if ((error as Error).name !== "NotFoundError") throw error; }
  }
  await writeLocal(root, `runs/${runId}/snapshot.json`, JSON.stringify(snapshot));
  await writeLocal(root, "canvas.json", JSON.stringify(snapshot.canvas));
  await writeLocal(root, "nodes.ndjson", ndjson(snapshot.nodes));
  await writeLocal(root, "connections.ndjson", ndjson(snapshot.connections));
  await writeLocal(root, "references.ndjson", ndjson(snapshot.references));
  let persistQueue = Promise.resolve();
  const persist = async () => {
    const all = [...results.values()], ok = all.filter(x => x.status === "verified");
    $("counts").textContent = `${ok.length} / ${all.filter(x => x.status === "queued").length} / ${all.filter(x => x.status !== "verified" && x.status !== "queued").length}`;
    $("bytes").textContent = `${(added / 1e9).toFixed(2)} GB`; $<HTMLProgressElement>("progress").max = targets.length; $<HTMLProgressElement>("progress").value = processed;
    const report = {
      schema_version: 1, producer: "chrome-extension", transport: "extension-fetch", writer: "FileSystemAccess", runId,
      canvasId: snapshot.canvasId, canvasName: snapshot.canvasName, nodeCount: snapshot.nodes.length,
      nodeTypes: snapshot.nodes.reduce((counts: Record<string, number>, node: any) => { const type = node.type || "unknown"; counts[type] = (counts[type] || 0) + 1; return counts; }, {}),
      connectionCount: snapshot.connections.length, referenceCount: snapshot.references.length, uniqueAssetCount: targets.length,
      currentScanAssetCount: snapshot.assets.length, retainedAssetCount: targets.length - snapshot.assets.length,
      verifiedCount: ok.length, failedCount: all.filter(x => !["verified", "queued"].includes(x.status)).length,
      pendingCount: all.filter(x => x.status === "queued").length, processed, reusedCount: reused, newBytes: added,
      verifiedBytes: ok.reduce((s, a) => s + (a.bytes || 0), 0),
      physicalBytes: [...new Map(ok.map(a => [a.file, a.bytes || 0])).values()].reduce((a,b) => a+b,0),
      status: stopped ? "storage-budget-exceeded" : controller!.signal.aborted ? "paused" : finished ? (ok.length === targets.length ? "completed" : "partial") : "running",
      limitBytes: maxBytes, diagnostics: snapshot.diagnostics, updatedAt: new Date().toISOString(),
      ...(finished ? { finishedAt: new Date().toISOString() } : {})
    };
    setStatus(`${report.status} · ${processed}/${targets.length} · 已验证 ${ok.length} · 复用 ${reused} · 旧目标保留 ${report.retainedAssetCount}\n${directory!.name}/tapnow-backup/${snapshot.canvasId}`);
    persistQueue = persistQueue.then(async () => {
      await writeLocal(root, "assets.ndjson", ndjson(all));
      await writeLocal(root, "report.json", JSON.stringify(report, null, 2));
      await writeLocal(root, `runs/${runId}/report.json`, JSON.stringify(report, null, 2));
      await writeLocal(root, `runs/${runId}/assets.ndjson`, ndjson(all));
    });
    await persistQueue;
  };
  await persist();
  let cursor = 0;
  const worker = async () => {
    for (;;) {
      const asset = targets[cursor++];
      if (!asset || controller!.signal.aborted || stopped) return;
      const old = previous.get(asset.assetId);
      if (old?.file && old.sha256 && await verifySaved(root, { ...old, status: "verified" })) { results.set(asset.assetId, { ...old, ...asset, status: "verified", reused: true }); reused++; processed++; await persist(); continue; }
      try {
        const result = await downloadToDirectory(root, asset, { signal: controller!.signal, claim: bytes => { if (added + bytes > maxBytes) throw new Error("storage-budget-exceeded"); added += bytes; }, release: bytes => { added = Math.max(0, added - bytes); } });
        results.set(asset.assetId, result); if (/storage-budget|QuotaExceeded|NotAllowed|No space/i.test(result.reason || "")) stopped = true;
      } catch (error) { results.set(asset.assetId, { ...asset, status: "retryable", reason: String(error) }); }
      processed++; await persist();
    }
  };
  const workers = await Promise.allSettled(Array.from({ length: 4 }, async () => {
    try { await worker(); } catch (error) { controller?.abort(); throw error; }
  }));
  const rejected = workers.find(w => w.status === "rejected");
  if (rejected?.status === "rejected") throw rejected.reason;
  finished = true; await persist();
}
$("choose").onclick = async () => { try { directory = await (window as any).showDirectoryPicker({ mode: "readwrite", id: "tapnow-backup" }); $("directory").textContent = directory.name; $<HTMLButtonElement>("backup").disabled = !snapshot; setStatus(`已选择目录：${directory.name}`); } catch (e) { setStatus(String(e)); } };
$("connect").onclick = async () => { setBusy(true); try { await connect(); } catch (e) { setStatus(String(e)); } finally { setBusy(false); } };
$("scan").onclick = async () => { setBusy(true); try { await scan(); } catch (e) { setStatus(String(e)); } finally { setBusy(false); } };
$("backup").onclick = async () => {
  if (running) return;
  setBusy(true);
  try {
    await navigator.locks.request("tapnow-backup-writer", { ifAvailable: true }, async lock => {
      if (!lock) throw new Error("另一个备份页正在运行");
      await backup();
    });
  } catch (e) { controller?.abort(); setStatus(`备份未完成：${String(e)}。已完成文件保留，可增量补齐。`); }
  finally { setBusy(false); }
};
$("pause").onclick = () => controller?.abort();
void refreshCanvasList().catch(e => setStatus(String(e)));
window.addEventListener("beforeunload", event => { if (running) { event.preventDefault(); event.returnValue = ""; } });
