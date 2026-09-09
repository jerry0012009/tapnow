const escape = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const format = n => Number(n || 0).toLocaleString("zh-CN");
const size = n => `${(Number(n || 0) / 1024 ** 2).toFixed(2)} MiB`;
const labels = { verified: "已验证", partial: "部分缺失", missing: "未保存", pending: "待处理", text: "文本 / 分组", queued: "待处理", retryable: "下载失败", "unavailable-after-recovery": "恢复后仍不可得" };
const kinds = { image: "图片", text: "文字", video: "视频", audio: "音频", file: "附件", document: "文档", group: "分组" };
function nodeLabel(n) {
  const isText = n.text || n.type === "text";
  const clip = (value, length) => value.length > length ? `${value.slice(0, length)}…` : value;
  const title = clip(n.title, isText ? 20 : 38);
  const body = n.type === "group" ? "分组" : isText
    ? clip(n.text || n.prompt || "无文字", n.height < 120 ? 20 : 40)
    : n.assetCount ? n.savedCount > n.verifiedCount ? `${n.savedCount} 本地资源 · 待复核` : `${n.verifiedCount}/${n.assetCount} 已验证` : `${kinds[n.type] || n.type} · 节点属性`;
  return `${n.shortId || kinds[n.type] || n.type} · ${title}\n${body}`;
}
const icon = (name, title, id) => `<button class="icon-button" id="${id}" title="${title}" aria-label="${title}"><i data-lucide="${name}"></i></button>`;
const icons = () => window.lucide.createIcons({ attrs: { width: 18, height: 18, "stroke-width": 1.8 } });

export async function mountGraph(panel, signal, initialId) {
  const lifecycle = new AbortController();
  signal?.addEventListener("abort", () => lifecycle.abort(), { once: true });
  let cy, selected, detailVersion = 0, mode = "original", detail;
  let releaseMedia = () => {};
  const $ = id => panel.querySelector(`#${id}`);
  panel.innerHTML = `
  <div class="graph-toolbar">
    <div class="segmented" aria-label="画布视图">
      <label title="按备份原始位置展示全部节点"><input type="radio" name="graph-mode" value="original" checked>全部节点</label>
      <label><input type="radio" name="graph-mode" value="context">当前关系</label>
    </div>
    <div class="graph-search"><i data-lucide="search"></i><input id="node-search" aria-label="搜索节点" placeholder="搜索标题、提示词、节点 ID"></div>
    <select id="node-picker" aria-label="节点搜索结果"></select>
    <div class="graph-tools">${icon("minus", "缩小", "zoom-out")}<output id="zoom">100%</output>${icon("plus", "放大", "zoom-in")}${icon("scan", "适配当前视图", "fit")}${icon("focus", "定位选中节点", "focus")}${icon("maximize", "展开画布", "expand")}</div>
  </div>
  <div class="graph-workspace">
    <div class="graph-area"><div id="graph" role="img" aria-label="节点与方向连线画布"></div>
      <div class="graph-legend"><span class="dot green"></span>已验证<span class="dot amber"></span>存在缺失<span class="dot blue"></span>文本<span class="dot gray"></span>待处理<span class="legend-caption">箭头：上游 → 下游</span></div>
      <div id="graph-loading" role="status">正在读取画布...</div>
      <div class="graph-bottom" id="graph-count"></div>
    </div>
    <aside id="inspector" aria-label="节点详情"><div class="empty">正在读取节点...</div></aside>
  </div>`;
  icons();
  const data = await get("/api/graph", lifecycle.signal);
  if (!panel.isConnected || lifecycle.signal.aborted) return () => {};
  const nodes = new Map(data.nodes.map(n => [n.id, n]));
  const nodeData = data.nodes.map(n => ({
    data: { id: n.id, label: nodeLabel(n),
      mediaLabel: `${n.shortId || n.type} · 本地原图`,
      width: n.type === "group" ? n.width : Math.min(n.width, 360),
      height: n.type === "group" ? n.height : Math.min(n.height, 180), status: n.status,
      kind: n.type, group: n.type === "group" ? 1 : 0 },
    position: { x: n.position.x + n.width / 2, y: n.position.y + n.height / 2 }
  }));
  // Cytoscape mutates element positions during layout; keep the snapshot independent.
  const positions = new Map(nodeData.map(n => [n.data.id, { ...n.position }]));
  const validEdges = data.connections.filter(c => nodes.has(c.source) && nodes.has(c.target));
  cy = window.cytoscape({
    container: $("graph"), elements: [...nodeData, ...validEdges.map((c, i) => ({ data: { id: `edge-${i}`, source: c.source, target: c.target } }))],
    layout: { name: "preset", fit: false }, minZoom: .005, maxZoom: 2.5,
    autoungrabify: true, boxSelectionEnabled: false, textureOnViewport: true,
    style: [
      { selector: "node", style: {
        shape: "round-rectangle", width: "data(width)", height: "data(height)", label: "data(label)",
        "text-wrap": "wrap", "text-overflow-wrap": "anywhere", "text-max-width": 260, "text-valign": "center", "text-halign": "center",
        "font-family": "system-ui", "font-size": 18, color: "#263d3b", "background-color": "#edf8f1",
        "border-width": 2, "border-color": "#64a58c", "min-zoomed-font-size": 7,
        "background-fit": "contain", "background-opacity": 1, "text-background-color": "#ffffff",
        "text-background-opacity": .85, "text-background-padding": 5, "z-index": 2
      }},
      { selector: 'node[status = "text"]', style: { "background-color": "#edf2fa", "border-color": "#7194c0" } },
      { selector: 'node[status = "partial"],node[status = "missing"]', style: { "background-color": "#fff4dc", "border-color": "#c0933e" } },
      { selector: 'node[status = "pending"]', style: { "background-color": "#f2f4f4", "border-color": "#a4b0b2" } },
      { selector: 'node[group = 1]', style: { shape: "rectangle", "background-color": "#e1e6e8", "background-opacity": .2, "border-style": "dashed", "border-color": "#c4cdd1", "border-width": 2, "text-valign": "top", "text-background-opacity": 0, "z-index": 0 } },
      { selector: "edge", style: { width: 2.5, "curve-style": "bezier", "target-arrow-shape": "triangle", "target-arrow-color": "#779295", "line-color": "#a4b9ba", "arrow-scale": 1.3, opacity: .85, "z-index": 1 } },
      { selector: "edge.connected", style: { width: 3.5, "line-color": "#267c77", "target-arrow-color": "#267c77", opacity: 1 } },
      { selector: "node:selected", style: { "border-color": "#196a65", "border-width": 4, "overlay-opacity": 0, "z-index": 10 } },
      { selector: "node.with-media", style: { label: "data(mediaLabel)", "text-valign": "bottom", "text-margin-y": -26 } },
      { selector: "node.overview[group = 0]", style: { "background-color": "#238b70", "border-width": 0 } },
      { selector: 'node.overview[status = "text"]', style: { "background-color": "#527cad" } },
      { selector: 'node.overview[status = "partial"],node.overview[status = "missing"]', style: { "background-color": "#c28b28" } },
      { selector: 'node.overview[status = "pending"]', style: { "background-color": "#8e9ca0" } },
      { selector: "node.overview[group = 1]", style: { "background-opacity": .08, "border-width": 15 } },
      { selector: "edge.overview", style: { width: 18, opacity: .25, "target-arrow-shape": "none" } },
      { selector: ".out-of-scope", style: { display: "none" } }
    ]
  });
  $("graph-loading").remove();
  let overview = false;
  const zoomChanged = () => {
    $("zoom").textContent = `${Math.round(cy.zoom() * 100)}%`;
    const next = cy.zoom() < .15;
    if (next !== overview) { overview = next; cy.elements().toggleClass("overview", next); }
  };
  cy.on("zoom", zoomChanged);
  const resize = new ResizeObserver(() => cy && !cy.destroyed() && cy.resize());
  resize.observe($("graph"));
  function focus() { if (selected) { cy.zoom(.8); cy.center(cy.getElementById(selected)); } }
  function fit() {
    const visible = cy.elements().filter(e => !e.hasClass("out-of-scope"));
    cy.fit(visible, 60);
    if (cy.zoom() > 1) { cy.zoom(1); cy.center(visible); }
  }
  function scope() {
    cy.batch(() => {
      cy.elements().removeClass("out-of-scope");
      if (mode === "context" && selected) {
        const node = cy.getElementById(selected), neighborhood = node.closedNeighborhood();
        cy.elements().difference(neighborhood).addClass("out-of-scope");
        const mobile = cy.width() < 500;
        neighborhood.nodes().style({ width: mobile ? 230 : 250, height: mobile ? 110 : 140, "font-size": 17, "text-max-width": 210 });
        if (mobile) {
          const ordered = neighborhood.nodes().sort((a, b) => {
            const rank = n => n.id() === selected ? 1 : n.edgesTo(node).length ? 0 : 2;
            return rank(a) - rank(b);
          });
          ordered.layout({ name: "grid", cols: 1, fit: false, spacingFactor: 1.3, avoidOverlap: true }).run();
        } else neighborhood.layout({ name: "breadthfirst", directed: true, fit: false, spacingFactor: 1.1, avoidOverlap: true, circle: false, animate: false }).run();
      } else {
        cy.nodes().removeStyle("width height font-size text-max-width");
        cy.nodes().positions(n => ({ ...positions.get(n.id()) }));
      }
      cy.edges().removeClass("connected");
      if (selected) cy.getElementById(selected).connectedEdges().addClass("connected");
    });
    const visible = cy.nodes().filter(n => !n.hasClass("out-of-scope"));
    const edges = cy.edges().filter(n => !n.hasClass("out-of-scope"));
    $("graph-count").textContent = `${mode === "context" ? "当前关系" : "全部节点（原始位置）"} ${format(visible.length)} 节点 · ${format(edges.length)} 连线 / 总计 ${format(data.counts.nodes)} 节点 · ${format(data.counts.connections)} 连线${data.counts.danglingConnections ? ` · ${data.counts.danglingConnections} 条悬空连线` : ""}${data.diagnostics.length ? ` · ${data.diagnostics.length} 项坐标警告` : ""}`;
    if (mode === "context") fit(); else focus();
  }
  function filterNodes() {
    const needle = $("node-search").value.trim().toLowerCase();
    const filtered = data.nodes.filter(n => [n.title, n.shortId, n.id, n.prompt, n.text].join(" ").toLowerCase().includes(needle));
    $("node-picker").replaceChildren(...filtered.slice(0, 100).map(n => {
      const option = document.createElement("option"); option.value = n.id; option.textContent = `${n.shortId || n.type} · ${n.title}`;
      return option;
    }));
    if (filtered.some(n => n.id === selected)) $("node-picker").value = selected;
    $("node-picker").disabled = !filtered.length;
  }
  async function selectNode(id, recenter = true, preview = false) {
    if (!nodes.has(id)) return;
    releaseMedia(); releaseMedia = () => {};
    const version = ++detailVersion;
    selected = id;
    filterNodes();
    cy.nodes().unselect(); cy.getElementById(id).select();
    if (recenter || mode === "context") scope();
    $("inspector").innerHTML = `<div class="empty">读取节点属性...</div>`;
    try {
      const result = await get(`/api/node/${encodeURIComponent(id)}`, lifecycle.signal);
      if (version !== detailVersion) return;
      detail = result; renderDetail();
      if (preview) {
        let index = detail.assets.findIndex(item => item.asset?.canPreview && item.references.some(r => r.role === "当前"));
        if (index < 0) index = detail.assets.findIndex(item => item.asset?.canPreview);
        if (index >= 0) loadAsset(index);
        else if (detail.assets.length) $("preview").lastElementChild.textContent = "尚无已保存文件，详见下方状态与原因";
      }
    } catch (error) {
      if (version === detailVersion && !lifecycle.signal.aborted) $("inspector").innerHTML = `<p class="error">${escape(error.message)}</p>`;
    }
  }
  function renderDetail() {
    const n = detail.node, summary = nodes.get(n.id);
    const links = (items, direction) => items.map(c => {
      const target = direction === "in" ? c.source : c.target, other = nodes.get(target);
      return `<button class="relation-link" data-jump="${escape(target)}">${direction === "in" ? "←" : "→"} ${escape(other?.shortId || target)} · ${escape(other?.title || "端点缺失")}</button>`;
    }).join("") || '<p class="muted">无</p>';
    const fieldTable = obj => Object.entries(obj || {}).map(([key, value]) => `<dt>${escape(key)}</dt><dd>${escape(typeof value === "object" ? JSON.stringify(value) : value)}</dd>`).join("");
    $("inspector").innerHTML = `
      <div class="inspector-heading"><span class="node-badge">${escape(n.short_id || n.type)} · ${escape(kinds[n.type] || n.type)}</span><span class="status ${summary.status}">${summary.status === "text" ? "节点已保存" : labels[summary.status]}</span><h2>${escape(n.data?.title || summary.title)}</h2><code>${escape(n.id)}</code></div>
      <div class="inspector-section"><div class="section-title"><h3>本地资源</h3><span>${detail.assets.length} 目标 · ${detail.referenceCount} 引用</span></div>
      <div id="preview" class="media-preview"><i data-lucide="${n.type === "image" ? "image" : n.type === "video" ? "film" : n.type === "audio" ? "music" : "file-text"}"></i><span>${detail.assets.length ? `${detail.assets.length} 个资源目标 · 尚未预览` : `${escape(kinds[n.type] || n.type)} · 无媒体引用`}</span></div>
      <div id="asset-list">${detail.assets.map(({ asset, references }, i) => `<div class="asset-row">
        <button class="asset-load" data-asset="${i}" ${asset?.canPreview ? "" : "disabled"}>
          <i data-lucide="${asset?.canPreview ? "image" : "file-warning"}"></i>
          <span>${[...new Set(references.map(r => r.role))].map(escape).join(" · ")}<small>${escape(asset?.status === "queued" && asset?.canPreview ? "已保存 · 待复核" : labels[asset?.status] || "未解析")} ${asset?.bytes ? ` · ${size(asset.bytes)}` : ""}</small></span>
        </button>
        <details><summary>文件与引用</summary><code>${escape(asset?.file || asset?.reason || "未保存")}</code><dl class="property-list"><dt>SHA-256</dt><dd>${escape(asset?.sha256 || "无")}</dd><dt>资源 ID</dt><dd>${escape(asset?.assetId || asset?.referenceId || "")}</dd><dt>状态</dt><dd>${escape(asset?.status || "未解析")}</dd></dl>${references.map(r => `<code class="field-path">${escape(r.fieldPath)}</code>`).join("")}</details>
      </div>`).join("")}</div></div>
      <div class="inspector-section"><h3>提示词</h3><p class="prompt">${escape(n.data?.prompt || "无提示词")}</p></div>
      ${n.data?.text ? `<div class="inspector-section"><h3>文本产物</h3><p class="prompt">${escape(n.data.text)}</p></div>` : ""}
      <div class="inspector-section"><h3>生成参数</h3><dl class="property-list">${fieldTable(n.data?.params)}</dl>${!n.data?.params ? '<p class="muted">无</p>' : ""}</div>
      <div class="inspector-section"><h3>上游 ${detail.incoming.length}</h3>${links(detail.incoming, "in")}<h3>下游 ${detail.outgoing.length}</h3>${links(detail.outgoing, "out")}</div>
      <div class="inspector-section"><details><summary>位置与节点属性</summary><dl class="property-list">${fieldTable({ type: n.type, parent_id: n.parent_id, position: n.position, absolutePosition: detail.absolutePosition, dimensions: n.measured, created_at: n.created_at, updated_at: n.updated_at })}</dl></details>
      <details><summary>完整节点 JSON</summary><pre>${escape(JSON.stringify(n, null, 2))}</pre></details>
      <details><summary>完整连线 JSON</summary><pre>${escape(JSON.stringify([...detail.incoming, ...detail.outgoing], null, 2))}</pre></details>
      ${data.counts.danglingConnections ? `<details><summary>快照中端点缺失：${data.counts.danglingConnections} 条连线</summary><p class="muted">连线数据已保留，端点不在节点快照中；未推测其位置。</p><pre>${escape(JSON.stringify(data.connections.filter(c => !nodes.has(c.source) || !nodes.has(c.target)), null, 2))}</pre></details>` : ""}</div>`;
    icons();
    $("inspector").querySelectorAll("[data-jump]").forEach(button => button.onclick = () => selectNode(button.dataset.jump, true, true));
    $("inspector").querySelectorAll("[data-asset]").forEach(button => button.onclick = () => loadAsset(Number(button.dataset.asset)));
    $("inspector").scrollTop = 0;
  }
  async function loadAsset(index) {
    const asset = detail.assets[index]?.asset;
    if (!asset?.canPreview) return;
    const id = selected, token = ++detailVersion;
    releaseMedia(); releaseMedia = () => {};
    $("preview").replaceChildren();
    const note = document.createElement("span"); note.textContent = "正在读取本地原文件..."; $("preview").append(note);
    let resource;
    try { resource = await mediaSource(asset); }
    catch (error) { if (token === detailVersion && !lifecycle.signal.aborted) note.textContent = `本地文件无法读取：${error.message}`; return; }
    if (token !== detailVersion || lifecycle.signal.aborted) { resource.release(); return; }
    releaseMedia = resource.release;
    const src = resource.url;
    const isImage = /^image\/(png|jpeg|webp|gif|avif)(;|$)/.test(asset.contentType || "");
    const isVideo = /^video\/(mp4|webm)(;|$)/.test(asset.contentType || "");
    const isAudio = /^audio\//.test(asset.contentType || "");
    if (isImage || isVideo || isAudio) {
      const media = document.createElement(isImage ? "img" : isVideo ? "video" : "audio");
      if (isImage) media.alt = nodes.get(id)?.title || "本地原图";
      else { media.controls = true; media.preload = "metadata"; }
      media.onload = media.onloadedmetadata = () => {
        if (token !== detailVersion || selected !== id) return;
        note.textContent = `本地原文件 · ${size(asset.bytes)}`;
        if (isImage) {
          const thumbnail = document.createElement("canvas");
          thumbnail.width = Math.min(640, media.naturalWidth);
          thumbnail.height = Math.max(1, Math.round(media.naturalHeight * thumbnail.width / media.naturalWidth));
          thumbnail.getContext("2d").drawImage(media, 0, 0, thumbnail.width, thumbnail.height);
          cy.getElementById(id).addClass("with-media").style("background-image", thumbnail.toDataURL("image/webp", .85));
        }
      };
      media.onerror = () => { if (token === detailVersion) note.textContent = "本地文件读取或解码失败，查看下载状态"; };
      media.src = src; $("preview").prepend(media);
    } else note.textContent = "此格式不内嵌预览，可下载本地原文件";
    const link = document.createElement("a");
    link.href = resource.downloadUrl; link.download = asset.file?.split("/").pop() || asset.sha256 || "asset";
    link.textContent = "下载本地原文件"; link.className = "download-link";
    $("preview").append(link);
  }
  cy.on("tap", "node", event => selectNode(event.target.id(), false, true));
  $("node-search").oninput = filterNodes;
  $("node-search").onkeydown = event => { if (event.key === "Enter" && $("node-picker").value) selectNode($("node-picker").value, true, true); };
  $("node-picker").onchange = () => selectNode($("node-picker").value, true, true);
  panel.querySelectorAll('[name="graph-mode"]').forEach(input => input.onchange = () => { mode = input.value; scope(); if (mode === "original") fit(); });
  $("zoom-in").onclick = () => cy.zoom({ level: Math.min(cy.maxZoom(), cy.zoom() * 1.3), renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 } });
  $("zoom-out").onclick = () => cy.zoom({ level: Math.max(cy.minZoom(), cy.zoom() / 1.3), renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 } });
  $("fit").onclick = fit; $("focus").onclick = focus;
  $("expand").onclick = () => { panel.classList.toggle("expanded"); cy.resize(); };
  filterNodes();
  const initial = nodes.get(initialId) || data.nodes.find(n => n.type === "image" && n.prompt && n.verifiedCount &&
    validEdges.filter(e => e.target === n.id || e.source === n.id).length >= 2 &&
    validEdges.filter(e => e.target === n.id || e.source === n.id).length <= 4)
    || data.nodes.find(n => n.type === "image" && n.prompt && n.verifiedCount && validEdges.some(e => e.target === n.id))
    || data.nodes.find(n => n.type !== "group") || data.nodes[0];
  if (initial) { await selectNode(initial.id); filterNodes(); fit(); }
  zoomChanged();
  return () => { lifecycle.abort(); detailVersion++; releaseMedia(); resize.disconnect(); cy.destroy(); };
}
import { get, mediaSource } from "./data.js";
