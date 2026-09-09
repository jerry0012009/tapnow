import cytoscape from "cytoscape";
import { createIcons, RefreshCw, FolderOpen, FolderCheck, ShieldCheck, Square, Download,
  Search, Minus, Plus, Scan, Focus, Maximize, Image, Film, Music, FileText, FileWarning } from "lucide";
import "../../viewer/style.css";
import "./style.css";
import { setDataSource } from "../../viewer/data.js";
import { discoverBackups, loadLocalBackup, verifyLocalBackup } from "../../viewer/local-source.js";
import { directoryHandle } from "../../utils/backup/handles";

(window as any).cytoscape = cytoscape;
const icons = { RefreshCw, FolderOpen, FolderCheck, ShieldCheck, Square, Download,
  Search, Minus, Plus, Scan, Focus, Maximize, Image, Film, Music, FileText, FileWarning };
(window as any).lucide = { createIcons: (options: any = {}) => createIcons({ ...options, icons }) };
const { load, clearViewer } = await import("../../viewer/app.js");
const $ = (id: string) => document.getElementById(id)!;
const query = new URLSearchParams(location.search);
let directory: any, candidates: any[] = [], source: any, verification: any;
let busy = false, controller: AbortController | null = null;
function status(message: string) { $("local-status").textContent = message; }
function controls(value: boolean) {
  busy = value;
  for (const id of ["open-directory", "restore-directory", "local-canvas", "refresh"]) ($(id) as HTMLButtonElement).disabled = value;
  ($("local-canvas") as HTMLSelectElement).disabled = value || !candidates.length;
  ($("verify-local") as HTMLButtonElement).disabled = value || !source;
  ($("export-verification") as HTMLButtonElement).disabled = value || !verification;
}
function issues(items: any[]) {
  $("local-issues").hidden = !items.length;
  $("issues-summary").textContent = `${items.length} 项核对问题`;
  $("issues-json").textContent = JSON.stringify(items, null, 2);
}
function clear() {
  clearViewer(); source = null; verification = null; setDataSource(null);
  issues([]); $("local-path").textContent = "";
  ($("verification-progress") as HTMLProgressElement).value = 0;
  $("verification-progress").hidden = true;
}
async function selectCanvas() {
  clear();
  const item = candidates[Number(($("local-canvas") as HTMLSelectElement).value)];
  if (($("local-canvas") as HTMLSelectElement).value === "") return;
  if (!item) return;
  $("local-path").textContent = item.path;
  status("正在读取本地节点和资源清单...");
  source = await loadLocalBackup(item.handle);
  setDataSource(source);
  await load();
  document.title = `${source.report.canvasName || item.name} · 本地备份`;
  issues(source.issues);
  status(source.issues.length ? `快照发现 ${source.issues.length} 项问题；本地文件尚未重新核对` : "本地快照已打开 · 文件尚未重新核对");
}
async function open(handle: any, expected = query.get("canvasId")) {
  clear();
  candidates = [];
  const select = $("local-canvas") as HTMLSelectElement;
  select.replaceChildren();
  directory = handle;
  status("正在查找本地画布...");
  candidates = await discoverBackups(handle);
  if (!candidates.length) throw new Error("所选目录中没有画布报告。请选择下载时的目录、tapnow-backup 或具体画布目录。");
  candidates.forEach((item, i) => select.append(new Option(`${item.name} · ${item.id}`, String(i))));
  const index = candidates.findIndex(c => c.id === expected);
  if (expected && index < 0) {
    select.prepend(new Option("原画布不在此目录中，请明确选择", ""));
    select.value = ""; status("没有找到来源画布，未自动改选其他画布");
  } else {
    select.value = String(Math.max(0, index));
    await selectCanvas();
  }
  $("restore-directory").hidden = true;
  await directoryHandle("viewer-last", handle);
}
async function run(action: () => Promise<void>) {
  if (busy) return;
  controls(true);
  try { await action(); } catch (error) { status(`读取未完成：${error instanceof Error ? error.message : String(error)}`); }
  finally { controls(false); }
}
$("open-directory").onclick = () => run(async () => {
  // Keep the chooser call directly in the user's click event.
  const handle = await (window as any).showDirectoryPicker({ mode: "read", id: "tapnow-viewer" });
  await open(handle);
});
$("local-canvas").onchange = () => run(selectCanvas);
$("refresh").onclick = () => run(async () => { if (directory) await open(directory, source?.report.canvasId || query.get("canvasId")); });
$("verify-local").onclick = () => run(async () => {
  controller = new AbortController();
  $("cancel-verify").hidden = false; $("verification-progress").hidden = false;
  verification = null;
  status("正在重新读取本地文件并计算 SHA-256...");
  try {
    verification = await verifyLocalBackup(source, {
      signal: controller.signal,
      onProgress: (p: any) => {
        const progress = $("verification-progress") as HTMLProgressElement;
        progress.max = Math.max(1, p.totalFiles); progress.value = p.checkedFiles;
        status(`已核对 ${p.checkedFiles}/${p.totalFiles} 个文件 · ${p.verifiedTargets} 个目标通过`);
      }
    });
    issues(verification.issues);
    status(`${verification.aborted ? "核对已停止，未通过完整核对" : verification.passed ? "本地快照完整性核对通过" : "核对未通过"} · ${verification.verifiedTargets}/${verification.targetCount} 个资源目标通过 · ${verification.issues.length} 项问题`);
  } finally { $("cancel-verify").hidden = true; controller = null; }
});
$("cancel-verify").onclick = () => controller?.abort();
$("export-verification").onclick = () => {
  if (!verification) return;
  const url = URL.createObjectURL(new Blob([JSON.stringify({ ...verification, canvasId: source.report.canvasId,
    canvasName: source.report.canvasName, snapshotCounts: { nodes: source.report.nodeCount, connections: source.report.connectionCount, references: source.report.referenceCount } }, null, 2)], { type: "application/json" }));
  const a = document.createElement("a"); a.href = url; a.download = `tapnow-check-${source.report.canvasId}.json`; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
};
let previous: any;
$("restore-directory").onclick = () => run(async () => {
  if (await previous.requestPermission({ mode: "read" }) !== "granted") throw new Error("目录读取权限未授予");
  await open(previous);
});
createIcons({ icons });
controls(true);
try {
  previous = await directoryHandle(query.get("directory") || "viewer-last");
  if (previous) {
    if (await previous.queryPermission({ mode: "read" }) === "granted") await open(previous);
    else { $("restore-directory").hidden = false; status(`上次目录：${previous.name} · 等待读取授权`); }
  }
} catch (error) { status(`上次目录不可用，请重新选择：${String(error)}`); }
finally { controls(false); }
window.addEventListener("beforeunload", () => controller?.abort());
