import { browser } from "wxt/browser";
import { collectPages } from "../../utils/backup/pagination";
import { discoverAssetReferences } from "../../utils/backup/discover";
import { downloadToDirectory, indexReferences, reconcileAssets, localFile, writeLocal, verifySaved, type LocalDirectory, type Result } from "../../utils/backup/engine";
import { canvasIdFromUrl, sourceMatches } from "../../utils/backup/source";
import { directoryHandle } from "../../utils/backup/handles";
import { createIcons, FolderOpen, RefreshCw, ScanSearch, ExternalLink, Download, Pause } from "lucide";

const app = document.querySelector<HTMLDivElement>("#app")!;
app.innerHTML = `
<style>
:root{font-family:system-ui,sans-serif;color:#17212b;background:#f5f7f8}*{box-sizing:border-box}body{max-width:1000px;margin:auto;padding:24px}
h1{font-size:24px}h2{font-size:18px;margin:0}p{overflow-wrap:anywhere}.row{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin:14px 0}
button,input,select{font:inherit;padding:9px 12px;border:1px solid #bdc8cd;border-radius:6px;background:#fff}button{cursor:pointer}
button{display:inline-flex;align-items:center;justify-content:center;gap:7px}button svg{width:17px;height:17px;flex-shrink:0}button:disabled{opacity:.5;cursor:not-allowed}
.primary{background:#126f5e;color:#fff}.muted{color:#52616d;font-size:13px}#status{white-space:pre-wrap;line-height:1.55}
.metrics{display:flex;gap:24px;flex-wrap:wrap;border-block:1px solid #d6dfe2;padding:16px 0}.metrics b{display:block;font-size:22px;margin-top:5px}
progress{width:100%;height:18px}.step{padding:18px 0;border-top:1px solid #d6dfe2}.step-label{font-size:13px;color:#52616d;margin-bottom:12px}
#canvas{flex:1;min-width:0;max-width:100%}#target-name{font-size:22px;overflow-wrap:anywhere;margin:8px 0}#target-id{overflow-wrap:anywhere;font-size:13px}
#connection{color:#126f5e;font-size:13px}#limit{width:110px}#destination{font-size:13px;color:#52616d;overflow-wrap:anywhere}
@media(max-width:600px){body{padding:16px}.row #canvas{flex-basis:100%}h1{font-size:22px}#target-name{font-size:20px}.metrics{gap:16px}}
</style>
<h1>TapNow 资产备份中心</h1>
<button id="open-library"><i data-lucide="folder-open"></i>查看本地备份</button>
<section class="step"><div class="step-label">1. 备份画布</div>
<div class="row"><select id="canvas" aria-label="选择备份画布"></select><button id="refresh-tabs" title="更新已打开的画布列表"><i data-lucide="refresh-cw"></i>更新列表</button></div>
<h2 id="target-name">尚未选择画布</h2><div id="target-id"></div><p id="origin" class="muted"></p>
<div class="row"><span id="connection">未连接</span><button id="source" disabled><i data-lucide="external-link"></i>查看原画布</button><button id="connect" disabled><i data-lucide="refresh-cw"></i>重新连接</button></div>
<button id="scan" class="primary" disabled><i data-lucide="scan-search"></i>扫描此画布</button><p id="scan-summary" class="muted">尚未扫描</p></section>
<section class="step"><div class="step-label">2. 保存位置</div>
<div class="row"><button id="choose"><i data-lucide="folder-open"></i>选择备份目录</button><span id="directory">未选择</span></div>
<p id="destination">未选择保存目录</p>
<div class="row"><label>本轮新增上限 <input id="limit" type="number" value="20" min="0.1" step="0.1"> GiB</label><span class="muted">用户设定上限，非磁盘剩余空间</span></div>
</section><section class="step"><div class="step-label">3. 执行备份</div>
<div class="row"><button id="backup" class="primary" disabled><i data-lucide="download"></i>开始 / 增量补齐</button><button id="pause" disabled><i data-lucide="pause"></i>暂停</button></div>
<div class="metrics"><span>节点 / 连线<b id="graph">-</b></span><span>引用 / 唯一目标<b id="assets">-</b></span><span>已验证 / 待处理 / 失败<b id="counts">-</b></span><span>已写入<b id="bytes">0 GB</b></span></div>
<progress id="progress" max="1" value="0"></progress><p id="status" role="status">正在读取来源画布...</p></section>`;
createIcons({ icons: { FolderOpen, RefreshCw, ScanSearch, ExternalLink, Download, Pause } });

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
let directory: LocalDirectory | null = null;
let snapshot: any = null;
let running = false;
let downloading = false;
let target: { tabId: number; canvasId: string; name: string } | null = null;
let generation = 0;
let scanInvalidated = false;
const query = new URLSearchParams(location.search);
let controller: AbortController | null = null;
const record = (v: unknown): Record<string, any> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, any> : {};
const setStatus = (v: string) => $("status").textContent = v;
$("open-library").onclick = async () => {
  try {
    const params = new URLSearchParams();
    if (directory) {
      const key = `backup-${await browser.tabs.getCurrent().then(tab => tab?.id || "current")}`;
      await directoryHandle(key, directory);
      params.set("directory", key);
      if (snapshot?.canvasId || target?.canvasId) params.set("canvasId", snapshot?.canvasId || target!.canvasId);
    }
    await browser.tabs.create({ url: `${browser.runtime.getURL("/library.html")}?${params}` });
  } catch (error) { setStatus(`打开本地查看器失败：${String(error)}`); }
};
const setBusy = (busy: boolean) => {
  running = busy;
  for (const id of ["choose", "connect", "scan", "canvas", "limit", "refresh-tabs"]) ($<HTMLButtonElement>(id)).disabled = busy;
  for (const id of ["connect", "scan", "source"]) $<HTMLButtonElement>(id).disabled = busy || !target;
  $<HTMLButtonElement>("backup").disabled = busy || !directory || !snapshot;
  $<HTMLButtonElement>("pause").disabled = !downloading;
};
async function tabs() {
  return (await browser.tabs.query({})).filter(tab => tab.id && canvasIdFromUrl(tab.url));
}
function resetScan(message = "尚未扫描") {
  snapshot = null;
  for (const id of ["graph", "assets", "counts"]) $(id).textContent = "-";
  $("bytes").textContent = "0 GB";
  $<HTMLProgressElement>("progress").value = 0;
  $("scan-summary").textContent = message;
  $<HTMLButtonElement>("backup").disabled = true;
}
function destination() {
  $("destination").textContent = directory && target ? `${directory.name}/tapnow-backup/${target.canvasId}` : "未选择保存目录";
}
function updateName(name: string) {
  if (!target) return;
  target.name = name;
  $("target-name").textContent = name;
  document.title = `${name} · TapNow 备份中心`;
  const option = [...$<HTMLSelectElement>("canvas").options].find(o => o.value === String(target!.tabId));
  if (option) option.textContent = `${name} · ${target.canvasId} · 标签页 ${target.tabId}`;
}
async function checkSource(tabId: number, canvasId: string) {
  const tab = await browser.tabs.get(tabId);
  if (!sourceMatches(tab, tabId, canvasId)) throw new Error("原标签页已切换画布，请更新列表并重新扫描。");
  return tab;
}
async function ensureConnection() {
  if (!target) throw new Error("请先选择具体画布。");
  await checkSource(target.tabId, target.canvasId);
  const result = await browser.runtime.sendMessage({ type: "tapnow:ensure-backup-bridge", tabId: target.tabId, canvasId: target.canvasId });
  if (!result?.ok) throw new Error(result?.error || "页面通信未建立");
  if (!snapshot && result.title) updateName(result.title.split(/\s[|｜]\s*/)[0]);
  $("connection").textContent = result.hasSession ? "已连接 · 页面有登录会话" : "已连接 · 请在原画布登录";
  if (!result.hasSession) throw new Error("页面通信已建立，但没有登录会话。请点击“查看原画布”登录。");
}
async function api(tabId: number, endpoint: string) {
  if (!target || target.tabId !== tabId || scanInvalidated) throw new Error("扫描来源已改变，请重新扫描。");
  let result;
  try {
    result = await browser.tabs.sendMessage(tabId, { type: "tapnow:backup-v2-json", endpoint, expectedCanvasId: target.canvasId }, { frameId: 0 });
  } catch {
    throw new Error("与原画布的连接已中断，请点击“重新连接”。");
  }
  if (!result?.ok) throw new Error(result?.error || "画布未返回有效响应，请点击“重新连接”后再扫描。");
  return result.body;
}
async function selectTarget(tabId: number, expectedId?: string) {
  generation++;
  resetScan();
  target = null;
  $("connection").textContent = "未连接";
  $("target-name").textContent = "尚未选择画布";
  $("target-id").textContent = "";
  document.title = "选择画布 · TapNow 备份中心";
  if (!tabId) { destination(); return; }
  const tab = await browser.tabs.get(tabId);
  const id = canvasIdFromUrl(tab.url);
  if (!id || expectedId && expectedId !== id) throw new Error("来源画布已改变，未自动改选其他画布。请更新列表后明确选择。");
  target = { tabId, canvasId: id, name: tab.title?.split(/\s[|｜]\s*/)[0] || id };
  updateName(target.name);
  $("target-id").textContent = `画布 ID：${id}`;
  destination();
  try { await ensureConnection(); setStatus("来源画布已确认。"); }
  catch (error) { $("connection").textContent = "未就绪"; setStatus(String(error)); }
}
async function refreshCanvasList(initial = false) {
  const remembered = target;
  const select = $<HTMLSelectElement>("canvas");
  select.replaceChildren(new Option("请选择具体画布（非项目列表）", ""));
  const available = await tabs();
  for (const tab of available) {
    const id = canvasIdFromUrl(tab.url)!;
    select.append(new Option(`${tab.title || id} · ${id} · 标签页 ${tab.id}`, String(tab.id)));
  }
  const wantedTab = initial ? Number(query.get("sourceTab")) : remembered?.tabId;
  const wantedId = initial ? query.get("canvasId") : remembered?.canvasId;
  const found = available.find(tab => tab.id === wantedTab && canvasIdFromUrl(tab.url) === wantedId);
  if (found) {
    select.value = String(found.id);
    if (!target) await selectTarget(found.id!, wantedId!);
  } else {
    await selectTarget(0);
    setStatus(wantedId ? "原来源标签页已关闭或切换，未自动选择其他画布。" : available.length ? "请从列表明确选择要备份的画布。" : "没有打开的具体画布。请在 TapNow 项目列表中打开一张画布，再点击它的“备份此画布”。");
  }
  $("origin").textContent = initial && query.get("canvasId") ? "来源：你点击“备份此画布”的标签页" : query.get("from") === "projects" ? "来源：项目列表；仅备份上方选中的单画布" : "范围：上方选中的单画布";
}
async function connect() {
  await ensureConnection();
  setStatus(snapshot ? `已重新连接「${target!.name}」，原扫描结果仍属于此画布。` : `已连接「${target!.name}」，可以扫描。`);
}
async function scan() {
  resetScan("正在扫描...");
  scanInvalidated = false;
  if (!target) throw new Error("请先选择具体画布。");
  const selected = { ...target }, version = generation;
  setStatus("正在读取节点、连线分页及资源引用...");
  await ensureConnection();
  const tabId = selected.tabId, id = selected.canvasId;
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
  await checkSource(tabId, id);
  if (scanInvalidated || version !== generation) throw new Error("扫描期间来源已改变，请重新扫描。");
  const refs = nodes.items.flatMap(node => discoverAssetReferences(id, String(record(node).id), record(node).data));
  const indexed = indexReferences(refs);
  snapshot = { sourceTabId: tabId, canvasId: id, canvasName: String(record(record(canvasPayload).data).canvas?.name || selected.name), canvas: record(record(canvasPayload).data).canvas || canvasPayload, nodes: nodes.items, connections: connections.items, ...indexed, diagnostics: { nodes: nodes.diagnostic, connections: connections.diagnostic } };
  updateName(snapshot.canvasName);
  $("scan-summary").textContent = `已扫描「${snapshot.canvasName}」 · ${nodes.items.length} 节点 · ${connections.items.length} 连线 · ${indexed.assets.length} 资源目标`;
  $("graph").textContent = `${nodes.items.length} / ${connections.items.length}`;
  $("assets").textContent = `${refs.length} / ${indexed.assets.length}`;
  $<HTMLButtonElement>("backup").disabled = !directory;
  setStatus(directory ? "扫描完成，可以开始备份。" : "扫描完成，请选择保存目录。");
}
async function backup() {
  if (!directory || !snapshot) throw new Error("先选择目录并扫描画布");
  if (!target || snapshot.canvasId !== target.canvasId || snapshot.sourceTabId !== target.tabId) throw new Error("选择与扫描结果不一致，请重新扫描。");
  await checkSource(target.tabId, target.canvasId);
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
$("choose").onclick = async () => { try { directory = await (window as any).showDirectoryPicker({ mode: "readwrite", id: "tapnow-backup" }); $("directory").textContent = directory.name; destination(); $<HTMLButtonElement>("backup").disabled = !snapshot || running; setStatus(snapshot ? `保存目录已确认，可以备份「${snapshot.canvasName}」。` : `已选择目录：${directory.name}`); } catch (e) { setStatus(String(e)); } };
$("canvas").onchange = async () => {
  setBusy(true);
  try { await selectTarget(Number($<HTMLSelectElement>("canvas").value)); $("origin").textContent = "范围：你手动选择的单画布"; }
  catch (error) { setStatus(String(error)); }
  finally { setBusy(false); }
};
$("refresh-tabs").onclick = async () => { setBusy(true); try { await refreshCanvasList(); } catch (e) { setStatus(String(e)); } finally { setBusy(false); } };
$("source").onclick = async () => {
  if (!target) return;
  try { const tab = await checkSource(target.tabId, target.canvasId); await browser.tabs.update(tab.id!, { active: true }); await browser.windows.update(tab.windowId, { focused: true }); }
  catch (error) { setStatus(String(error)); }
};
$("connect").onclick = async () => { setBusy(true); try { await connect(); } catch (e) { setStatus(String(e)); } finally { setBusy(false); } };
$("scan").onclick = async () => { setBusy(true); try { await scan(); } catch (e) { resetScan("扫描未完成"); setStatus(String(e)); } finally { setBusy(false); } };
$("backup").onclick = async () => {
  if (running) return;
  downloading = true;
  setBusy(true);
  try {
    await navigator.locks.request("tapnow-backup-writer", { ifAvailable: true }, async lock => {
      if (!lock) throw new Error("另一个备份页正在运行");
      await backup();
    });
  } catch (e) { controller?.abort(); setStatus(`备份未完成：${String(e)}。已完成文件保留，可增量补齐。`); }
  finally { downloading = false; setBusy(false); }
};
$("pause").onclick = () => controller?.abort();
function invalidateSource(tabId: number, url?: string, closed = false) {
  if (target?.tabId !== tabId || !closed && canvasIdFromUrl(url) === target.canvasId) return;
  if (downloading) return; // Downloads use an immutable saved snapshot, not the live page.
  generation++; scanInvalidated = true;
  resetScan("原页面已关闭或切换，请重新选择并扫描");
  target = null;
  $("target-name").textContent = "来源画布已失效";
  $("target-id").textContent = "";
  document.title = "来源已失效 · TapNow 备份中心";
  $<HTMLSelectElement>("canvas").value = "";
  $("connection").textContent = "来源已失效";
  destination();
  setStatus("来源画布已改变，已清空旧扫描结果；未自动选择其他画布。");
  setBusy(running);
}
browser.tabs.onUpdated.addListener((tabId, change) => { if (change.url) invalidateSource(tabId, change.url); });
browser.tabs.onRemoved.addListener(tabId => invalidateSource(tabId, undefined, true));
setBusy(true);
void refreshCanvasList(true).catch(e => setStatus(String(e))).finally(() => setBusy(false));
window.addEventListener("beforeunload", event => { if (running) { event.preventDefault(); event.returnValue = ""; } });
