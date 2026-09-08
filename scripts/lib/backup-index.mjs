export const normalizeAsset = item => ({
  ...item,
  canPreview: Boolean(item.file && (item.status === "verified" ||
    item.status === "queued" && /^[a-f0-9]{64}$/.test(item.sha256 || "") && item.bytes > 0)),
  status: item.status === "retryable" && /HTTP (404|410)\b/.test(item.reason || "")
    ? "unavailable-after-recovery" : item.status
});
export function referenceRole(path = "") {
  if (/history|queue|variant/i.test(path)) return "历史";
  if (/option|alternative|candidate/i.test(path)) return "备选";
  if (/preview|thumbnail|cover/i.test(path)) return "预览";
  if (path === "data.src" || /currentSourceFileId/.test(path)) return "当前";
  return "其他";
}
export function buildBackupIndex(nodes, connections, references, rawAssets) {
  const byId = new Map(nodes.map(node => [node.id, node]));
  const assets = rawAssets.map(normalizeAsset);
  const byAsset = new Map(assets.map(a => [a.assetId || a.referenceId, a]));
  const refsByNode = new Map(), coordinates = new Map(), diagnostics = [];
  const visiting = new Set();
  function position(node) {
    if (coordinates.has(node.id)) return coordinates.get(node.id);
    if (visiting.has(node.id)) { diagnostics.push({ type: "parent-cycle", nodeId: node.id }); return { x: 0, y: 0 }; }
    visiting.add(node.id);
    const rawX = Number(node.position?.x), rawY = Number(node.position?.y);
    if (!Number.isFinite(rawX) || !Number.isFinite(rawY)) diagnostics.push({ type: "missing-position", nodeId: node.id });
    const own = { x: Number.isFinite(rawX) ? rawX : 0, y: Number.isFinite(rawY) ? rawY : 0 };
    if (node.parent_id) {
      const parent = byId.get(node.parent_id);
      if (parent) { const base = position(parent); own.x += base.x; own.y += base.y; }
      else diagnostics.push({ type: "missing-parent", nodeId: node.id, parentId: node.parent_id });
    }
    visiting.delete(node.id); coordinates.set(node.id, own); return own;
  }
  let unresolved = 0;
  for (const ref of references) {
    const asset = byAsset.get(ref.assetId);
    if (!asset) unresolved++;
    const item = { ...ref, roleLabel: referenceRole(ref.fieldPath), asset: asset || null };
    const list = refsByNode.get(ref.nodeId) || []; list.push(item); refsByNode.set(ref.nodeId, list);
  }
  const summaries = nodes.map(node => {
    const refs = refsByNode.get(node.id) || [];
    const targets = [...new Set(refs.map(r => r.assetId).filter(Boolean))];
    const verified = targets.filter(id => byAsset.get(id)?.status === "verified").length;
    const saved = targets.filter(id => byAsset.get(id)?.canPreview).length;
    const failed = targets.filter(id => byAsset.has(id) && !["queued", "verified"].includes(byAsset.get(id).status)).length;
    return {
      id: node.id, shortId: node.short_id || "", title: String(node.data?.title || node.data?.name || node.type || node.id),
      type: node.type || "unknown", parentId: node.parent_id || null, position: position(node),
      width: Math.max(100, Number(node.measured?.width || node.dimensions?.width) || 300),
      height: Math.max(70, Number(node.measured?.height || node.dimensions?.height) || 200),
      prompt: String(node.data?.prompt || ""),
      text: typeof node.data?.text === "string" ? node.data.text : "",
      referenceCount: refs.length, assetCount: targets.length, verifiedCount: verified, savedCount: saved, failedCount: failed,
      status: !targets.length ? "text" : failed ? (verified ? "partial" : "missing") : verified === targets.length ? "verified" : "pending"
    };
  });
  const dangling = connections.filter(c => !byId.has(c.source) || !byId.has(c.target));
  return {
    graph: {
      nodes: summaries, connections,
      counts: { nodes: nodes.length, connections: connections.length, references: references.length, assets: assets.length,
        nodesWithReferences: refsByNode.size, danglingConnections: dangling.length, unresolvedReferences: unresolved,
        nodeTypes: nodes.reduce((counts, node) => { const type = node.type || "unknown"; counts[type] = (counts[type] || 0) + 1; return counts; }, {}) },
      diagnostics
    },
    byAsset,
    nodeDetail(id) {
      const node = byId.get(id);
      if (!node) return null;
      const refs = refsByNode.get(id) || [];
      const grouped = new Map();
      for (const ref of refs) {
        const key = ref.assetId || ref.referenceId;
        if (!grouped.has(key)) grouped.set(key, { asset: ref.asset, references: [] });
        grouped.get(key).references.push({ referenceId: ref.referenceId, fieldPath: ref.fieldPath, role: ref.roleLabel });
      }
      return {
        node, absolutePosition: coordinates.get(id), assets: [...grouped.values()], referenceCount: refs.length,
        incoming: connections.filter(c => c.target === id), outgoing: connections.filter(c => c.source === id)
      };
    }
  };
}
