import { defineConfig } from "wxt";

export default defineConfig({
  manifest: {
    name: "TapNow Companion",
    version: "0.1.0",
    description: "A lightweight pre-run review assistant for TapNow Canvas.",
    permissions: ["storage"],
    host_permissions: [
      "https://app.tapnow.ai/*",
      "https://api.openai.com/*"
    ],
    action: {
      default_title: "TapNow Companion"
    }
  }
});
