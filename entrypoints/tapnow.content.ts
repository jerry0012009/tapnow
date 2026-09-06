import { browser } from "wxt/browser";
import {
  DEFAULT_SETTINGS,
  normalizeSettings,
  reviewDraft,
  inferPromptFromNodeText,
  inferNodeTypeFromId,
  type LocalReview,
  type ReviewConnectionInfo,
  type ReviewDraft,
  type ReviewNodeInfo,
  type ReviewSettings
} from "../utils/reviewer";
import {
  buildReferenceBindings,
  relationsFromPayload,
  snapshotFromPayload,
  toReviewConnectionInfo,
  toReviewNodeInfo,
  type TapNowApiNode,
  type TapNowCanvasSnapshot
} from "../utils/tapnow";
import { reviewPayloadStats } from "../utils/llm";
import {
  MAX_REVIEW_IMAGE_MATERIALS,
  MAX_REVIEW_PROMPT_CHARS,
  MAX_REVIEW_TEXT_MATERIAL_ITEM_CHARS,
  MAX_REVIEW_TEXT_MATERIALS,
  MAX_REVIEW_UPSTREAM_CHARS,
  MAX_SINGLE_IMAGE_BYTES,
  selectPreparedImages
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
        const output = element.querySelector(
          "[data-testid='canvas-node-text-content']"
        );
        const clone = (
          output ? output.cloneNode(true) : element.cloneNode(true)
        ) as Element;
        clone
          .querySelectorAll(
            "button, [role=button], script, style, " +
              "[data-testid='canvas-node-generation-input-bar'], " +
              "[data-testid='canvas-node-title'], input, textarea, " +
              "[contenteditable=true]"
          )
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

      function nodeTypeOf(element: Element | null): string | null {
        if (!element) return null;
        const nodeId = getNodeId(element);
        return (
          element.getAttribute("data-node-type") ||
          element.getAttribute("data-type") ||
          inferNodeTypeFromId(nodeId)
        )
          ?.toLowerCase() || null;
      }

      function domNodeInfo(element: Element): ReviewNodeInfo | null {
        const id = getNodeId(element);
        if (!id) return null;
        const nodeType = nodeTypeOf(element);
        const media = [...element.querySelectorAll("img")]
          .filter(
            (image) =>
              visible(image) &&
              image.naturalWidth >= 64 &&
              image.naturalHeight >= 64 &&
              !image.closest(
                "[data-testid='canvas-node-generation-input-bar']"
              )
          )
          .map((image) => ({
            url: sourceImageUrl(image.currentSrc || image.src),
            width: image.naturalWidth,
            height: image.naturalHeight
          }))
          .filter((item) => /^https?:\/\//i.test(item.url));
        return {
          id,
          canvasId: null,
          nodeType,
          dataType: null,
          title: null,
          shortId: null,
          data: {},
          prompt: "",
          text: nodeType === "text" ? nodeTextOf(element) : "",
          params: null,
          media,
          taskStatus: null,
          position: { x: null, y: null },
          measured: { width: null, height: null },
          dimensions: { width: null, height: null },
          parentId: null,
          extent: null,
          sourcePosition: null,
          targetPosition: null,
          sessionId: null,
          createdBy: null,
          createdByRole: null,
          createdAt: null,
          updatedAt: null
        };
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

      function outgoingNodeIds(nodeId: string | null): string[] {
        if (!nodeId) return [];
        const result: string[] = [];
        for (const edge of document.querySelectorAll("[aria-label^='Edge from ']")) {
          const label = edge.getAttribute("aria-label") || "";
          const match = label.match(/^Edge from (.+) to (.+)$/);
          if (match?.[1] === nodeId) result.push(match[2]);
        }
        return [...new Set(result)];
      }

      function domConnectionsFor(
        nodeId: string | null,
        direction: "incoming" | "outgoing"
      ): ReviewConnectionInfo[] {
        if (!nodeId) return [];
        const result: ReviewConnectionInfo[] = [];
        for (const edge of document.querySelectorAll("[aria-label^='Edge from ']")) {
          const label = edge.getAttribute("aria-label") || "";
          const match = label.match(/^Edge from (.+) to (.+)$/);
          if (!match) continue;
          const source = match[1];
          const target = match[2];
          if (
            (direction === "incoming" && target !== nodeId) ||
            (direction === "outgoing" && source !== nodeId)
          ) {
            continue;
          }
          const id =
            edge.getAttribute("data-id") ||
            `dom-edge-${source}-${target}`;
          result.push({
            id,
            source,
            target,
            sourceHandle: null,
            targetHandle: null,
            label: ""
          });
        }
        return result;
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

      function captureSourceUrl(value: string): string {
        const source = sourceImageUrl(value);
        try {
          const parsed = new URL(source);
          if (parsed.hostname === "files.tapnow.top") {
            parsed.hostname = "files.tapnow.media";
          }
          return parsed.toString();
        } catch {
          return source;
        }
      }

      function promptValue(value: unknown): string {
        const prompt = inferPromptFromNodeText(value);
        return prompt === "/" || prompt === "-" ? "" : prompt;
      }

      function opaquePromptReason(value: string): string | null {
        if (/^[a-f0-9]{32}$/i.test(value)) {
          return "仅包含 32 位内部哈希，未作为用户提示词使用。";
        }
        if (/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value)) {
          return "仅包含内部 UUID，未作为用户提示词使用。";
        }
        return null;
      }

      function imageIdentity(value: string): string {
        try {
          const parsed = new URL(sourceImageUrl(value));
          parsed.searchParams.delete("tap_mx");
          if (/^files\.tapnow\.(?:media|top)$/i.test(parsed.hostname)) {
            return parsed.pathname;
          }
          return parsed.toString();
        } catch {
          return value;
        }
      }

      async function fetchCanvasSnapshot(
        canvasId: string
      ): Promise<{
        snapshot: TapNowCanvasSnapshot;
        endpoint: string;
        relationsEndpoint: string;
        relationsError: string;
      }> {
        const endpoint = new URL(
          `/api/canvas/v1/canvases/${encodeURIComponent(
            canvasId
          )}?with_nodes=true&with_connections=true`,
          location.origin
        ).toString();
        const accessToken = localStorage.getItem("access_token");
        if (!accessToken) {
          throw new Error("TapNow 页面没有可用的登录会话。");
        }
        const response = await fetch(endpoint, {
          credentials: "include",
          headers: { Authorization: `Bearer ${accessToken}` }
        });
        if (!response.ok) {
          throw new Error(`TapNow 画布接口 HTTP ${response.status}`);
        }
        const snapshot = snapshotFromPayload(await response.json());
        if (!snapshot) {
          throw new Error("TapNow 画布接口没有返回节点和连线数据。");
        }

        const relationsEndpoint = new URL(
          `/api/canvas/v1/canvases/${encodeURIComponent(
            canvasId
          )}/nodes?limit=1000&include_relations=true`,
          location.origin
        ).toString();
        let relationsError = "";
        try {
          const relationsResponse = await fetch(relationsEndpoint, {
            credentials: "include",
            headers: { Authorization: `Bearer ${accessToken}` }
          });
          if (!relationsResponse.ok) {
            throw new Error(
              `TapNow 节点关系接口 HTTP ${relationsResponse.status}`
            );
          }
          snapshot.relations =
            relationsFromPayload(await relationsResponse.json()) || undefined;
          if (!snapshot.relations) {
            throw new Error("TapNow 节点关系接口没有返回 relations。");
          }
        } catch (error) {
          relationsError =
            error instanceof Error ? error.message : String(error);
        }
        return {
          snapshot,
          endpoint,
          relationsEndpoint,
          relationsError
        };
      }

      function focusedReferenceUrls(element: Element | null): string[] {
        if (!element) return [];
        return [...element.querySelectorAll(
          "[data-testid='canvas-node-generation-input-bar'] img"
        )]
          .filter(visible)
          .map((image) =>
            ({
              image,
              url: sourceImageUrl(
                image.currentSrc || image.getAttribute("src") || ""
              )
            })
          )
          .filter(
            ({ image, url }) =>
              image.naturalWidth >= 64 &&
              image.naturalHeight >= 64 &&
              /^https?:\/\//i.test(url)
          )
          .map(({ url }) => url)
          .filter(Boolean);
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
        sourceUrl?: string;
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
          typeof image === "string"
            ? captureSourceUrl(image)
            : captureSourceUrl(image.currentSrc || image.src);
        try {
          const response = await fetch(source, { credentials: "include" });
          if (response.ok) {
            const blob = await response.blob();
            if (blob.size <= MAX_SINGLE_IMAGE_BYTES) {
              return {
                dataUrl: await blobToDataUrl(blob),
                sourceUrl: source,
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
                sourceUrl: source,
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
                sourceUrl: source,
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
            sourceUrl?: string;
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
                sourceUrl: response.sourceUrl || source,
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
        // TapNow's selected node is the authoritative focus. The pointer event
        // can be swallowed by a scaled image child, leaving our remembered
        // node one interaction behind.
        const selectedNode = document.querySelector(".react-flow__node.selected");
        const rememberedNode =
          selectedNode ||
          (state.activeNode && document.contains(state.activeNode)
            ? state.activeNode
            : findNodeById(state.activeNodeId));
        const nodeElement = rememberedNode || (field ? nodeFor(field) : null);
        const nodeId = getNodeId(nodeElement) || state.activeNodeId;
        const domNodeType = nodeTypeOf(nodeElement);
        const currentNodeText = nodeTextOf(nodeElement);
        const fieldIsPrompt = Boolean(
          field?.closest(
            "[data-testid='canvas-node-prompt-textarea'], " +
              "[data-testid='canvas-node-generation-input-bar']"
          )
        );
        const fieldPrompt = fieldIsPrompt ? promptValue(textOf(field)) : "";
        const canvasId =
          location.pathname.split("/").filter(Boolean).pop() || null;
        let apiSnapshot: TapNowCanvasSnapshot | null = null;
        let apiEndpoint = "";
        let apiSnapshotError = "";
        let apiRelationsEndpoint = "";
        let apiRelationsError = "";
        if (canvasId && nodeId) {
          try {
            const result = await fetchCanvasSnapshot(canvasId);
            apiSnapshot = result.snapshot;
            apiEndpoint = result.endpoint;
            apiRelationsEndpoint = result.relationsEndpoint;
            apiRelationsError = result.relationsError;
          } catch (error) {
            apiSnapshotError =
              error instanceof Error ? error.message : String(error);
            console.info("[TapNow Companion] canvas API unavailable", {
              error: apiSnapshotError
            });
          }
        }

        const apiNodeMap = new Map(
          (apiSnapshot?.nodes || [])
            .map((node) => [String(node.id || ""), node] as const)
            .filter(([id]) => Boolean(id))
        );
        const apiFocusRecord = nodeId
          ? apiNodeMap.get(nodeId) || null
          : null;
        const apiFocusInfo = apiFocusRecord
          ? toReviewNodeInfo(apiFocusRecord, sourceImageUrl)
          : null;
        const nodeType =
          domNodeType ||
          apiFocusInfo?.nodeType ||
          inferNodeTypeFromId(nodeId);
        const apiIncomingConnectionsUnordered = (apiSnapshot?.connections || [])
          .filter((connection) => String(connection.target || "") === nodeId)
          .map(toReviewConnectionInfo)
          .filter((connection): connection is ReviewConnectionInfo =>
            Boolean(connection)
          );
        const relationIncomingIds =
          (nodeId && apiSnapshot?.relations?.[nodeId]?.incoming) || [];
        const incomingRelationRank = new Map(
          relationIncomingIds.map((sourceId, index) => [sourceId, index] as const)
        );
        // The canvas endpoint keeps connection order stable. The relations
        // endpoint does not: its peer arrays can arrive in a different order
        // between identical requests, so it must not define Image N mapping.
        const apiIncomingConnections = apiIncomingConnectionsUnordered;
        const apiIncomingRecords = apiIncomingConnections
          .map((connection) => apiNodeMap.get(connection.source))
          .filter((node): node is TapNowApiNode => Boolean(node));
        const apiIncomingInfos = apiIncomingRecords
          .map((node) => toReviewNodeInfo(node, sourceImageUrl))
          .filter((node): node is ReviewNodeInfo => Boolean(node));
        const domConnectedNodes = incomingNodeIds(nodeId)
          .map((sourceId) => findNodeById(sourceId))
          .filter((node): node is Element => Boolean(node));
        const apiOutgoingConnectionsUnordered = (apiSnapshot?.connections || [])
          .filter((connection) => String(connection.source || "") === nodeId)
          .map(toReviewConnectionInfo)
          .filter((connection): connection is ReviewConnectionInfo =>
            Boolean(connection)
          );
        const apiOutgoingConnections = apiOutgoingConnectionsUnordered;
        const apiOutgoingRecords = apiOutgoingConnections
          .map((connection) => apiNodeMap.get(connection.target))
          .filter((node): node is TapNowApiNode => Boolean(node));
        const apiOutgoingInfos = apiOutgoingRecords
          .map((node) => toReviewNodeInfo(node, sourceImageUrl))
          .filter((node): node is ReviewNodeInfo => Boolean(node));
        const domOutgoingNodes = outgoingNodeIds(nodeId)
          .map((targetId) => findNodeById(targetId))
          .filter((node): node is Element => Boolean(node));
        const incomingCandidateInfos = [
          ...new Map(
            [
              ...domConnectedNodes
                .map(domNodeInfo)
                .filter((node): node is ReviewNodeInfo => Boolean(node)),
              ...apiIncomingInfos
            ].map((info) => [info.id, info] as const)
          ).values()
        ];
        const outgoingCandidateInfos = [
          ...new Map(
            [
              ...domOutgoingNodes
                .map(domNodeInfo)
                .filter((node): node is ReviewNodeInfo => Boolean(node)),
              ...apiOutgoingInfos
            ].map((info) => [info.id, info] as const)
          ).values()
        ];
        const domReferenceUrls = focusedReferenceUrls(nodeElement);
        const domReferenceOrder = domReferenceUrls.map(imageIdentity);
        const domReferenceRank = new Map(
          domReferenceOrder.map((key, index) => [key, index] as const)
        );
        const incomingInfos = [...incomingCandidateInfos].sort((left, right) => {
          const leftRank = Math.min(
            ...left.media.map((media) => domReferenceRank.get(
              imageIdentity(media.url)
            ) ?? Number.MAX_SAFE_INTEGER)
          );
          const rightRank = Math.min(
            ...right.media.map((media) => domReferenceRank.get(
              imageIdentity(media.url)
            ) ?? Number.MAX_SAFE_INTEGER)
          );
          const leftConnectionRank = apiIncomingConnections.findIndex(
            (connection) => connection.source === left.id
          );
          const rightConnectionRank = apiIncomingConnections.findIndex(
            (connection) => connection.source === right.id
          );
          const leftFallbackRank =
            leftConnectionRank >= 0
              ? leftConnectionRank
              : incomingRelationRank.get(left.id) ?? Number.MAX_SAFE_INTEGER;
          const rightFallbackRank =
            rightConnectionRank >= 0
              ? rightConnectionRank
              : incomingRelationRank.get(right.id) ?? Number.MAX_SAFE_INTEGER;
          return leftRank - rightRank || leftFallbackRank - rightFallbackRank;
        });
        const incomingNodeRank = new Map(
          incomingInfos.map((info, index) => [info.id, index] as const)
        );
        const incomingConnectionCandidates = [
          ...new Map(
            [
              ...apiIncomingConnections,
              ...domConnectionsFor(nodeId, "incoming")
            ].map((connection) => [connection.id, connection] as const)
          ).values()
        ];
        const incomingConnections = incomingConnectionCandidates.sort(
          (left, right) =>
            (incomingNodeRank.get(left.source) ?? Number.MAX_SAFE_INTEGER) -
            (incomingNodeRank.get(right.source) ?? Number.MAX_SAFE_INTEGER)
        );
        const outgoingNodes = [...outgoingCandidateInfos];
        const outgoingNodeRank = new Map(
          outgoingNodes.map((info, index) => [info.id, index] as const)
        );
        const outgoingConnectionCandidates = [
          ...new Map(
            [
              ...apiOutgoingConnections,
              ...domConnectionsFor(nodeId, "outgoing")
            ].map((connection) => [connection.id, connection] as const)
          ).values()
        ];
        const outgoingConnections = outgoingConnectionCandidates.sort(
          (left, right) =>
            (outgoingNodeRank.get(left.target) ?? Number.MAX_SAFE_INTEGER) -
            (outgoingNodeRank.get(right.target) ?? Number.MAX_SAFE_INTEGER)
        );
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

        const apiPrompt = promptValue(apiFocusInfo?.prompt);
        const apiOutputText = apiFocusInfo?.text || "";
        const domCurrentPrompt =
          nodeType === "text" ? promptValue(currentNodeText) : "";
        const promptCandidates = [
          { source: "focused-node-input", value: fieldPrompt },
          { source: "tapnow-api.node.data.prompt", value: apiPrompt },
          {
            source: "tapnow-api.node.data.text",
            value: nodeType === "text" ? apiOutputText : ""
          },
          {
            source: "focused-node-dom",
            value: apiFocusInfo ? "" : domCurrentPrompt
          }
        ]
          .map((candidate) => ({
            ...candidate,
            selected: false,
            ignoredReason: candidate.value
              ? opaquePromptReason(candidate.value)
              : "该来源没有可用值。"
          }));
        const selectedPromptCandidate =
          promptCandidates.find(
            (candidate) => Boolean(candidate.value) && !candidate.ignoredReason
          ) || null;
        if (selectedPromptCandidate) selectedPromptCandidate.selected = true;
        const currentPrompt = selectedPromptCandidate?.value || "";
        for (const connectedInfo of incomingInfos) {
          if (connectedInfo.nodeType !== "text") continue;
          const connectedText = connectedInfo.text;
          if (!connectedText) continue;
          addText(connectedText, {
            nodeId: connectedInfo.id,
            nodeType: connectedInfo.nodeType,
            role: "upstream-node-output"
          });
        }
        if (!apiSnapshot) {
          for (const connectedNode of domConnectedNodes) {
            if (nodeTypeOf(connectedNode) !== "text") continue;
            const connectedText = nodeTextOf(connectedNode);
            if (!connectedText) continue;
            addText(connectedText, {
              nodeId: getNodeId(connectedNode),
              nodeType: nodeTypeOf(connectedNode),
              role: "upstream-node-output"
            });
          }
        }

        const prompt = (
          currentPrompt ||
          textMaterials[0] ||
          ""
        ).slice(0, MAX_REVIEW_PROMPT_CHARS);
        const promptSource = currentPrompt
          ? selectedPromptCandidate?.source || null
          : textMaterials[0]
            ? "direct-upstream-text-output"
            : null;
        const referenceSources: Array<{
          info: ReviewNodeInfo | null;
          url: string;
          alt?: string;
          width?: number | null;
          height?: number | null;
        }> = [];
        const addReferenceSource = (candidate: {
          info: ReviewNodeInfo | null;
          url: string;
          alt?: string;
          width?: number | null;
          height?: number | null;
        }) => {
          const url = sourceImageUrl(candidate.url).slice(0, 2_000);
          if (!/^https?:\/\//i.test(url)) return;
          const key = imageIdentity(url);
          if (referenceSources.some((source) => imageIdentity(source.url) === key)) {
            return;
          }
          referenceSources.push({ ...candidate, url });
        };
        if (domReferenceUrls.length) {
          for (const domUrl of domReferenceUrls) {
            const referenceKey = imageIdentity(domUrl);
            const matchingInfo =
              incomingInfos.find((info) =>
                info.media.some(
                  (media) => imageIdentity(media.url) === referenceKey
                )
              ) || null;
            const matchingMedia = matchingInfo?.media.find(
              (media) => imageIdentity(media.url) === referenceKey
            );
            addReferenceSource({
              info: matchingInfo,
              url: domUrl,
              alt: "referenceImage",
              width: matchingMedia?.width,
              height: matchingMedia?.height
            });
          }
        } else {
          for (const info of incomingInfos) {
            if (!info.media.length) continue;
            const media = info.media[0];
            addReferenceSource({
              info,
              url: media.url,
              alt: "referenceImage",
              width: media.width,
              height: media.height
            });
          }
        }
        if (!apiSnapshot) {
          for (const connectedNode of domConnectedNodes) {
            const image = [...connectedNode.querySelectorAll("img")]
              .filter(visible)
              .find(
                (candidate) =>
                  candidate.naturalWidth >= 64 && candidate.naturalHeight >= 64
              );
            if (!image) continue;
            addReferenceSource({
              info: domNodeInfo(connectedNode),
              url: image.currentSrc || image.src,
              alt: "referenceImage",
              width: image.naturalWidth,
              height: image.naturalHeight
            });
          }
        }

        const outputSources: Array<{
          url: string;
          alt?: string;
          width?: number | null;
          height?: number | null;
        }> = [];
        const addOutputSource = (candidate: {
          url: string;
          alt?: string;
          width?: number | null;
          height?: number | null;
        }) => {
          const url = sourceImageUrl(candidate.url).slice(0, 2_000);
          if (!/^https?:\/\//i.test(url)) return;
          if (outputSources.some((source) => imageIdentity(source.url) === imageIdentity(url))) {
            return;
          }
          outputSources.push({ ...candidate, url });
        };
        for (const media of apiFocusInfo?.media || []) {
          addOutputSource(media);
        }
        if (nodeElement) {
          for (const image of [...nodeElement.querySelectorAll("img")]) {
            if (
              !visible(image) ||
              image.naturalWidth < 64 ||
              image.naturalHeight < 64 ||
              image.closest(
                "[data-testid='canvas-node-generation-input-bar']"
              )
            ) {
              continue;
            }
            addOutputSource({
              url: image.currentSrc || image.src,
              alt: image.alt,
              width: image.naturalWidth,
              height: image.naturalHeight
            });
          }
        }

        const imageMaterials: NonNullable<ReviewDraft["imageMaterials"]> = [];
        const seenImages = new Set<string>();
        const addImageMaterial = async (candidate: {
          url: string;
          alt?: string;
          width?: number | null;
          height?: number | null;
          sourceNodeId?: string | null;
          sourceNodeType?: string | null;
          sourceTitle?: string | null;
          role: string;
        }) => {
          if (imageMaterials.length >= MAX_REVIEW_IMAGE_MATERIALS) return null;
          const url = sourceImageUrl(candidate.url).slice(0, 2_000);
          const imageKey = imageIdentity(url);
          if (!/^https?:\/\//i.test(url) || seenImages.has(imageKey)) return null;
          seenImages.add(imageKey);
          const material: NonNullable<
            ReviewDraft["imageMaterials"]
          >[number] = {
            materialId: `image-${imageMaterials.length + 1}`,
            url,
            alt: (candidate.alt || "").slice(0, 300),
            width: candidate.width || null,
            height: candidate.height || null,
            sourceNodeId: candidate.sourceNodeId || null,
            sourceNodeType: candidate.sourceNodeType || null,
            sourceTitle: candidate.sourceTitle || null,
            role: candidate.role
          };
          if (includeImageData) {
            const captured = await captureImage(url);
            material.dataUrl = captured.dataUrl;
            material.captureSourceUrl = captured.sourceUrl;
            material.captureError = captured.error;
            material.compression = captured.compression;
          }
          imageMaterials.push(material);
          return material;
        };

        const referenceMaterialIds: Array<string | null> = [];
        for (const source of referenceSources) {
          const material = await addImageMaterial({
            url: source.url,
            alt: source.alt,
            width: source.width,
            height: source.height,
            sourceNodeId: source.info?.id,
            sourceNodeType: source.info?.nodeType,
            sourceTitle: source.info?.title,
            role: "upstream-reference"
          });
          referenceMaterialIds.push(material?.materialId || null);
        }
        for (const source of outputSources) {
          await addImageMaterial({
            ...source,
            sourceNodeId: nodeId,
            sourceNodeType: nodeType,
            sourceTitle: apiFocusInfo?.title,
            role: "focused-node-output"
          });
        }
        const referenceBindings = buildReferenceBindings(
          prompt,
          referenceSources
            .map((source) => source.info)
            .filter((info): info is ReviewNodeInfo => Boolean(info)),
          referenceMaterialIds
        );
        for (const binding of referenceBindings) {
          const material = imageMaterials.find(
            (candidate) => candidate.materialId === binding.materialId
          );
          if (material) {
            material.reference = binding.reference;
            material.referenceIndex = Number(
              binding.reference.match(/\d+/)?.[0] || 0
            );
          }
        }
        const referenceNumberByNodeId = new Map(
          referenceSources
            .map((source, index) => [source.info?.id, index + 1] as const)
            .filter(([id]) => Boolean(id))
        );
        const upstreamSummaryParts: string[] = [];
        for (const info of incomingInfos) {
          if (info.nodeType === "text" && info.text) {
            upstreamSummaryParts.push(
              `[上游文字 ${info.id}${info.title ? ` / ${info.title}` : ""}]\n${info.text}`
            );
            continue;
          }
          if (info.media.length) {
            const referenceNumber = referenceNumberByNodeId.get(info.id);
            upstreamSummaryParts.push(
              `[引用图片${referenceNumber ? ` Image ${referenceNumber}` : ""} ${info.id}${info.title ? ` / ${info.title}` : ""}]`
            );
          }
        }

        return {
          canvasId,
          nodeId,
          nodeType,
          prompt,
          promptSource,
          promptCandidates,
          upstreamSummary: upstreamSummaryParts
            .join("\n\n")
            .slice(0, MAX_REVIEW_UPSTREAM_CHARS),
          textMaterials,
          textMaterialSources,
          imageMaterials,
          nodeInfo: apiFocusInfo,
          incomingNodes: incomingInfos,
          incomingConnections,
          outgoingNodes,
          outgoingConnections,
          referenceBindings,
          snapshot: {
            source: apiFocusInfo ? "tapnow-api" : "focused-page-dom",
            endpoint: apiEndpoint || null,
            nodeCount: apiSnapshot?.nodes.length ?? null,
            connectionCount: apiSnapshot?.connections.length ?? null,
            referenceOrderSource: domReferenceOrder.length
              ? "focused-node-dom"
              : apiIncomingConnections.length
                ? "tapnow-api-connections"
                : relationIncomingIds.length
                  ? "tapnow-api-relations-fallback"
                  : apiSnapshot
                    ? "tapnow-api-connections"
                    : "dom-edge-order",
            relationsEndpoint: apiRelationsEndpoint || null,
            relationsError: apiRelationsError || null,
            error: apiSnapshotError || null
          },
          fieldCount: textMaterials.length,
          source: apiFocusInfo
            ? "focused-page-node+tapnow-api"
            : "focused-page-node"
        };
      }

      async function prepareDraftImages(
        draft: ReviewDraft
      ): Promise<ReviewDraft> {
        if (!draft.imageMaterials?.length) return draft;
        const imageMaterials = [];
        for (const image of draft.imageMaterials) {
          if (image.dataUrl) {
            imageMaterials.push(image);
            continue;
          }
          const captured = await captureImage(image.url);
          imageMaterials.push({
            ...image,
            dataUrl: captured.dataUrl,
            captureSourceUrl: captured.sourceUrl,
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
        const referenceImageCount =
          draft.imageMaterials?.filter(
            (image) => image.role === "upstream-reference"
          ).length || 0;
        const outputImageCount =
          draft.imageMaterials?.filter(
            (image) => image.role === "focused-node-output"
          ).length || 0;
        const uploadable =
          draft.imageMaterials?.filter((image) => image.dataUrl).length || 0;
        const selectedImageIds = new Set(
          selectPreparedImages(draft.imageMaterials || []).map(
            ({ image }) => image.materialId
          )
        );
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
            ? `文字 ${draft.textMaterials?.length || 0} 项 · 图片 ${imageCount} 项（引用 ${referenceImageCount}，产物 ${outputImageCount}） · 可发送图片 ${payloadStats.sentCount} 项 · ${formatBytes(payloadStats.sentImageBytes)}`
            : `文字 ${draft.textMaterials?.length || 0} 项 · 图片 ${imageCount} 项（引用 ${referenceImageCount}，产物 ${outputImageCount}） · 正在检查图片可发送性`
          : `文字 ${draft.textMaterials?.length || 0} 项 · 图片 ${imageCount} 项（引用 ${referenceImageCount}，产物 ${outputImageCount}） · 图片发送未开启`;
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
          promptSource: draft.promptSource || null,
          promptCandidates: draft.promptCandidates || [],
          upstreamSummary: draft.upstreamSummary || "",
          textMaterials: draft.textMaterials || [],
          textMaterialSources: draft.textMaterialSources || [],
          nodeInfo: draft.nodeInfo || null,
          incomingNodes: draft.incomingNodes || [],
          incomingConnections: draft.incomingConnections || [],
          outgoingNodes: draft.outgoingNodes || [],
          outgoingConnections: draft.outgoingConnections || [],
          referenceBindings: draft.referenceBindings || [],
          snapshot: draft.snapshot || null,
          images: (draft.imageMaterials || []).map((image) => ({
            materialId: image.materialId || null,
            url: image.url,
            alt: image.alt || "",
            width: image.width || null,
            height: image.height || null,
            sourceNodeId: image.sourceNodeId || null,
            sourceNodeType: image.sourceNodeType || null,
            sourceTitle: image.sourceTitle || null,
            role: image.role || null,
            reference: image.reference || null,
            referenceIndex: image.referenceIndex || null,
            captureSourceUrl: image.captureSourceUrl || null,
            prepared: Boolean(image.dataUrl),
            selectedForRequest: selectedImageIds.has(image.materialId),
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
                summary: llm.summary,
                issues: llm.issues,
                suggestions: llm.suggestions,
                requestStats: llm.requestStats || null
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
