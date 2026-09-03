import { browser } from "wxt/browser";
import { defineBackground } from "wxt/utils/define-background";
import { DEFAULT_SETTINGS, normalizeSettings } from "../utils/reviewer";
import { reviewWithLlm } from "../utils/llm";

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

export default defineBackground(() => {
  browser.runtime.onMessage.addListener(async (message) => {
    if (message?.type === "tapnow:capture-image") {
      try {
        const source = new URL(String(message.url || ""));
        if (
          source.protocol !== "https:" ||
          !(
            source.hostname === "app.tapnow.ai" ||
            source.hostname.endsWith(".tapnow.media")
          )
        ) {
          return { ok: false, error: "图片来源域名不在允许范围内。" };
        }
        const response = await fetch(source, {
          headers: { Referer: "https://app.tapnow.ai/" }
        });
        if (!response.ok) {
          return { ok: false, error: `图片请求失败 HTTP ${response.status}` };
        }
        const contentType = response.headers.get("content-type") || "image/jpeg";
        if (!contentType.startsWith("image/")) {
          return { ok: false, error: "媒体响应不是图片。" };
        }
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.length > 4_000_000) {
          return { ok: false, error: "图片超过 4 MB，未上传给 LLM。" };
        }
        return {
          ok: true,
          dataUrl: `data:${contentType.split(";")[0]};base64,${bytesToBase64(bytes)}`
        };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        };
      }
    }

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
        includeImages: settings.llmIncludeImages,
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
