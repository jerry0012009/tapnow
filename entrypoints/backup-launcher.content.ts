import { browser } from "wxt/browser";
import { createElement, Download, FolderOpen, GripVertical, RotateCcw } from "lucide";
import { defineContentScript } from "wxt/utils/define-content-script";
import { canvasIdFromUrl } from "../utils/backup/source";

export default defineContentScript({
  matches: ["https://app.tapnow.ai/*"], runAt: "document_idle",
  main(ctx) {
    const host = document.createElement("div");
    host.id = "tapnow-backup-host";
    if (document.getElementById(host.id)) return;
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `<style>
      :host{all:initial;position:fixed;inset:0;width:100%;height:100%;margin:0;padding:0;border:0;background:transparent;pointer-events:none;z-index:2147483647}
      .dock{position:fixed;right:20px;bottom:128px;display:flex;align-items:center;gap:5px;max-width:calc(100vw - 16px);padding:5px;border:1px solid #bdc9cf;border-radius:8px;background:#fff;box-shadow:0 3px 12px #17212b26;pointer-events:auto}
      button{border:0;border-radius:5px;min-height:34px;padding:6px 9px;font:600 13px/1.2 system-ui,sans-serif;cursor:pointer;white-space:nowrap;display:inline-flex;align-items:center;gap:5px;color:#fff;background:#126f5e}
      svg{width:16px;height:16px;flex-shrink:0}.grip,.reset-position{padding:5px;color:#55646d;background:transparent}.grip{cursor:grab;touch-action:none}
      .library-launcher{color:#176451;background:#e9f3ef}
      #error{position:fixed;left:16px;bottom:16px;max-width:calc(100vw - 32px);background:#fff1ec;color:#922d16;font:13px system-ui;padding:12px;pointer-events:auto}
      #error:empty{display:none}
    </style><div class="dock" role="toolbar" aria-label="TapNow 资产备份">
      <button class="grip" title="拖动备份入口" aria-label="拖动备份入口"></button>
      <button class="backup-launcher"><span>备份此画布</span></button>
      <button class="library-launcher" title="查看本地备份"><span>本地画布</span></button>
      <button class="reset-position" title="恢复备份入口位置" aria-label="恢复备份入口位置"></button>
    </div><div id="error" role="status"></div>`;
    const dock = shadow.querySelector<HTMLElement>(".dock")!;
    const grip = shadow.querySelector<HTMLButtonElement>(".grip")!;
    const backup = shadow.querySelector<HTMLButtonElement>(".backup-launcher")!;
    const library = shadow.querySelector<HTMLButtonElement>(".library-launcher")!;
    const reset = shadow.querySelector<HTMLButtonElement>(".reset-position")!;
    grip.append(createElement(GripVertical)); backup.prepend(createElement(Download));
    library.prepend(createElement(FolderOpen)); reset.append(createElement(RotateCcw));
    host.popover = "manual";
    document.documentElement.append(host);
    function update() {
      const visible = location.pathname.startsWith("/canvas");
      if (visible && !host.matches(":popover-open")) host.showPopover();
      if (!visible && host.matches(":popover-open")) host.hidePopover();
      backup.querySelector("span")!.textContent = canvasIdFromUrl(location.href) ? "备份此画布" : "选择画布备份";
    }
    function position(x: number, y: number) {
      const rect = dock.getBoundingClientRect();
      dock.style.left = `${Math.max(8, Math.min(x, innerWidth - rect.width - 8))}px`;
      dock.style.top = `${Math.max(8, Math.min(y, innerHeight - rect.height - 8))}px`;
      dock.style.right = "auto"; dock.style.bottom = "auto";
    }
    update();
    ctx.addEventListener(document, "fullscreenchange", () => {
      if (host.matches(":popover-open")) host.hidePopover();
      (document.fullscreenElement || document.documentElement).append(host); update();
    });
    ctx.addEventListener(window, "resize", () => { const rect = dock.getBoundingClientRect(); position(rect.x, rect.y); });
    const timer = window.setInterval(update, 1000);
    ctx.onInvalidated(() => { clearInterval(timer); host.remove(); });
    let drag: { x: number; y: number; left: number; top: number } | null = null;
    grip.onpointerdown = event => {
      const rect = dock.getBoundingClientRect(); drag = { x: event.clientX, y: event.clientY, left: rect.x, top: rect.y };
      grip.setPointerCapture(event.pointerId);
    };
    grip.onpointermove = event => { if (drag) position(drag.left + event.clientX - drag.x, drag.top + event.clientY - drag.y); };
    grip.onpointerup = () => {
      if (!drag) return; drag = null;
      const rect = dock.getBoundingClientRect();
      void browser.storage.local.set({ backupDockPosition: { left: rect.x, top: rect.y } });
    };
    grip.onpointercancel = () => { drag = null; };
    reset.onclick = () => { dock.removeAttribute("style"); void browser.storage.local.remove("backupDockPosition"); };
    void browser.storage.local.get({ backupDockPosition: null }).then(({ backupDockPosition: p }) => {
      const saved = p as { left: number; top: number } | null;
      if (saved && Number.isFinite(saved.left) && Number.isFinite(saved.top)) position(saved.left, saved.top);
    });
    async function open(type: string) {
      try {
        const reply = await browser.runtime.sendMessage({ type });
        if (!reply?.ok) throw new Error(reply?.error || "无法打开");
        shadow.querySelector("#error")!.textContent = "";
      } catch (error) { shadow.querySelector("#error")!.textContent = `入口暂不可用，请刷新页面：${String(error)}`; }
    }
    backup.onclick = () => { void open("tapnow:open-backup"); };
    library.onclick = () => { void open("tapnow:open-library"); };
  }
});
