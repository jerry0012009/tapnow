import { defineConfig } from "wxt";

export default defineConfig({
  manifest: {
    name: "TapNow Companion",
    version: "0.1.13",
    description: "Back up TapNow canvas assets to a chosen local directory, with optional focused-node review.",
    permissions: ["storage", "tabs", "declarativeNetRequestWithHostAccess"],
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
