import { browser, type Browser } from "wxt/browser";
import { defineBackground } from "wxt/utils/define-background";
import { backupPageQuery, sourceMatches } from "../../utils/backup/source";
import { messageListener } from "../../utils/messages";

export default defineBackground(() => {
  browser.runtime.onMessage.addListener(messageListener<Browser.runtime.MessageSender>([
    "tapnow:ensure-backup-bridge", "tapnow:prepare-backup", "tapnow:open-backup", "tapnow:open-library"
  ], async (message, sender) => {
    if (message.type === "tapnow:ensure-backup-bridge") {
      if (sender.id !== browser.runtime.id || sender.url?.split(/[?#]/)[0] !== browser.runtime.getURL("/backup.html")) {
        return { ok: false, error: "Invalid caller" };
      }
      try {
        const tab = await browser.tabs.get(message.tabId);
        if (!sourceMatches(tab, message.tabId, message.canvasId)) throw new Error("来源标签页已关闭或切换，请重新选择画布。");
        const ping = () => browser.tabs.sendMessage(tab.id!, { type: "tapnow:backup-v2-ping", expectedCanvasId: message.canvasId }, { frameId: 0 });
        try { return await ping(); } catch {}
        await browser.scripting.executeScript({ target: { tabId: tab.id!, frameIds: [0] }, files: ["/content-scripts/backup-bridge.js"] });
        return await ping();
      } catch (error) {
        return { ok: false, error: `无法连接该画布，请检查网站访问权限及原标签页：${String(error)}` };
      }
    }
    if (message.type === "tapnow:prepare-backup") {
      await browser.declarativeNetRequest.updateSessionRules({
        removeRuleIds: [9901],
        addRules: [{
          id: 9901, priority: 1,
          action: { type: "modifyHeaders", requestHeaders: [{ header: "Referer", operation: "set", value: "https://app.tapnow.ai/" }] },
          condition: {
            requestDomains: ["files.tapnow.media", "files.tapnow.top"],
            initiatorDomains: [browser.runtime.id], resourceTypes: ["xmlhttprequest"]
          }
        }]
      });
      return { ok: true };
    }
    if (message.type === "tapnow:open-library") {
      await browser.tabs.create({ url: browser.runtime.getURL("/library.html") });
      return { ok: true };
    }
    const source = sender.tab?.url?.startsWith("https://app.tapnow.ai/") ? sender.tab : (await browser.tabs.query({ active: true, currentWindow: true }))[0];
    const query = backupPageQuery(source);
    await browser.tabs.create({
      url: `${browser.runtime.getURL("/backup.html")}${query ? `?${query}` : ""}`,
      ...(source?.id ? { openerTabId: source.id, windowId: source.windowId } : {})
    });
    return { ok: true };
  }));
});
