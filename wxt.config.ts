import { defineConfig } from "wxt";

export default defineConfig({
  manifest: {
    name: "TapNow Companion",
    version: "0.1.3",
    description: "A lightweight pre-run review assistant for TapNow Canvas.",
    permissions: ["storage"],
    host_permissions: [
      "https://app.tapnow.ai/*",
      "https://files.tapnow.media/*",
      "https://api.openai.com/*",
      "https://api.acucompute.com/*"
    ],
    action: {
      default_title: "TapNow Companion"
    }
  }
});
