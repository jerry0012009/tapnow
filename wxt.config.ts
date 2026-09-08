import { defineConfig } from "wxt";

export default defineConfig({
  manifest: {
    name: "TapNow Companion",
    version: "0.1.11",
    description: "A lightweight focused-node review assistant for TapNow Canvas.",
    permissions: ["storage", "tabs"],
    host_permissions: [
      "https://app.tapnow.ai/*",
      "https://files.tapnow.media/*",
      "https://files.tapnow.top/*",
      "https://api.openai.com/*",
      "https://api.acucompute.com/*"
    ],
    action: {
      default_title: "TapNow Companion"
    }
  }
});
