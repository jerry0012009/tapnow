import { mountGraph } from "./graph.js";
import { get } from "./data.js";
const $ = selector => document.querySelector(selector);
const state = { report: null, view: location.hash === "#assets" ? "assets" : "graph", offset: 0, query: "" };
const fmt = n => Number(n || 0).toLocaleString("zh-CN");
const bytes = n => `${(Number(n || 0) / 1e9).toFixed(2)} GB`;
const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
let cleanup = null, request = null;
function renderReport(report) {
  state.report = report;
  const verified = report.verifiedCount || 0, total = report.uniqueAssetCount || 0;
  $("#subtitle").textContent = report.canvasName || report.canvasId || "本地备份";
  $("#producer").textContent = report.producer === "chrome-extension" ? (report.verification?.passed ? "插件产物 · 已独立复核" : "Chrome 插件产物")
    : report.producer === "test-fixture" ? "模拟测试数据" : "早期执行器产物";
  $("#metrics").innerHTML = [
    ["节点", fmt(report.nodeCount)], ["连线", fmt(report.connectionCount)], ["引用", fmt(report.referenceCount)],
    ["唯一目标", fmt(total)], ["清单已验证", fmt(verified)], ["未完成", fmt(total - verified)], ["目标字节合计", bytes(report.verifiedBytes)]
  ].map(([label, value]) => `<div class="metric"><span>${label}</span><strong>${value}</strong></div>`).join("");
  const date = report.finishedAt || report.updatedAt;
  $("#coverage-note").textContent = `${total ? (verified / total * 100).toFixed(2) : 0}% · ${date ? new Date(date).toLocaleString("zh-CN") : "时间未记录"}`;
  $("#coverage-bar").style.width = `${total ? verified / total * 100 : 0}%`;
}
const columns = {
  assets: [["状态", x => esc(x.status)], ["本地文件 / SHA-256", x => `<code>${esc(x.file || x.reason || "未保存")}</code><details><summary>资产记录</summary><pre>${esc(JSON.stringify(x, null, 2))}</pre></details>`], ["字节", x => fmt(x.bytes)], ["节点", x => `<button class="link-button" data-node="${esc(x.nodeId)}">${esc(x.nodeId)}</button>`]],
  references: [["资源", x => `<code>${esc(x.assetId)}</code>`], ["节点", x => `<button class="link-button" data-node="${esc(x.nodeId)}">${esc(x.nodeId)}</button>`], ["字段", x => `<code>${esc(x.fieldPath)}</code>`]],
  nodes: [["节点", x => `<button class="link-button" data-node="${esc(x.id)}">${esc(x.short_id || x.id)}</button>`], ["名称 / 类型", x => `${esc(x.data?.title || x.name || "")} · ${esc(x.type)}`], ["数据", x => `<details><summary>完整 JSON</summary><pre>${esc(JSON.stringify(x, null, 2))}</pre></details>`]],
  connections: [["来源", x => `<code>${esc(x.source)}</code>`], ["目标", x => `<code>${esc(x.target)}</code>`], ["连线属性", x => `<details><summary>${esc(x.id)}</summary><pre>${esc(JSON.stringify(x, null, 2))}</pre></details>`]]
};
async function renderView(nodeId) {
  request?.abort(); cleanup?.(); cleanup = null;
  request = new AbortController(); const signal = request.signal;
  const panel = $("#panel"); panel.classList.toggle("graph-panel", state.view === "graph"); panel.classList.remove("expanded");
  document.querySelectorAll(".tab").forEach(tab => tab.classList.toggle("active", tab.dataset.view === state.view));
  try {
    if (state.view === "graph") { cleanup = await mountGraph(panel, signal, nodeId); return; }
    if (state.view === "audit") { renderAudit(); return; }
    panel.innerHTML = `<p class="empty">正在读取...</p>`;
    const data = await get(`/api/${state.view}?offset=${state.offset}&limit=100&q=${encodeURIComponent(state.query)}`, signal);
    if (signal.aborted) return;
    const defs = columns[state.view];
    panel.innerHTML = `<form id="list-search" class="toolbar"><input aria-label="搜索当前列表" id="query" value="${esc(state.query)}" placeholder="搜索当前列表"><button type="submit">搜索</button></form>
      <div class="table-wrap"><table><thead><tr>${defs.map(([title]) => `<th>${title}</th>`).join("")}</tr></thead><tbody>${data.items.map(row => `<tr>${defs.map(([, render]) => `<td>${render(row)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>
      <div class="toolbar pager"><button id="prev" ${state.offset ? "" : "disabled"}>上一页</button><span>${data.returned ? state.offset + 1 : 0}–${state.offset + data.returned}</span><button id="next" ${data.hasMore ? "" : "disabled"}>下一页</button></div>`;
    $("#list-search").onsubmit = event => { event.preventDefault(); state.query = $("#query").value; state.offset = 0; void renderView(); };
    $("#prev").onclick = () => { state.offset = Math.max(0, state.offset - 100); void renderView(); };
    $("#next").onclick = () => { state.offset += 100; void renderView(); };
    panel.querySelectorAll("[data-node]").forEach(button => button.onclick = () => { state.view = "graph"; void renderView(button.dataset.node); });
  } catch (error) { if (!signal.aborted) panel.innerHTML = `<p class="error">读取失败：${esc(error.message)}</p>`; }
}
function renderAudit() {
  const r = state.report, plugin = r.producer === "chrome-extension";
  const c = r.coverage || {};
  const list = value => Object.entries(value || {}).map(([key, count]) => `${esc(key)} ${fmt(count)}`).join(" · ") || "无记录";
  $("#panel").innerHTML = `<h2>备份证据与范围</h2>
    <dl class="property-list"><dt>产物来源</dt><dd>${plugin ? "Chrome 插件 / File System Access" : "早期真实登录会话执行器（非插件全量写入）"}</dd><dt>任务状态</dt><dd>${esc(r.status || "历史快照")}</dd><dt>范围</dt><dd>单画布</dd><dt>目标字节合计</dt><dd>${fmt(r.verifiedBytes)} 字节</dd><dt>去重物理文件</dt><dd>${fmt(r.physicalFileCount)} 个 · ${fmt(r.physicalBytes)} 字节</dd><dt>待处理</dt><dd>${fmt(r.pendingCount)}</dd><dt>失败</dt><dd>${fmt(r.failedCount)}</dd></dl>
    <div class="audit-grid"><div><h3>覆盖审计</h3><dl class="property-list"><dt>节点类型</dt><dd>${list(c.nodeTypeCounts)}</dd><dt>资源角色</dt><dd>${list(c.roleCounts)}</dd><dt>资源状态</dt><dd>${list(c.statusCounts)}</dd><dt>引用已关联清单</dt><dd>${fmt(c.referencesWithAsset)} / ${fmt(r.referenceCount)}</dd><dt>清单已有本地文件</dt><dd>${fmt(c.assetsWithFile)} / ${fmt(r.uniqueAssetCount)}</dd><dt>含原始 data 的节点</dt><dd>${fmt(c.nodesWithRawData)} / ${fmt(r.nodeCount)}</dd><dt>递归字段路径</dt><dd>${fmt(Object.keys(c.dataFieldCounts || {}).length)} 个；疑似隐藏/历史字段 ${fmt(c.hiddenFieldCount)}</dd></dl></div><div><h3>验收边界</h3><p>本页展示清单中发现的全部节点、连线、引用和资源目标，包括备选、历史、队列及隐藏字段；资源文件按需从本地目录读取。</p><p><strong>发现完整 ≠ 下载完整：</strong>没有文件的目标不会被图片占位冒充，失败原因保留在资产结果和节点详情中。云端不可得目标仍需后续增量补漏或人工确认。</p></div></div>
    ${r.verification ? `<p>独立磁盘复核：${r.verification.passed ? "通过" : "未通过"} · ${fmt(r.verification.verifiedUniqueFiles)} 个物理文件 · ${esc(r.verification.verifiedAt)}</p><details><summary>独立复核及基线对照</summary><pre>${esc(JSON.stringify(r.verification, null, 2))}</pre></details>` : ""}
    <p>“已验证”是备份清单记录的文件大小与 SHA-256 校验结果。预览只读取本地文件，不会访问 TapNow。引用数、唯一目标数和哈希去重后的物理文件数不是同一口径。</p>
    <p>节点与连线来自该画布的分页快照。没有完成整个工作区和网页各类历史来源的独立对照，不能据此宣称所有工作区零遗漏。</p>
    <details><summary>递归字段路径统计</summary><pre>${esc(JSON.stringify(c.dataFieldCounts || {}, null, 2))}</pre></details>
    <details><summary>完整报告 JSON</summary><pre>${esc(JSON.stringify(r, null, 2))}</pre></details>`;
}
export function clearViewer() {
  request?.abort(); cleanup?.(); cleanup = null;
  state.report = null;
  $("#metrics").replaceChildren(); $("#panel").replaceChildren();
  $("#coverage-note").textContent = ""; $("#coverage-bar").style.width = "0%";
  $("#producer").textContent = ""; $("#subtitle").textContent = "尚未打开本地备份";
}
export async function load() {
  try { renderReport(await get("/api/report")); await renderView(); }
  catch (error) { $("#panel").innerHTML = `<p class="error">${esc(error.message)}</p>`; }
}
document.querySelectorAll(".tab").forEach(tab => tab.onclick = () => {
  if (!state.report) return;
  state.view = tab.dataset.view; state.offset = 0; state.query = ""; history.replaceState(null, "", `#${state.view}`); void renderView();
});
$("#refresh").onclick = load;
if (!document.documentElement.hasAttribute("data-local-viewer")) void load();
