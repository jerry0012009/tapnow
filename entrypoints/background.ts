import { browser } from "wxt/browser";
import { defineBackground } from "wxt/utils/define-background";
import { DEFAULT_SETTINGS, normalizeSettings } from "../utils/reviewer";
import { reviewWithLlm } from "../utils/llm";

export default defineBackground(() => {
  browser.runtime.onMessage.addListener(async (message) => {
    if (message?.type !== "tapnow:llm-review") return undefined;

    const [syncSettings, localSettings] = await Promise.all([
      browser.storage.sync.get(DEFAULT_SETTINGS),
      browser.storage.local.get({ apiKey: "" })
    ]);
    const settings = normalizeSettings(syncSettings);
    if (!settings.llmEnabled) {
      return { ok: false, error: "LLM 审阅未启用。" };
    }

    try {
      const result = await reviewWithLlm(message.draft, {
        apiKey: String(localSettings.apiKey || ""),
        protocol: settings.llmProtocol,
        model: settings.llmModel,
        baseUrl: settings.llmBaseUrl
      });
      return { ok: true, result };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  });
});
