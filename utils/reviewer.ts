export type ReviewSeverity = "block" | "warn";
export type ReviewDecision = "allow" | "warn" | "block";

export interface ReviewIssue {
  severity: ReviewSeverity;
  code: string;
  title: string;
  detail: string;
}

export interface ReviewDraft {
  canvasId?: string | null;
  nodeId?: string | null;
  nodeType?: string | null;
  prompt?: string;
  upstreamSummary?: string;
  textMaterials?: string[];
  imageMaterials?: Array<{
    url: string;
    alt?: string;
    width?: number;
    height?: number;
    dataUrl?: string;
  }>;
  fieldCount?: number;
  source?: string;
}

export interface LocalReview {
  decision: ReviewDecision;
  issues: ReviewIssue[];
  suggestions: string[];
  checkedAt: string;
}

export interface ReviewSettings {
  enabled: boolean;
  requiredTerms: string[];
  forbiddenTerms: string[];
  llmEnabled: boolean;
  llmIncludeImages: boolean;
  llmProtocol: "responses" | "chat_completions";
  llmModel: string;
  llmBaseUrl: string;
}

const DRAG_HELP_TEXT =
  "To pick up a draggable item, press the space bar. While dragging, use the arrow keys to move the item. Press space again to drop the item in its new position, or press escape to cancel.";

export function inferPromptFromNodeText(value: unknown): string {
  let text = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  text = text.replace(DRAG_HELP_TEXT, " ");
  text = text.replace(/双击开始编辑(?:\.\.\.|…)?/g, " ");
  text = text.replace(/Double-click to edit(?:\.\.\.|…)?/gi, " ");
  text = text.replace(/^(?:Text|Image|Video|Audio)\s*Pin\b/i, " ");
  text = text.replace(
    /(?:Gemini|GPT|Claude|Flux|Midjourney|DALL[·\s-]?E|Stable Diffusion)\b.*?\d+\s*[×x]\s*\d+\s*$/i,
    " "
  );
  text = text.replace(/\s+\d+\s*[×x]\s*\d+\s*$/i, " ");
  return text.replace(/\s+/g, " ").trim();
}

export const DEFAULT_SETTINGS: ReviewSettings = {
  enabled: true,
  requiredTerms: [],
  forbiddenTerms: [],
  llmEnabled: false,
  llmIncludeImages: false,
  llmProtocol: "responses",
  llmModel: "gpt-5.6-luna",
  llmBaseUrl: "https://api.acucompute.com/v1"
};

export function splitTerms(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((term) => String(term).trim()).filter(Boolean);
  }
  return String(value ?? "")
    .split(/[,，\n]/)
    .map((term) => term.trim())
    .filter(Boolean);
}

export function normalizeSettings(
  settings: Partial<ReviewSettings> = {}
): ReviewSettings {
  return {
    enabled: settings.enabled !== false,
    requiredTerms: splitTerms(settings.requiredTerms),
    forbiddenTerms: splitTerms(settings.forbiddenTerms),
    llmEnabled: settings.llmEnabled === true,
    llmIncludeImages: settings.llmIncludeImages === true,
    llmProtocol:
      settings.llmProtocol === "chat_completions"
        ? "chat_completions"
        : "responses",
    llmModel: String(settings.llmModel || DEFAULT_SETTINGS.llmModel).trim(),
    llmBaseUrl: String(settings.llmBaseUrl || DEFAULT_SETTINGS.llmBaseUrl)
      .trim()
      .replace(/\/+$/, "")
  };
}

export function reviewDraft(
  draft: ReviewDraft = {},
  settings: Partial<ReviewSettings> = DEFAULT_SETTINGS
): LocalReview {
  const normalized = normalizeSettings(settings);
  const prompt = String(draft.prompt ?? "").trim();
  const issues: ReviewIssue[] = [];
  const suggestions: string[] = [];

  if (!prompt) {
    issues.push({
      severity: "block",
      code: "empty-prompt",
      title: "提示词为空",
      detail: "没有检测到可审核的提示词。"
    });
    suggestions.push("补充这个节点的核心目标和输入内容。");
  }

  for (const term of normalized.forbiddenTerms) {
    if (term && prompt.toLocaleLowerCase().includes(term.toLocaleLowerCase())) {
      issues.push({
        severity: "block",
        code: "forbidden-term",
        title: `命中团队禁用词：${term}`,
        detail: "请移除或替换该词后再运行。"
      });
    }
  }

  for (const term of normalized.requiredTerms) {
    if (term && !prompt.toLocaleLowerCase().includes(term.toLocaleLowerCase())) {
      issues.push({
        severity: "warn",
        code: "missing-required-term",
        title: `缺少团队要求：${term}`,
        detail: "这是提醒，不会阻止本次运行。"
      });
    }
  }

  if (prompt && prompt.length < 12) {
    issues.push({
      severity: "warn",
      code: "short-prompt",
      title: "提示词较短",
      detail: "信息可能不足，结果稳定性可能较低。"
    });
    suggestions.push("补充主体、目标、环境或风格等关键信息。");
  }

  const decision: ReviewDecision = issues.some(
    (issue) => issue.severity === "block"
  )
    ? "block"
    : issues.length
      ? "warn"
      : "allow";

  return {
    decision,
    issues,
    suggestions: [...new Set(suggestions)],
    checkedAt: new Date().toISOString()
  };
}
