import { browser } from "wxt/browser";
import {
  DEFAULT_SETTINGS,
  normalizeSettings,
  reviewDraft,
  inferPromptFromNodeText,
  inferNodeTypeFromId,
  type LocalReview,
  type ReviewDraft,
  type ReviewSettings
} from "../utils/reviewer";
import { reviewPayloadStats } from "../utils/llm";
import {
  MAX_REVIEW_IMAGE_MATERIALS,
  MAX_REVIEW_PROMPT_CHARS,
  MAX_REVIEW_TEXT_MATERIAL_ITEM_CHARS,
  MAX_REVIEW_TEXT_MATERIALS,
  MAX_REVIEW_UPSTREAM_CHARS,
  MAX_SINGLE_IMAGE_BYTES
} from "../utils/limits";

interface LlmResponse {
  ok: boolean;
  error?: string;
  result?: {
    decision: "allow" | "warn" | "block";
    summary: string;
    issues: LocalReview["issues"];
    suggestions: string[];
    model: string;
    requestStats?: ReturnType<typeof reviewPayloadStats> & {
      requestBytes: number;
    };
  };
}

type ActiveField = HTMLTextAreaElement | HTMLInputElement | HTMLElement;

export default defineContentScript({
  matches: ["https://app.tapnow.ai/*"],
  runAt: "document_idle",
  main() {
    const mount = () => {
      if (
        !location.pathname.startsWith("/canvas/") ||
        document.getElementById("tapnow-companion-host")
      ) {
        return;
      }

      const state: {
        settings: ReviewSettings;
        activeField: ActiveField | null;
        activeNode: Element | null;
        dragging: boolean;
        movedDuringDrag: boolean;
        suppressNextClick: boolean;
        dragStartX: number;
        dragStartY: number;
        dragOriginLeft: number;
        dragOriginTop: number;
        reviewSequence: number;
        activeNodeId: string | null;
        lastDraft: ReviewDraft | null;
      } = {
        settings: DEFAULT_SETTINGS,
        activeField: null,
        activeNode: null,
        dragging: false,
        movedDuringDrag: false,
        suppressNextClick: false,
        dragStartX: 0,
        dragStartY: 0,
        dragOriginLeft: 0,
        dragOriginTop: 0,
        reviewSequence: 0,
        activeNodeId: null,
        lastDraft: null
      };

      const host = document.createElement("div");
      host.id = "tapnow-companion-host";
      const shadow = host.attachShadow({ mode: "open" });
      shadow.innerHTML = `
        <style>
          :host { all: initial; }
          .launcher { position: fixed; right: 20px; bottom: 20px; z-index: 2147483647; border: 1px solid #cbd5e1; border-radius: 999px; background: #0f172a; color: white; box-shadow: 0 8px 24px rgba(15, 23, 42, .22); padding: 10px 14px; font: 600 13px/1.2 system-ui, sans-serif; cursor: grab; user-select: none; touch-action: none; }
          .launcher.dragging { cursor: grabbing; }
          .panel { position: fixed; top: 16px; right: 16px; bottom: 16px; width: min(400px, calc(100vw - 32px)); z-index: 2147483646; display: flex; flex-direction: column; background: #f8fafc; color: #0f172a; border: 1px solid #cbd5e1; border-radius: 10px; box-shadow: 0 18px 50px rgba(15, 23, 42, .28); font: 14px/1.45 system-ui, -apple-system, sans-serif; }
          .hidden { display: none; }
          .header { display: flex; align-items: center; justify-content: space-between; padding: 16px; border-bottom: 1px solid #e2e8f0; }
          .header strong { font-size: 16px; }
          .close { border: 0; background: transparent; color: #475569; font-size: 20px; cursor: pointer; }
          .body { overflow: auto; padding: 16px; }
          .meta { color: #64748b; font-size: 12px; margin-bottom: 12px; word-break: break-all; }
          .label { color: #475569; font-size: 12px; font-weight: 700; margin: 14px 0 6px; }
          .prompt, .context { white-space: pre-wrap; overflow-wrap: anywhere; background: white; border: 1px solid #e2e8f0; border-radius: 7px; padding: 10px; margin: 0; }
          .prompt { max-height: 150px; overflow: auto; }
          .context { max-height: 110px; overflow: auto; color: #475569; }
          .materials { color: #475569; font-size: 12px; }
          .issue { border-left: 4px solid #f59e0b; background: #fffbeb; padding: 9px 10px; margin: 8px 0; border-radius: 5px; }
          .issue.block { border-left-color: #dc2626; background: #fef2f2; }
          .issue.allow { border-left-color: #16a34a; background: #f0fdf4; }
          .issue strong { display: block; margin-bottom: 2px; }
          .suggestion { color: #334155; margin: 7px 0; }
          .llm { border-top: 1px solid #e2e8f0; margin-top: 14px; padding-top: 4px; }
          .debug { margin-top: 14px; border-top: 1px solid #e2e8f0; padding-top: 10px; color: #64748b; font-size: 12px; }
          .debug summary { cursor: pointer; font-weight: 700; }
          .debug pre { white-space: pre-wrap; overflow-wrap: anywhere; max-height: 260px; overflow: auto; margin: 8px 0 0; padding: 8px; background: #fff; border: 1px solid #e2e8f0; border-radius: 6px; font: 11px/1.4 ui-monospace, SFMono-Regular, Consolas, monospace; color: #334155; }
          .footer { display: flex; gap: 8px; padding: 14px 16px; border-top: 1px solid #e2e8f0; }
          button.action { flex: 1; min-height: 38px; border: 1px solid #cbd5e1; border-radius: 7px; cursor: pointer; font: 600 13px system-ui, sans-serif; }
          button.primary { background: #0f766e; color: white; border-color: #0f766e; }
          .notice { color: #64748b; font-size: 12px; margin-top: 10px; }
        </style>
        <button class="launcher" type="button" title="检测当前聚焦节点">副驾驶</button>
        <section class="panel hidden" aria-label="TapNow Companion 审核面板">
          <header class="header">
            <strong>当前节点检测</strong>
            <button class="close" type="button" aria-label="关闭">×</button>
          </header>
          <div class="body"></div>
          <footer class="footer">
            <button class="action close-action" type="button">关闭</button>
            <button class="action primary detect" type="button">检测</button>
          </footer>
        </section>
      `;

      document.documentElement.append(host);
      const launcher = shadow.querySelector<HTMLButtonElement>(".launcher")!;
      const panel = shadow.querySelector<HTMLElement>(".panel")!;
      const body = shadow.querySelector<HTMLElement>(".body")!;
      const close = shadow.querySelector<HTMLButtonElement>(".close")!;
      const closeAction = shadow.querySelector<HTMLButtonElement>(".close-action")!;
      const detectButton = shadow.querySelector<HTMLButtonElement>(".detect")!;

      function textOf(element: Element | null | undefined): string {
        const candidate = element as (Element & { value?: string }) | null | undefined;
        return (candidate?.value || candidate?.textContent || "")
          .replace(/\s+/g, " ")
          .trim();
      }

      function nodeFor(target: Element | null): Element | null {
        if (!target || host.contains(target)) return null;
        return (
          target.closest("[data-node-id], [data-id], [data-node]") ||
          target.closest("[class*='node'], [class*='Node']") ||
          target.closest("textarea, [contenteditable=true]")?.parentElement ||
          target
        );
      }

      function rememberActive(target: Element | null) {
        if (!target || host.contains(target)) return;
        state.activeField = target.closest(
          "textarea, input:not([type=hidden]), [contenteditable=true]"
        ) as ActiveField | null;
        state.activeNode = nodeFor(target);
        state.activeNodeId = getNodeId(state.activeNode);
        console.info("[TapNow Companion] focus", {
          nodeId: state.activeNodeId,
          nodeType: inferNodeTypeFromId(state.activeNodeId),
          fieldTag: state.activeField?.tagName || null
        });
      }

      function nodeTextOf(element: Element | null): string {
        if (!element) return "";
        const clone = element.cloneNode(true) as Element;
        clone
          .querySelectorAll("button, [role=button], script, style")
          .forEach((control) => control.remove());
        return inferPromptFromNodeText(textOf(clone));
      }

      function getNodeId(element: Element | null): string | null {
        let current = element;
        for (
          let depth = 0;
          current && depth < 8;
          depth++, current = current.parentElement
        ) {
          for (const name of ["data-node-id", "data-id", "data-node"]) {
            const value = current.getAttribute(name);
            if (value && value.length < 200) return value;
          }
        }
        return null;
      }

      function findNodeById(nodeId: string | null): Element | null {
        if (!nodeId) return null;
        return [...document.querySelectorAll(".react-flow__node[data-id]")].find(
          (node) => node.getAttribute("data-id") === nodeId
        ) || null;
      }

      function incomingNodeIds(nodeId: string | null): string[] {
        if (!nodeId) return [];
        const result: string[] = [];
        for (const edge of document.querySelectorAll("[aria-label^='Edge from ']")) {
          const label = edge.getAttribute("aria-label") || "";
          const match = label.match(/^Edge from (.+) to (.+)$/);
          if (match?.[2] === nodeId) result.push(match[1]);
        }
        return [...new Set(result)];
      }

      function normalizedImageUrl(value: string): string {
        try {
          const parsed = new URL(sourceImageUrl(value));
          parsed.searchParams.delete("tap_mx");
          return parsed.toString();
        } catch {
          return value;
        }
      }

      function sourceImageUrl(value: string): string {
        try {
          const parsed = new URL(value);
          parsed.searchParams.delete("variant_name");
          return parsed.toString();
        } catch {
          return value;
        }
      }

      function visible(element: Element): boolean {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return (
          rect.width > 0 &&
          rect.height > 0 &&
          style.display !== "none" &&
          style.visibility !== "hidden"
        );
      }

      function blobToDataUrl(blob: Blob): Promise<string> {
        return new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result));
          reader.onerror = () => reject(reader.error);
          reader.readAsDataURL(blob);
        });
      }

      async function captureImage(
        image: HTMLImageElement | string
      ): Promise<{
        dataUrl?: string;
        error?: string;
        compression?: {
          applied: boolean;
          method: string;
          originalBytes?: number | null;
          preparedBytes?: number | null;
        };
      }> {
        async function encodeCanvas(
          canvas: HTMLCanvasElement
        ): Promise<{ dataUrl: string; bytes: number } | undefined> {
          for (const quality of [0.82, 0.68, 0.52]) {
            const output = await new Promise<Blob | null>((resolve) =>
              canvas.toBlob(resolve, "image/jpeg", quality)
            );
            if (output && output.size <= MAX_SINGLE_IMAGE_BYTES) {
              return {
                dataUrl: await blobToDataUrl(output),
                bytes: output.size
              };
            }
          }
          return undefined;
        }

        async function compressBlob(
          blob: Blob
        ): Promise<{ dataUrl: string; bytes: number } | undefined> {
          try {
            const bitmap = await createImageBitmap(blob);
            const maxDimension = 2048;
            const scale = Math.min(
              1,
              maxDimension / Math.max(bitmap.width, bitmap.height)
            );
            const canvas = document.createElement("canvas");
            canvas.width = Math.max(1, Math.round(bitmap.width * scale));
            canvas.height = Math.max(1, Math.round(bitmap.height * scale));
            canvas.getContext("2d")?.drawImage(
              bitmap,
              0,
              0,
              canvas.width,
              canvas.height
            );
            bitmap.close();
            return await encodeCanvas(canvas);
          } catch {
            return undefined;
          }
        }

        const source =
          typeof image === "string" ? image : image.currentSrc || image.src;
        try {
          const response = await fetch(source, { credentials: "include" });
          if (response.ok) {
            const blob = await response.blob();
            if (blob.size <= MAX_SINGLE_IMAGE_BYTES) {
              return {
                dataUrl: await blobToDataUrl(blob),
                compression: {
                  applied: false,
                  method: "original",
                  originalBytes: blob.size,
                  preparedBytes: blob.size
                }
              };
            }
            const compressed = await compressBlob(blob);
            if (compressed) {
              return {
                dataUrl: compressed.dataUrl,
                compression: {
                  applied: true,
                  method: "page-canvas-jpeg-2048",
                  originalBytes: blob.size,
                  preparedBytes: compressed.bytes
                }
              };
            }
            return {
              error: `原图超过 ${MAX_SINGLE_IMAGE_BYTES / 1_000_000} MB，压缩后仍无法控制在发送上限内。`
            };
          }
        } catch {
          // The extension fetch below handles media hosts that reject page CORS.
        }
        try {
          if (typeof image !== "string") {
            const canvas = document.createElement("canvas");
            const maxDimension = 2048;
            const scale = Math.min(
              1,
              maxDimension / Math.max(image.naturalWidth, image.naturalHeight)
            );
            canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
            canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
            canvas.getContext("2d")?.drawImage(
              image,
              0,
              0,
              canvas.width,
              canvas.height
            );
            const encoded = await encodeCanvas(canvas);
            if (encoded) {
              return {
                dataUrl: encoded.dataUrl,
                compression: {
                  applied: true,
                  method: "page-canvas-jpeg-2048",
                  originalBytes: null,
                  preparedBytes: encoded.bytes
                }
              };
            }
          }
        } catch {
          // Fall through to the background fetch.
        }
        try {
          const response = (await browser.runtime.sendMessage({
            type: "tapnow:capture-image",
            url: source
          })) as {
            ok?: boolean;
            dataUrl?: string;
            error?: string;
            compression?: {
              applied: boolean;
              method: string;
              originalBytes?: number | null;
              preparedBytes?: number | null;
            };
          };
          return response?.ok && response.dataUrl
            ? {
                dataUrl: response.dataUrl,
                compression: response.compression
              }
            : { error: response?.error || "无法读取图片。" };
        } catch {
          return { error: "无法读取图片。" };
        }
      }

      async function getDraft(includeImageData = false): Promise<ReviewDraft> {
        const field =
          state.activeField &&
          document.contains(state.activeField) &&
          (!state.activeNode || state.activeNode.contains(state.activeField))
            ? state.activeField
            : null;
        const rememberedNode =
          state.activeNode && document.contains(state.activeNode)
            ? state.activeNode
            : findNodeById(state.activeNodeId);
        const nodeElement = rememberedNode || (field ? nodeFor(field) : null);
        const nodeId = getNodeId(nodeElement) || state.activeNodeId;
        const nodeType = (
          nodeElement?.getAttribute("data-node-type") ||
          nodeElement?.getAttribute("data-type") ||
          inferNodeTypeFromId(nodeId) ||
          ""
        ).toLowerCase() || null;
        const currentNodeText = nodeTextOf(nodeElement);
        const fieldPrompt = inferPromptFromNodeText(textOf(field));
        const currentPrompt =
          nodeType === "text" ? inferPromptFromNodeText(currentNodeText) : "";
        const connectedNodes = incomingNodeIds(nodeId)
          .map((sourceId) => findNodeById(sourceId))
          .filter((node): node is Element => Boolean(node));
        const textMaterials: string[] = [];
        const textMaterialSources: NonNullable<
          ReviewDraft["textMaterialSources"]
        > = [];
        const addText = (
          value: string,
          source: { nodeId?: string | null; nodeType?: string | null; role?: string }
        ) => {
          const text = value.slice(0, MAX_REVIEW_TEXT_MATERIAL_ITEM_CHARS);
          if (!text || textMaterials.includes(text)) return;
          if (textMaterials.length >= MAX_REVIEW_TEXT_MATERIALS) return;
          textMaterials.push(text);
          textMaterialSources.push(source);
        };

        if (fieldPrompt) {
          addText(fieldPrompt, {
            nodeId,
            nodeType,
            role: "focused-node-input"
          });
        }
        if (currentPrompt && currentPrompt !== fieldPrompt) {
          addText(currentPrompt, {
            nodeId,
            nodeType,
            role: "focused-node-text"
          });
        }
        for (const connectedNode of connectedNodes) {
          const connectedText = nodeTextOf(connectedNode);
          if (!connectedText) continue;
          addText(connectedText, {
            nodeId: getNodeId(connectedNode),
            nodeType: inferNodeTypeFromId(getNodeId(connectedNode)),
            role: "upstream-node"
          });
        }

        const prompt = (
          fieldPrompt ||
          (nodeType === "text" ? currentPrompt : "") ||
          textMaterials[0] ||
          ""
        ).slice(0, MAX_REVIEW_PROMPT_CHARS);
        const upstreamTexts = connectedNodes
          .map((connectedNode) => nodeTextOf(connectedNode))
          .filter(Boolean);

        const imageSources = [
          ...(nodeElement ? [{ node: nodeElement, role: "focused-node" }] : []),
          ...connectedNodes.map((node) => ({ node, role: "upstream-node" }))
        ];
        const imageMaterials: NonNullable<ReviewDraft["imageMaterials"]> = [];
        const seenImages = new Set<string>();
        for (const { node, role } of imageSources) {
          const sourceNodeId = getNodeId(node);
          const sourceNodeType = inferNodeTypeFromId(sourceNodeId);
          const imageElements = [...node.querySelectorAll("img")]
            .filter(visible)
            .filter(
              (image) => image.naturalWidth >= 64 && image.naturalHeight >= 64
            );
          for (const image of imageElements) {
            if (imageMaterials.length >= MAX_REVIEW_IMAGE_MATERIALS) break;
            const url = sourceImageUrl(
              (image.currentSrc || image.src).slice(0, 2000)
            );
            const imageKey = normalizedImageUrl(url);
            if (!url || seenImages.has(imageKey)) continue;
            seenImages.add(imageKey);
            const material: NonNullable<ReviewDraft["imageMaterials"]>[number] = {
              materialId: `image-${imageMaterials.length + 1}`,
              url,
              alt: (image.alt || "").slice(0, 300),
              width:
                image.naturalWidth ||
                Math.round(image.getBoundingClientRect().width),
              height:
                image.naturalHeight ||
                Math.round(image.getBoundingClientRect().height),
              sourceNodeId,
              sourceNodeType,
              role:
                image.alt === "referenceImage"
                  ? `${role}-reference`
                  : `${role}-output`
            };
            if (includeImageData) {
              const captured = await captureImage(url);
              material.dataUrl = captured.dataUrl;
              material.captureError = captured.error;
              material.compression = captured.compression;
            }
            imageMaterials.push(material);
          }
        }

        return {
          canvasId: location.pathname.split("/").filter(Boolean).pop() || null,
          nodeId,
          nodeType,
          prompt,
          upstreamSummary: upstreamTexts
            .join("\n\n")
            .slice(0, MAX_REVIEW_UPSTREAM_CHARS),
          textMaterials,
          textMaterialSources,
          imageMaterials,
          fieldCount: textMaterials.length,
          source: "focused-page-node"
        };
      }

      async function prepareDraftImages(
        draft: ReviewDraft
      ): Promise<ReviewDraft> {
        if (!draft.imageMaterials?.length) return draft;
        const imageMaterials = [];
        for (const image of draft.imageMaterials) {
          const captured = await captureImage(image.url);
          imageMaterials.push({
            ...image,
            dataUrl: captured.dataUrl,
            captureError: captured.error,
            compression: captured.compression
          });
        }
        return { ...draft, imageMaterials };
      }

      function escapeHtml(value: unknown): string {
        return String(value ?? "").replace(/[&<>"']/g, (character) => ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;"
        })[character] as string);
      }

      function formatBytes(value: number): string {
        if (value < 1_000_000) return `${(value / 1_000).toFixed(1)} KB`;
        return `${(value / 1_000_000).toFixed(1)} MB`;
      }

      function render(
        draft: ReviewDraft,
        local: LocalReview,
        llm: LlmResponse["result"] | null = null,
        llmError = "",
        imagePreparationAttempted = false,
        llmCalled = false
      ) {
        const issues = [...local.issues, ...(llm?.issues || [])];
        const issueHtml = issues.length
          ? issues.map((issue) => `
              <div class="issue ${issue.severity}">
                <strong>${escapeHtml(issue.title)}</strong>
                <span>${escapeHtml(issue.detail)}</span>
              </div>`).join("")
          : `<div class="issue allow"><strong>未发现问题</strong><span>本地规则检查通过。</span></div>`;
        const suggestions = [...local.suggestions, ...(llm?.suggestions || [])];
        const suggestionsHtml = suggestions.length
          ? `<div class="label">建议</div>${[...new Set(suggestions)]
              .map((item) => `<div class="suggestion">• ${escapeHtml(item)}</div>`)
              .join("")}`
          : "";
        const llmHtml = llm
          ? `<div class="llm"><div class="label">LLM 审阅 · ${escapeHtml(llm.model)}</div><div class="context">${escapeHtml(llm.summary)}</div></div>`
          : llmError
            ? `<div class="llm"><div class="label">LLM 审阅</div><div class="issue"><strong>调用失败</strong><span>${escapeHtml(llmError)}</span></div></div>`
            : "";
        const imageCount = draft.imageMaterials?.length || 0;
        const uploadable =
          draft.imageMaterials?.filter((image) => image.dataUrl).length || 0;
        const payloadStats = reviewPayloadStats(
          draft,
          state.settings.llmIncludeImages
        );
        const captureErrors = [
          ...new Set(
            (draft.imageMaterials || [])
              .filter((image) => !image.dataUrl && image.captureError)
              .map((image) => image.captureError)
          )
        ];
        const materialSummary = state.settings.llmIncludeImages
          ? imagePreparationAttempted
            ? `文字 ${draft.textMaterials?.length || 0} 项 · 图片 ${imageCount} 项 · 可发送图片 ${payloadStats.sentCount} 项 · ${formatBytes(payloadStats.sentImageBytes)}`
            : `文字 ${draft.textMaterials?.length || 0} 项 · 图片 ${imageCount} 项 · 正在检查图片可发送性`
          : `文字 ${draft.textMaterials?.length || 0} 项 · 图片 ${imageCount} 项 · 图片发送未开启`;
        const imageNotice = state.settings.llmIncludeImages
          ? imagePreparationAttempted
            ? `${captureErrors.length ? captureErrors.join(" ") + " " : ""}图片仅在本地完成预检；点击“检测”才会按总请求预算发送。${payloadStats.omittedCount ? ` 有 ${payloadStats.omittedCount} 项因预算未发送。` : ""}`
            : "正在本地准备图片；此过程不会调用 LLM。"
          : "点击“检测”才会调用 LLM；当前未开启图片发送，只传图片元数据。";
        const debugInfo = {
          canvasId: draft.canvasId || null,
          nodeId: draft.nodeId || null,
          nodeType: draft.nodeType || null,
          source: draft.source || null,
          prompt: draft.prompt || "",
          upstreamSummary: draft.upstreamSummary || "",
          textMaterials: draft.textMaterials || [],
          textMaterialSources: draft.textMaterialSources || [],
          images: (draft.imageMaterials || []).map((image) => ({
            materialId: image.materialId || null,
            url: image.url,
            alt: image.alt || "",
            width: image.width || null,
            height: image.height || null,
            sourceNodeId: image.sourceNodeId || null,
            sourceNodeType: image.sourceNodeType || null,
            role: image.role || null,
            prepared: Boolean(image.dataUrl),
            preparedBytes: image.dataUrl
              ? Math.round((image.dataUrl.length * 3) / 4)
              : 0,
            compression: image.compression
              ? {
                  applied: image.compression.applied,
                  method: image.compression.method,
                  originalBytes: image.compression.originalBytes ?? null,
                  preparedBytes:
                    image.compression.preparedBytes ??
                    (image.dataUrl
                      ? Math.round((image.dataUrl.length * 3) / 4)
                      : null),
                  savedBytes:
                    image.compression.originalBytes != null &&
                    image.compression.preparedBytes != null
                      ? image.compression.originalBytes -
                        image.compression.preparedBytes
                      : null,
                  ratio:
                    image.compression.originalBytes &&
                    image.compression.preparedBytes
                      ? Number(
                          (
                            image.compression.preparedBytes /
                            image.compression.originalBytes
                          ).toFixed(4)
                        )
                      : null
                }
              : null,
            captureError: image.captureError || null
          })),
          settings: {
            llmEnabled: state.settings.llmEnabled,
            llmIncludeImages: state.settings.llmIncludeImages,
            llmProtocol: state.settings.llmProtocol,
            llmModel: state.settings.llmModel,
            llmPrompt: state.settings.llmPrompt
          },
          request: {
            called: llmCalled,
            endpoint:
              state.settings.llmProtocol === "responses"
                ? `${state.settings.llmBaseUrl}/responses`
                : `${state.settings.llmBaseUrl}/chat/completions`,
            preparedImagesAvailable: uploadable,
            preparedImagesSent: payloadStats.sentCount,
            omittedImages: payloadStats.omittedCount,
            imageBytesSent: payloadStats.sentImageBytes,
            textCharsSource: payloadStats.sourceTextChars,
            textCharsIncluded: payloadStats.includedTextChars,
            textCharsOmitted: payloadStats.omittedTextChars,
            requestBytes: llm?.requestStats?.requestBytes || null
          },
          llm: llm
            ? {
                called: llmCalled,
                model: llm.model,
                decision: llm.decision,
                summary: llm.summary
              }
            : { called: llmCalled, error: llmError || null }
        };

        body.innerHTML = `
          <div class="meta">画布：${escapeHtml(draft.canvasId || "未识别")}<br>节点：${escapeHtml(draft.nodeId || "未识别")}<br>来源：${escapeHtml(draft.source || "页面")}</div>
          <div class="label">当前输入</div>
          <div class="prompt">${escapeHtml(draft.prompt || "未检测到当前节点文字输入")}</div>
          <div class="label">节点上下文</div>
          <div class="context">${escapeHtml(draft.upstreamSummary || "未检测到可见上下文")}</div>
          <div class="label">素材</div>
          <div class="materials">${materialSummary}</div>
          <div class="label">检查结果</div>
          ${issueHtml}
          ${llmHtml}
          ${suggestionsHtml}
          <div class="notice">${imageNotice}</div>
          <details class="debug">
            <summary>开发者信息</summary>
            <pre>${escapeHtml(JSON.stringify(debugInfo, null, 2))}</pre>
          </details>
        `;
        console.info("[TapNow Companion] panel", debugInfo);
      }

      function clamp(value: number, minimum: number, maximum: number): number {
        return Math.min(Math.max(value, minimum), Math.max(minimum, maximum));
      }

      function applyLauncherPosition(left: number, top: number) {
        const rect = launcher.getBoundingClientRect();
        launcher.style.left = `${clamp(
          left,
          8,
          window.innerWidth - rect.width - 8
        )}px`;
        launcher.style.top = `${clamp(
          top,
          8,
          window.innerHeight - rect.height - 8
        )}px`;
        launcher.style.right = "auto";
        launcher.style.bottom = "auto";
      }

      async function openPanel() {
        const draft = await getDraft(false);
        state.lastDraft = draft;
        console.info("[TapNow Companion] local draft", {
          ...draft,
          imageMaterials: (draft.imageMaterials || []).map((image) => ({
            ...image,
            dataUrl: image.dataUrl ? `[${image.dataUrl.length} chars]` : undefined
          }))
        });
        const sequence = ++state.reviewSequence;
        panel.classList.remove("hidden");
        render(draft, reviewDraft(draft, state.settings));
        if (
          state.settings.llmIncludeImages &&
          (draft.imageMaterials?.length || 0) > 0
        ) {
          const preparedDraft = await prepareDraftImages(draft);
          if (
            sequence === state.reviewSequence &&
            !panel.classList.contains("hidden")
          ) {
            state.lastDraft = preparedDraft;
            render(
              preparedDraft,
              reviewDraft(preparedDraft, state.settings),
              null,
              "",
              true
            );
          }
        }
      }

      async function detect() {
        detectButton.disabled = true;
        const sequence = ++state.reviewSequence;
        const prepareImages = state.settings.llmIncludeImages;
        const baseDraft = state.lastDraft || (await getDraft(false));
        const draft = prepareImages
          ? await prepareDraftImages(baseDraft)
          : baseDraft;
        state.lastDraft = draft;
        const local = reviewDraft(draft, state.settings);
        console.info("[TapNow Companion] detect request", {
          draft: {
            ...draft,
            imageMaterials: (draft.imageMaterials || []).map((image) => ({
              ...image,
              dataUrl: image.dataUrl ? `[${image.dataUrl.length} chars]` : undefined
            }))
          },
          local
        });
        panel.classList.remove("hidden");
        render(draft, local, null, "", prepareImages);
        if (!state.settings.llmEnabled) {
          render(
            draft,
            local,
            null,
            "LLM 审阅未启用，请在扩展 popup 中开启。",
            prepareImages
          );
          detectButton.disabled = false;
          return;
        }
        body.insertAdjacentHTML(
          "beforeend",
          `<div class="notice">正在请求 LLM 审阅...</div>`
        );
        try {
          const response = (await browser.runtime.sendMessage({
            type: "tapnow:llm-review",
            draft
          })) as LlmResponse;
          if (sequence === state.reviewSequence) {
            render(
              draft,
              local,
              response?.ok ? response.result || null : null,
              response?.error || "",
              prepareImages,
              true
            );
            console.info("[TapNow Companion] LLM result", response);
          }
        } catch (error) {
          if (sequence === state.reviewSequence) {
            render(
              draft,
              local,
              null,
              error instanceof Error ? error.message : String(error),
              prepareImages,
              true
            );
          }
        } finally {
          detectButton.disabled = false;
        }
      }

      function closePanel() {
        panel.classList.add("hidden");
        state.reviewSequence++;
      }

      function loadLauncherPosition() {
        void browser.storage.local.get({ launcherPosition: null }).then((value) => {
          const position = value.launcherPosition as {
            left?: number;
            top?: number;
          } | null;
          if (typeof position?.left === "number" && typeof position?.top === "number") {
            applyLauncherPosition(position.left, position.top);
          }
        });
      }

      launcher.addEventListener("pointerdown", (event) => {
        state.dragging = true;
        state.movedDuringDrag = false;
        state.dragStartX = event.clientX;
        state.dragStartY = event.clientY;
        const rect = launcher.getBoundingClientRect();
        state.dragOriginLeft = rect.left;
        state.dragOriginTop = rect.top;
        launcher.classList.add("dragging");
        launcher.setPointerCapture(event.pointerId);
      });
      launcher.addEventListener("pointermove", (event) => {
        if (!state.dragging) return;
        const deltaX = event.clientX - state.dragStartX;
        const deltaY = event.clientY - state.dragStartY;
        if (Math.abs(deltaX) + Math.abs(deltaY) > 4) state.movedDuringDrag = true;
        applyLauncherPosition(
          state.dragOriginLeft + deltaX,
          state.dragOriginTop + deltaY
        );
      });
      launcher.addEventListener("pointerup", (event) => {
        if (!state.dragging) return;
        state.dragging = false;
        launcher.classList.remove("dragging");
        launcher.releasePointerCapture(event.pointerId);
        if (state.movedDuringDrag) {
          state.suppressNextClick = true;
          const rect = launcher.getBoundingClientRect();
          void browser.storage.local.set({
            launcherPosition: { left: rect.left, top: rect.top }
          });
        }
      });
      launcher.addEventListener("click", () => {
        if (state.suppressNextClick) {
          state.suppressNextClick = false;
          return;
        }
        void openPanel();
      });
      close.addEventListener("click", closePanel);
      closeAction.addEventListener("click", closePanel);
      detectButton.addEventListener("click", () => void detect());

      document.addEventListener("focusin", (event) => {
        rememberActive(event.target as Element | null);
      }, true);
      document.addEventListener("pointerdown", (event) => {
        rememberActive(event.target as Element | null);
      }, true);

      void browser.storage.sync.get(DEFAULT_SETTINGS).then((settings) => {
        state.settings = normalizeSettings(settings);
        host.style.display = state.settings.enabled ? "" : "none";
      });
      loadLauncherPosition();
    };

    mount();
    window.setInterval(mount, 1000);
  }
});
