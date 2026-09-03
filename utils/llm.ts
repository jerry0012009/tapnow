import type {
  ReviewDecision,
  ReviewDraft,
  ReviewIssue
} from "./reviewer";

export interface LlmReview {
  decision: ReviewDecision;
  summary: string;
  issues: ReviewIssue[];
  suggestions: string[];
  provider: string;
  model: string;
}

export interface LlmSettings {
  apiKey: string;
  includeImages: boolean;
  protocol: "responses" | "chat_completions";
  model: string;
  baseUrl: string;
}

interface LlmRequestOptions {
  fetchImpl?: typeof fetch;
  allowTestEndpoint?: boolean;
}

const SYSTEM_PROMPT = [
  "审阅一个创作节点，帮助用户在运行前发现质量、上下文和团队风格问题。",
  "只输出符合 JSON schema 的结果；不要改写原提示词，不要编造未提供的上下文。",
  "decision 只能是 allow、warn、block；普通质量问题用 warn，明显无法运行或违反规则用 block。"
].join(" ");

const REVIEW_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    decision: { type: "string", enum: ["allow", "warn", "block"] },
    summary: { type: "string" },
    issues: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          severity: { type: "string", enum: ["warn", "block"] },
          code: { type: "string" },
          title: { type: "string" },
          detail: { type: "string" }
        },
        required: ["severity", "code", "title", "detail"]
      }
    },
    suggestions: {
      type: "array",
      items: { type: "string" }
    }
  },
  required: ["decision", "summary", "issues", "suggestions"]
} as const;

function compactDraft(draft: ReviewDraft): string {
  return JSON.stringify({
    canvas_id: draft.canvasId ?? null,
    node_id: draft.nodeId ?? null,
    node_type: draft.nodeType ?? null,
    prompt: String(draft.prompt ?? "").slice(0, 4000),
    upstream_context: String(draft.upstreamSummary ?? "").slice(0, 2000),
    text_materials: (draft.textMaterials || []).slice(0, 8).map((item) => item.slice(0, 1000)),
    image_materials: (draft.imageMaterials || []).slice(0, 6).map((item) => ({
      url: item.url.slice(0, 2000),
      alt: String(item.alt || "").slice(0, 300),
      width: item.width || null,
      height: item.height || null,
      uploadable: Boolean(item.dataUrl)
    }))
  });
}

function imageUrls(draft: ReviewDraft, includeImages: boolean): string[] {
  if (!includeImages) return [];
  return (draft.imageMaterials || [])
    .map((item) => item.dataUrl || item.url)
    .filter((url) => /^(?:https?:\/\/|data:image\/)/i.test(url))
    .slice(0, 4);
}

function userContent(draft: ReviewDraft, includeImages: boolean) {
  const text = compactDraft(draft);
  return [
    { type: "text", text },
    ...imageUrls(draft, includeImages).map((url) => ({
      type: "image_url",
      image_url: { url }
    }))
  ];
}

function responseInput(draft: ReviewDraft, includeImages: boolean) {
  return [{
    role: "user",
    content: [
      { type: "input_text", text: compactDraft(draft) },
      ...imageUrls(draft, includeImages).map((url) => ({
        type: "input_image",
        image_url: url
      }))
    ]
  }];
}

function withoutStructuredOutput(body: Record<string, any>): Record<string, any> {
  const fallback = { ...body };
  delete fallback.response_format;
  delete fallback.text;
  return fallback;
}

function parseJson(
  text: string
): Omit<LlmReview, "provider" | "model"> {
  const parsed = JSON.parse(text);
  const decision: ReviewDecision = ["allow", "warn", "block"].includes(
    parsed.decision
  )
    ? parsed.decision
    : "warn";
  const issues: ReviewIssue[] = Array.isArray(parsed.issues)
    ? parsed.issues.slice(0, 8).map((issue: Partial<ReviewIssue>) => ({
        severity: issue.severity === "block" ? "block" : "warn",
        code: String(issue.code || "llm-review"),
        title: String(issue.title || "模型提醒"),
        detail: String(issue.detail || "")
      }))
    : [];
  const suggestions = Array.isArray(parsed.suggestions)
    ? parsed.suggestions.slice(0, 8).map((item: unknown) => String(item))
    : [];
  return {
    decision,
    summary: String(parsed.summary || "模型没有提供摘要。").slice(0, 1000),
    issues,
    suggestions
  };
}

function responseText(payload: any): string {
  if (typeof payload.output_text === "string") return payload.output_text;
  const output = Array.isArray(payload.output) ? payload.output : [];
  for (const item of output) {
    for (const content of Array.isArray(item.content) ? item.content : []) {
      if (typeof content.text === "string") return content.text;
    }
  }
  return "";
}

function chatText(payload: any): string {
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => part?.text || "").join("");
  }
  return "";
}

function assertOpenAiUrl(baseUrl: string, allowTestEndpoint = false): string {
  const url = new URL(baseUrl);
  const testEndpoint =
    allowTestEndpoint &&
    url.protocol === "http:" &&
    ["127.0.0.1", "localhost"].includes(url.hostname);
  if (
    (!testEndpoint && url.protocol !== "https:") ||
    (!testEndpoint && !["api.openai.com", "api.acucompute.com"].includes(url.hostname))
  ) {
    throw new Error(
      "0.1 只允许请求 OpenAI 或 ACU 的 HTTPS API 端点。"
    );
  }
  return url.toString().replace(/\/+$/, "");
}

export async function reviewWithLlm(
  draft: ReviewDraft,
  settings: LlmSettings,
  options: LlmRequestOptions = {}
): Promise<LlmReview> {
  if (!settings.apiKey) throw new Error("尚未配置 API Key。");
  const baseUrl = assertOpenAiUrl(settings.baseUrl, options.allowTestEndpoint);
  const fetchImpl = options.fetchImpl || fetch;
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${settings.apiKey}`
  };

  const body =
    settings.protocol === "chat_completions"
      ? {
          model: settings.model,
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: userContent(draft, settings.includeImages) }
          ],
          response_format: {
            type: "json_schema",
            json_schema: {
              name: "tapnow_review",
              strict: true,
              schema: REVIEW_SCHEMA
            }
          }
        }
      : {
          model: settings.model,
          instructions: SYSTEM_PROMPT,
          input: responseInput(draft, settings.includeImages),
          text: {
            format: {
              type: "json_schema",
              name: "tapnow_review",
              strict: true,
              schema: REVIEW_SCHEMA
            }
          }
        };

  const endpoint =
    settings.protocol === "chat_completions"
      ? `${baseUrl}/chat/completions`
      : `${baseUrl}/responses`;
  const request = (requestBody: Record<string, any>) =>
    fetchImpl(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(requestBody)
    });
  let response = await request(body);
  let raw = await response.text();
  if (
    !response.ok &&
    /response_format|json_schema|unavailable/i.test(raw)
  ) {
    response = await request(withoutStructuredOutput(body));
    raw = await response.text();
  }
  if (!response.ok) {
    throw new Error(
      `LLM 请求失败 HTTP ${response.status}: ${raw.slice(0, 500)}`
    );
  }

  const payload = JSON.parse(raw);
  const text =
    settings.protocol === "chat_completions"
      ? chatText(payload)
      : responseText(payload);
  if (!text) throw new Error("LLM 返回中没有找到结构化文本。");
  return {
    ...parseJson(text),
    provider: "openai",
    model: settings.model
  };
}

export const llmInternals = {
  SYSTEM_PROMPT,
  REVIEW_SCHEMA,
  compactDraft,
  userContent,
  responseInput,
  parseJson,
  responseText,
  chatText,
  assertOpenAiUrl
  ,
  withoutStructuredOutput
};
