import { browser } from "wxt/browser";
import {
  DEFAULT_SETTINGS,
  normalizeSettings,
  reviewDraft,
  inferPromptFromNodeText,
  type LocalReview,
  type ReviewDraft,
  type ReviewSettings
} from "../utils/reviewer";

interface LlmResponse {
  ok: boolean;
  error?: string;
  result?: {
    decision: "allow" | "warn" | "block";
    summary: string;
    issues: LocalReview["issues"];
    suggestions: string[];
    model: string;
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
        reviewSequence: 0
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
        image: HTMLImageElement
      ): Promise<string | undefined> {
        const source = image.currentSrc || image.src;
        try {
          const response = await fetch(source, { credentials: "include" });
          if (response.ok) {
            const blob = await response.blob();
            if (blob.size <= 4_000_000) return await blobToDataUrl(blob);
          }
        } catch {
          // Keep metadata when the media host rejects a cross-origin fetch.
        }
        try {
          const canvas = document.createElement("canvas");
          canvas.width = image.naturalWidth;
          canvas.height = image.naturalHeight;
          canvas.getContext("2d")?.drawImage(image, 0, 0);
          const dataUrl = canvas.toDataURL("image/jpeg", 0.8);
          return dataUrl.length <= 5_500_000 ? dataUrl : undefined;
        } catch {
          try {
            const response = (await browser.runtime.sendMessage({
              type: "tapnow:capture-image",
              url: source
            })) as { ok?: boolean; dataUrl?: string };
            return response?.ok && response.dataUrl ? response.dataUrl : undefined;
          } catch {
            return undefined;
          }
        }
      }

      async function getDraft(includeImageData = false): Promise<ReviewDraft> {
        const field =
          state.activeField && document.contains(state.activeField)
            ? state.activeField
            : null;
        const nodeElement =
          state.activeNode && document.contains(state.activeNode)
            ? state.activeNode
            : field
              ? nodeFor(field)
              : null;
        const nodeText = nodeTextOf(nodeElement);
        const prompt = textOf(field) || nodeText;
        const textMaterials = nodeElement
          ? [...nodeElement.querySelectorAll(
              "textarea, input:not([type=hidden]), [contenteditable=true]"
            )]
              .filter(visible)
              .map(textOf)
              .filter(Boolean)
              .slice(0, 8)
              .map((value) => value.slice(0, 1000))
          : prompt
            ? [prompt.slice(0, 1000)]
            : [];
        const imageElements = nodeElement
          ? [...nodeElement.querySelectorAll("img")]
              .filter(visible)
              .filter(
                (image) => image.naturalWidth >= 64 && image.naturalHeight >= 64
              )
              .slice(0, 6)
          : [];
        const imageMaterials: NonNullable<ReviewDraft["imageMaterials"]> = [];
        for (const image of imageElements) {
          const material: NonNullable<ReviewDraft["imageMaterials"]>[number] = {
            url: (image.currentSrc || image.src).slice(0, 2000),
            alt: (image.alt || "").slice(0, 300),
            width:
              image.naturalWidth || Math.round(image.getBoundingClientRect().width),
            height:
              image.naturalHeight || Math.round(image.getBoundingClientRect().height)
          };
          if (includeImageData) material.dataUrl = await captureImage(image);
          imageMaterials.push(material);
        }

        return {
          canvasId: location.pathname.split("/").filter(Boolean).pop() || null,
          nodeId: getNodeId(nodeElement),
          nodeType: (
            nodeElement?.getAttribute("data-node-type") ||
            nodeElement?.getAttribute("data-type") ||
            ""
          ).toLowerCase() || null,
          prompt,
          upstreamSummary: nodeText.slice(0, 1200),
          textMaterials,
          imageMaterials,
          fieldCount: textMaterials.length,
          source: "focused-page-node"
        };
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

      function render(
        draft: ReviewDraft,
        local: LocalReview,
        llm: LlmResponse["result"] | null = null,
        llmError = ""
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
        const materialSummary = state.settings.llmIncludeImages
          ? `文字 ${draft.textMaterials?.length || 0} 项 · 图片 ${imageCount} 项 · 已准备发送图片 ${uploadable} 项`
          : `文字 ${draft.textMaterials?.length || 0} 项 · 图片 ${imageCount} 项 · 图片发送未开启`;
        const imageNotice = state.settings.llmIncludeImages
          ? "点击“检测”才会调用 LLM；检测时会发送已准备的图片素材。"
          : "点击“检测”才会调用 LLM；当前未开启图片发送，只传图片元数据。";

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
        `;
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
        panel.classList.remove("hidden");
        render(draft, reviewDraft(draft, state.settings));
      }

      async function detect() {
        detectButton.disabled = true;
        const draft = await getDraft(state.settings.llmIncludeImages);
        const local = reviewDraft(draft, state.settings);
        panel.classList.remove("hidden");
        render(draft, local);
        if (!state.settings.llmEnabled) {
          render(
            draft,
            local,
            null,
            "LLM 审阅未启用，请在扩展 popup 中开启。"
          );
          detectButton.disabled = false;
          return;
        }
        const sequence = ++state.reviewSequence;
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
              response?.error || ""
            );
          }
        } catch (error) {
          if (sequence === state.reviewSequence) {
            render(
              draft,
              local,
              null,
              error instanceof Error ? error.message : String(error)
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
