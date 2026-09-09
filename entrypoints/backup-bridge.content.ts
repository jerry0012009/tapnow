import { browser } from "wxt/browser";
import { defineContentScript } from "wxt/utils/define-content-script";
import { canvasIdFromUrl } from "../utils/backup/source";
import { messageListener } from "../utils/messages";

export default defineContentScript({
  matches: ["https://app.tapnow.ai/*"],
  runAt: "document_idle",
  main() {
    const scope = globalThis as typeof globalThis & { __tapnowBackupBridge?: string };
    if (scope.__tapnowBackupBridge === browser.runtime.id) return;
    scope.__tapnowBackupBridge = browser.runtime.id;
    browser.runtime.onMessage.addListener(messageListener(["tapnow:backup-v2-ping", "tapnow:backup-v2-json"], async message => {
      if (!["tapnow:backup-v2-ping", "tapnow:backup-v2-json"].includes(message?.type)) return;
      const canvasId = canvasIdFromUrl(location.href);
      if (message.expectedCanvasId !== canvasId) return { ok: false, error: "来源标签页已切换画布，请重新选择并扫描。" };
      const token = localStorage.getItem("access_token");
      if (message.type === "tapnow:backup-v2-ping") {
        return { ok: true, canvasId, title: document.title, hasSession: Boolean(token) };
      }
      if (!token) return { ok: false, error: "此 TapNow 页面没有登录会话，请先在原页面登录。" };
      const endpoint = String(message.endpoint || "");
      const url = new URL(endpoint, location.origin);
      const base = `/api/canvas/v1/canvases/${canvasId}`;
      if (url.origin !== location.origin || ![base, `${base}/nodes`, `${base}/connections`].includes(url.pathname)) {
        return { ok: false, error: "备份请求与当前画布不匹配。" };
      }
      try {
        const response = await fetch(url, {
          credentials: "include", headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(60000)
        });
        if (!response.ok) return { ok: false, status: response.status,
          error: response.status === 401 ? "登录会话已失效，请回到原画布重新登录。" :
            response.status === 403 ? "当前账号无法读取该画布，请确认原页面可访问。" : `TapNow API HTTP ${response.status}` };
        return { ok: true, body: await response.json(), canvasId };
      } catch (error) { return { ok: false, error: String(error) }; }
    }));
  }
});
