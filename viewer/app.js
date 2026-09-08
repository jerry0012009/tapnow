const $ = (selector) => document.querySelector(selector);
const state = { report: null, view: "assets", offset: 0, query: "" };
const fmt = (n) => Number(n || 0).toLocaleString("zh-CN");
const bytes = (n) => { const units = ["B", "KB", "MB", "GB", "TB"]; let i = 0; let v = Number(n || 0); while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; } return `${v.toFixed(i ? 2 : 0)} ${units[i]}`; };
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]));
async function get(url) { const response = await fetch(url); const data = await response.json(); if (!response.ok) throw new Error(data.error || response.statusText); return data; }
function renderReport(report) {
  state.report = report;
  const verified = report.verifiedCount || 0, failed = report.failedCount || 0, total = report.uniqueAssetCount || 0;
  $("#subtitle").textContent = `${report.canvasName || report.canvasId} · 完成于 ${new Date(report.finishedAt).toLocaleString("zh-CN")}`;
  $("#metrics").innerHTML = [
    ["节点", fmt(report.nodeCount)], ["连线", fmt(report.connectionCount)], ["资源引用", fmt(report.referenceCount)],
    ["唯一目标", fmt(total)], ["已验证保存", fmt(verified)], ["未下载", fmt(failed)], ["已保存字节", bytes(report.verifiedBytes)],
  ].map(([label, value]) => `<div class="metric"><span class="label">${label}</span><strong>${value}</strong></div>`).join("");
  const pct = total ? (verified / total * 100) : 0;
  $("#coverage-bar").style.width = `${pct}%`;
  $("#coverage-note").textContent = `${pct.toFixed(2)}%`;
  $("#coverage-text").textContent = `唯一下载目标 ${fmt(total)} 个，已保存并通过字节数与 SHA-256 校验 ${fmt(verified)} 个，仍不可得 ${fmt(failed)} 个。引用数大于目标数是因为同一文件被多个节点或字段引用。`;
}
const columns = {
  assets: [["状态", x => `<span class="pill ${x.status === "verified" ? "ok" : "bad"}">${esc(x.status)}</span>`], ["文件", x => `<code>${esc(x.file || "未保存")}</code>`], ["大小", x => bytes(x.bytes)], ["fileId", x => `<code>${esc(x.fileId || "")}</code>`], ["原因", x => esc(x.reason || "")]],
  references: [["资源", x => esc(x.assetId || "")], ["节点", x => `<code>${esc(x.nodeId)}</code>`], ["字段", x => `<code>${esc(x.fieldPath)}</code>`], ["角色", x => esc(x.role || "")], ["URL / fileId", x => `<code>${esc(x.url || x.fileId || "")}</code>`]],
  nodes: [["ID", x => `<code>${esc(x.id)}</code>`], ["类型", x => esc(x.type || x.data?.type || "")], ["名称", x => esc(x.name || x.data?.name || "")], ["数据", x => `<details><summary>查看 JSON</summary><pre>${esc(JSON.stringify(x, null, 2))}</pre></details>`]],
  connections: [["ID", x => `<code>${esc(x.id)}</code>`], ["来源", x => `<code>${esc(x.source || x.source_node_id || x.from_node_id || "")}</code>`], ["目标", x => `<code>${esc(x.target || x.target_node_id || x.to_node_id || "")}</code>`], ["数据", x => `<details><summary>查看 JSON</summary><pre>${esc(JSON.stringify(x, null, 2))}</pre></details>`]],
};
async function renderList() {
  if (state.view === "audit") return renderAudit();
  const search = `<div class="toolbar"><input id="query" value="${esc(state.query)}" placeholder="搜索当前列表"><button id="search">搜索</button></div>`;
  const data = await get(`/api/${state.view}?offset=${state.offset}&limit=100&q=${encodeURIComponent(state.query)}`);
  const defs = columns[state.view];
  const head = defs.map(([label]) => `<th>${label}</th>`).join("");
  const rows = data.items.map(item => `<tr>${defs.map(([, render]) => `<td>${render(item)}</td>`).join("")}</tr>`).join("");
  $("#panel").innerHTML = search + (rows ? `<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></div>` : `<p class="empty">没有匹配记录。</p>`) +
    `<div class="toolbar"><button id="prev" ${state.offset ? "" : "disabled"}>上一页</button><button id="next" ${data.hasMore ? "" : "disabled"}>下一页</button><span>当前 ${state.offset + 1}-${state.offset + data.returned}</span></div>`;
  $("#search").onclick = () => { state.query = $("#query").value; state.offset = 0; renderList(); };
  $("#prev").onclick = () => { state.offset = Math.max(0, state.offset - 100); renderList(); };
  $("#next").onclick = () => { state.offset += 100; renderList(); };
}
function renderAudit() {
  const r = state.report;
  $("#panel").innerHTML = `<h2>本次验收边界</h2>
  <details open><summary>本次确实使用了插件吗？</summary><p>登录态、页面内“备份”入口、扩展内容脚本和后台媒体请求已在真实 Chromium 中验证；但本次 16.09 GB 大画布全量保存由同一登录会话的真实执行器完成，尚未证明扩展备份页的 File System Access 目录写入可以承载同等规模。因此不能把本次全量结果表述为“全部由插件 UI 写入”。</p></details>
  <details open><summary>未下载的 ${fmt(r.failedCount)} 个是什么？</summary><p>均为 file-ID 派生地址在有限重试和反查后持续 HTTP 404 的对象，状态已记录为 unavailable-after-recovery；任务没有因此中断，后续增量备份可以再次复查。</p></details>
  <details open><summary>是否与网页内容完全相等、是否遗漏？</summary><p>对本次单画布，节点、连线和资源引用的 API 分页已完整收集，页数与游标没有发现重复或中断；已发现 5,776 条引用、2,489 个唯一目标。不能声称整个工作区无遗漏，因为本次没有枚举并测试整个工作区，也不能证明服务端未暴露的历史对象仍可见。</p></details>
  <details><summary>报告原始 JSON</summary><pre>${esc(JSON.stringify(r, null, 2))}</pre></details>`;
}
async function load() { try { renderReport(await get("/api/report")); await renderList(); } catch (e) { $("#panel").innerHTML = `<p class="empty">${esc(e.message)}</p>`; } }
document.querySelectorAll(".tab").forEach((tab) => tab.onclick = () => { document.querySelectorAll(".tab").forEach(x => x.classList.remove("active")); tab.classList.add("active"); state.view = tab.dataset.view; state.offset = 0; state.query = ""; renderList(); });
$("#refresh").onclick = load;
load();
