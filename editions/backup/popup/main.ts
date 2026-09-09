import { browser } from "wxt/browser";
import { createIcons, Download, FolderOpen } from "lucide";
import "./style.css";
createIcons({ icons: { Download, FolderOpen } });
for (const [id, type] of [["backup", "tapnow:open-backup"], ["library", "tapnow:open-library"]]) {
  document.getElementById(id)!.onclick = async () => {
    try {
      const result = await browser.runtime.sendMessage({ type });
      if (!result?.ok) throw new Error(result?.error || "无法打开");
      window.close();
    } catch (error) { document.getElementById("status")!.textContent = String(error); }
  };
}
