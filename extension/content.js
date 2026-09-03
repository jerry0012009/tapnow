(() => {
  const reviewer = globalThis.TapnowCompanionReviewer;
  if (!reviewer) return;

  const RUN_LABEL = /(运行|生成|执行|重试|run|generate|execute|rerun|create)/i;
  const IGNORE_LABEL = /(导出|下载|export|download|复制|copy|设置|settings)/i;
  const state = {
    settings: reviewer.DEFAULT_SETTINGS,
    pendingButton: null,
    bypassOnce: false,
    review: null
  };

  const host = document.createElement("div");
  host.id = "tapnow-companion-host";
  const shadow = host.attachShadow({ mode: "closed" });
  shadow.innerHTML = `
    <style>
      :host { all: initial; }
      .launcher {
        position: fixed; right: 20px; bottom: 20px; z-index: 2147483647;
        border: 1px solid #cbd5e1; border-radius: 999px; background: #0f172a;
        color: white; box-shadow: 0 8px 24px rgba(15, 23, 42, .22);
        padding: 10px 14px; font: 600 13px/1.2 system-ui, sans-serif;
        cursor: pointer;
      }
      .panel {
        position: fixed; top: 16px; right: 16px; bottom: 16px; width: min(390px, calc(100vw - 32px));
        z-index: 2147483646; display: flex; flex-direction: column;
        background: #f8fafc; color: #0f172a; border: 1px solid #cbd5e1;
        border-radius: 10px; box-shadow: 0 18px 50px rgba(15, 23, 42, .28);
        font: 14px/1.45 system-ui, -apple-system, sans-serif;
      }
      .hidden { display: none; }
      .header { display: flex; align-items: center; justify-content: space-between; padding: 16px; border-bottom: 1px solid #e2e8f0; }
      .header strong { font-size: 16px; }
      .close { border: 0; background: transparent; color: #475569; font-size: 20px; cursor: pointer; }
      .body { overflow: auto; padding: 16px; }
      .meta { color: #64748b; font-size: 12px; margin-bottom: 12px; word-break: break-all; }
      .label { color: #475569; font-size: 12px; font-weight: 700; margin: 14px 0 6px; }
      pre, .prompt, .context { white-space: pre-wrap; overflow-wrap: anywhere; background: white; border: 1px solid #e2e8f0; border-radius: 7px; padding: 10px; margin: 0; }
      .prompt { max-height: 150px; overflow: auto; }
      .context { max-height: 100px; overflow: auto; color: #475569; }
      .issue { border-left: 4px solid #f59e0b; background: #fffbeb; padding: 9px 10px; margin: 8px 0; border-radius: 5px; }
      .issue.block { border-left-color: #dc2626; background: #fef2f2; }
      .issue.allow { border-left-color: #16a34a; background: #f0fdf4; }
      .issue strong { display: block; margin-bottom: 2px; }
      .suggestion { color: #334155; margin: 7px 0; }
      .footer { display: flex; gap: 8px; padding: 14px 16px; border-top: 1px solid #e2e8f0; }
      button.action { flex: 1; min-height: 38px; border: 1px solid #cbd5e1; border-radius: 7px; cursor: pointer; font: 600 13px system-ui, sans-serif; }
      button.primary { background: #2563eb; color: white; border-color: #2563eb; }
      button.danger { background: #fff; color: #991b1b; }
      .notice { color: #64748b; font-size: 12px; margin-top: 10px; }
    </style>
    <button class="launcher" type="button">副驾驶</button>
    <section class="panel hidden" aria-label="TapNow Companion 审核面板">
      <header class="header">
        <strong>运行前审核</strong>
        <button class="close" type="button" aria-label="关闭">×</button>
      </header>
      <div class="body"></div>
      <footer class="footer">
        <button class="action danger cancel" type="button">取消</button>
        <button class="action primary approve" type="button">继续运行</button>
      </footer>
    </section>
  `;

  document.documentElement.append(host);
  const launcher = shadow.querySelector(".launcher");
  const panel = shadow.querySelector(".panel");
  const body = shadow.querySelector(".body");
  const close = shadow.querySelector(".close");
  const cancel = shadow.querySelector(".cancel");
  const approve = shadow.querySelector(".approve");

  function textOf(element) {
    return (element?.innerText || element?.textContent || element?.value || "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function getNodeId(element) {
    let current = element;
    for (let depth = 0; current && depth < 8; depth++, current = current.parentElement) {
      for (const name of ["data-node-id", "data-id", "data-node"]) {
        const value = current.getAttribute?.(name);
        if (value && value.length < 200) return value;
      }
    }
    return null;
  }

  function getDraft() {
    const fields = [...document.querySelectorAll("textarea, input:not([type=hidden]), [contenteditable=true]")]
      .filter((element) => {
        const style = getComputedStyle(element);
        return style.display !== "none" && style.visibility !== "hidden";
      })
      .map((element) => ({
        value: textOf(element),
        placeholder: element.getAttribute("placeholder") || "",
        element
      }))
      .filter((field) => field.value || field.placeholder)
      .sort((a, b) => b.value.length - a.value.length);

    const focused = document.activeElement;
    const primary = fields.find((field) => field.element === focused) || fields[0];
    const nodeId = getNodeId(primary?.element || focused);
    const nodeElement = primary?.element?.closest?.("[data-node-id], [data-id], [data-node]") || primary?.element?.parentElement;
    const nearbyText = textOf(nodeElement).slice(0, 1200);
    const nodeType = String(
      nodeElement?.getAttribute?.("data-node-type") ||
      nodeElement?.getAttribute?.("data-type") ||
      ""
    ).toLowerCase() || null;

    return {
      canvasId: location.pathname.split("/").filter(Boolean).pop() || null,
      nodeId,
      nodeType,
      prompt: primary?.value || "",
      placeholder: primary?.placeholder || "",
      upstreamSummary: nearbyText,
      fieldCount: fields.length,
      source: "visible-page-dom"
    };
  }

  function candidateButton(element) {
    const button = element?.closest?.("button, [role=button]");
    if (!button || host.contains(button)) return null;
    const label = textOf(button) || button.getAttribute("aria-label") || button.getAttribute("title") || "";
    if (!label || IGNORE_LABEL.test(label) || !RUN_LABEL.test(label)) return null;
    return button;
  }

  function render(draft, result) {
    const decisionLabel = result.decision === "block"
      ? "需要修改后再运行"
      : result.decision === "warn"
        ? "发现提醒，请确认"
        : "未发现本地规则问题";
    const issueHtml = result.issues.length
      ? result.issues.map((issue) => `
          <div class="issue ${issue.severity}">
            <strong>${escapeHtml(issue.title)}</strong>
            <span>${escapeHtml(issue.detail)}</span>
          </div>`).join("")
      : `<div class="issue allow"><strong>${decisionLabel}</strong><span>当前只执行本地检查。</span></div>`;
    const suggestionsHtml = result.suggestions.length
      ? `<div class="label">建议</div>${result.suggestions.map((item) => `<div class="suggestion">• ${escapeHtml(item)}</div>`).join("")}`
      : "";

    body.innerHTML = `
      <div class="meta">画布：${escapeHtml(draft.canvasId || "未识别")}<br>节点：${escapeHtml(draft.nodeId || "未识别")}<br>来源：页面可见内容</div>
      <div class="label">检测到的输入</div>
      <div class="prompt">${escapeHtml(draft.prompt || draft.placeholder || "未检测到提示词")}</div>
      <div class="label">节点上下文</div>
      <div class="context">${escapeHtml(draft.upstreamSummary || "未检测到可见上下文；0.1 版本不读取内部 Token 或私有 API。")}</div>
      <div class="label">检查结果</div>
      ${issueHtml}
      ${suggestionsHtml}
      <div class="notice">0.1 版本只做本地规则审核，不会把提示词上传到外部服务。</div>
    `;
    approve.textContent = result.decision === "block" ? "强制运行" : "继续运行";
    approve.disabled = false;
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (character) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[character]));
  }

  function openReview(button = null) {
    state.pendingButton = button;
    const draft = getDraft();
    state.review = reviewer.reviewDraft(draft, state.settings);
    panel.classList.remove("hidden");
    render(draft, state.review);
  }

  function closePanel() {
    panel.classList.add("hidden");
    state.pendingButton = null;
    state.review = null;
  }

  function approveRun() {
    if (!state.pendingButton) {
      closePanel();
      return;
    }
    const button = state.pendingButton;
    closePanel();
    state.bypassOnce = true;
    button.click();
    setTimeout(() => {
      state.bypassOnce = false;
    }, 500);
  }

  launcher.addEventListener("click", () => openReview(findRunButton()));
  close.addEventListener("click", closePanel);
  cancel.addEventListener("click", closePanel);
  approve.addEventListener("click", approveRun);

  function findRunButton() {
    return [...document.querySelectorAll("button, [role=button]")]
      .map((element) => candidateButton(element))
      .find(Boolean) || null;
  }

  document.addEventListener("click", (event) => {
    if (state.bypassOnce || !state.settings.enabled || !state.settings.gateClicks) return;
    const button = candidateButton(event.target);
    if (!button) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    openReview(button);
  }, true);

  chrome.storage.sync.get(reviewer.DEFAULT_SETTINGS, (settings) => {
    state.settings = reviewer.normalizeSettings(settings);
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync") return;
    const next = { ...state.settings };
    for (const [key, change] of Object.entries(changes)) next[key] = change.newValue;
    state.settings = reviewer.normalizeSettings(next);
  });
})();
