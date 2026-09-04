import { browser } from "wxt/browser";
import { defineBackground } from "wxt/utils/define-background";
import { DEFAULT_SETTINGS, normalizeSettings } from "../utils/reviewer";
import { reviewWithLlm } from "../utils/llm";
import { MAX_SINGLE_IMAGE_BYTES } from "../utils/limits";

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

async function compressImage(
  bytes: Uint8Array,
  contentType: string
): Promise<Uint8Array | null> {
  try {
    const bitmap = await createImageBitmap(
      new Blob([bytes.buffer], { type: contentType })
    );
    const maxDimension = 2048;
    const scale = Math.min(
      1,
      maxDimension / Math.max(bitmap.width, bitmap.height)
    );
    const canvas = new OffscreenCanvas(
      Math.max(1, Math.round(bitmap.width * scale)),
      Math.max(1, Math.round(bitmap.height * scale))
    );
    canvas.getContext("2d")?.drawImage(
      bitmap,
      0,
      0,
      canvas.width,
      canvas.height
    );
    bitmap.close();
    for (const quality of [0.82, 0.68, 0.52]) {
      const output = await canvas.convertToBlob({
        type: "image/jpeg",
        quality
      });
      if (output.size <= MAX_SINGLE_IMAGE_BYTES) {
        return new Uint8Array(await output.arrayBuffer());
      }
    }
  } catch {
    // Some browsers cannot decode or re-encode a remote media format in a worker.
  }
  return null;
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
        if (bytes.length > MAX_SINGLE_IMAGE_BYTES) {
          const compressed = await compressImage(bytes, contentType);
          if (!compressed) {
            return {
              ok: false,
              error: `原图超过 ${MAX_SINGLE_IMAGE_BYTES / 1_000_000} MB，压缩后仍无法控制在发送上限内。`
            };
          }
          return {
            ok: true,
            dataUrl: `data:image/jpeg;base64,${bytesToBase64(compressed)}`
          };
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
        prompt: settings.llmPrompt,
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
