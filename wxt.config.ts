import { defineConfig } from "wxt";
import path from "node:path";

const edition = process.env.TAPNOW_EDITION || "backup";
if (!["backup", "companion"].includes(edition)) throw new Error("Unknown TAPNOW_EDITION");
const backup = edition === "backup";
export default defineConfig({
  outDir: `.output/${edition}`,
  filterEntrypoints: backup ? ["background", "popup", "backup", "library", "backup-bridge", "backup-launcher"] : ["background", "popup", "tapnow"],
  hooks: {
    "entrypoints:found"(_wxt, entries) {
      if (!backup) return;
      for (const entry of entries) {
        if (entry.name === "background") entry.inputPath = path.resolve("editions/backup/background.ts");
        if (entry.name === "popup") entry.inputPath = path.resolve("editions/backup/popup/index.html");
      }
    }
  },
  manifest: {
    name: backup ? "TapNow Backup - 资产备份与本地画布" : "TapNow Companion - 副驾驶",
    version: "0.1.15",
    description: backup ? "Back up TapNow canvases, browse local assets and verify file integrity." : "Review focused TapNow nodes, prompts and references.",
    permissions: backup ? ["storage", "tabs", "scripting", "declarativeNetRequestWithHostAccess"] : ["storage"],
    host_permissions: [
      "https://app.tapnow.ai/*",
      "https://files.tapnow.media/*",
      "https://files.tapnow.top/*",
      ...(!backup ? ["https://api.openai.com/*", "https://api.acucompute.com/*"] : [])
    ],
    action: {
      default_title: backup ? "TapNow 资产备份" : "TapNow 副驾驶"
    }
  }
});
