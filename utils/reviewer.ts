import { MAX_LLM_PROMPT_LENGTH } from "./limits";

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
  textMaterialSources?: Array<{
    nodeId?: string | null;
    nodeType?: string | null;
    role?: string;
  }>;
  imageMaterials?: Array<{
    materialId?: string;
    url: string;
    alt?: string;
    width?: number;
    height?: number;
    sourceNodeId?: string | null;
    sourceNodeType?: string | null;
    role?: string;
    dataUrl?: string;
    captureError?: string;
    compression?: {
      applied: boolean;
      method: string;
      originalBytes?: number | null;
      preparedBytes?: number | null;
    };
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
  llmPrompt: string;
  llmProtocol: "responses" | "chat_completions";
  llmModel: string;
  llmBaseUrl: string;
}

export const DEFAULT_LLM_PROMPT = [
  "审阅一个创作节点，帮助用户在运行前发现质量、上下文和团队风格问题。",
  "用户消息中的 image-1、image-2 等文字标记紧跟对应图片，必须按编号引用图片，不要混淆素材。",
  "只输出符合 JSON schema 的结果；不要改写原提示词，不要编造未提供的上下文。",
  "decision 只能是 allow、warn、block；普通质量问题用 warn，明显无法运行或违反规则用 block。"
].join(" ");

const DRAG_HELP_TEXT =
  "To pick up a draggable item, press the space bar. While dragging, use the arrow keys to move the item. Press space again to drop the item in its new position, or press escape to cancel.";

export function inferPromptFromNodeText(value: unknown): string {
  let text = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  text = text.replace(DRAG_HELP_TEXT, " ");
  text = text.replace(
    /描述任何你想要生成的内容，按@引用素材，\/呼出指令(?:\d+)?/g,
    " "
  );
  text = text.replace(
    /Describe anything you want to generate,? use @ to reference materials,? and? \/? to invoke commands?\d*/gi,
    " "
  );
  text = text.replace(
    /Describe anything you want to generate,\s*press\s*@\s*for context/gi,
    " "
  );
  text = text.replace(/双击开始编辑(?:\.\.\.|…)?/g, " ");
  text = text.replace(/Double-click to (?:start )?edit(?:ing)?(?:\.\.\.|…)?/gi, " ");
  text = text.replace(/^\s*(?:Text|Image|Video|Audio)(?:\s*Pin)?/i, " ");
  text = text.replace(/^\s*(?:图片生成|图像生成|Image generation)\s*/i, " ");
  text = text.replace(/^\s*Pin\b/i, " ");
  text = text.replace(
    /(?:Gemini|GPT|Claude|Flux|Midjourney|DALL[·\s-]?E|Stable Diffusion)\b.*$/i,
    " "
  );
  text = text.replace(/\s+\d+\s*[×x]\s*\d+\s*$/i, " ");
  text = text.replace(/\s*\d+\s*$/i, " ");
  text = text.replace(/\s+(?:-\s*){1,3}$/i, " ");
  text = text.replace(/-{1,3}\s*$/i, " ");
  return text.replace(/\s+/g, " ").trim();
}

export function inferNodeTypeFromId(value: unknown): string | null {
  const id = String(value ?? "").trim().toLowerCase();
  const match = id.match(/^([a-z][a-z0-9_]*)-/);
  return match?.[1] || null;
}

export const DEFAULT_SETTINGS: ReviewSettings = {
  enabled: true,
  requiredTerms: [],
  forbiddenTerms: [],
  llmEnabled: false,
  llmIncludeImages: false,
  llmPrompt: DEFAULT_LLM_PROMPT,
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
    llmPrompt: String(settings.llmPrompt || DEFAULT_LLM_PROMPT)
      .trim()
      .slice(0, MAX_LLM_PROMPT_LENGTH),
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
