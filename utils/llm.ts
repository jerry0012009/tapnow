import type {
  ReviewDecision,
  ReviewDraft,
  ReviewIssue
} from "./reviewer";
import {
  DEFAULT_LLM_PROMPT,
  MAX_LLM_PROMPT_LENGTH
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
  prompt?: string;
  protocol: "responses" | "chat_completions";
  model: string;
  baseUrl: string;
}

interface LlmRequestOptions {
  fetchImpl?: typeof fetch;
  allowTestEndpoint?: boolean;
  retryDelayMs?: number;
}

const SYSTEM_PROMPT = DEFAULT_LLM_PROMPT;

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
    .map((item) => item.dataUrl)
    .filter((url): url is string => Boolean(url && /^data:image\//i.test(url)))
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
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)?.[1];
  const candidate = fenced || trimmed;
  let parsed: any;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    const firstBrace = candidate.indexOf("{");
    const lastBrace = candidate.lastIndexOf("}");
    if (firstBrace < 0 || lastBrace <= firstBrace) throw new Error("LLM 返回的审阅结果不是有效 JSON。");
    parsed = JSON.parse(candidate.slice(firstBrace, lastBrace + 1));
  }
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

function responsesStreamText(raw: string): string {
  const deltas: string[] = [];
  let completedText = "";
  let doneText = "";

  for (const block of raw.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n")
      .trim();
    if (!data || data === "[DONE]") continue;

    let payload: any;
    try {
      payload = JSON.parse(data);
    } catch {
      continue;
    }
    if (
      payload.type === "response.output_text.delta" &&
      typeof payload.delta === "string"
    ) {
      deltas.push(payload.delta);
    }
    if (
      payload.type === "response.output_text.done" &&
      typeof payload.text === "string"
    ) {
      doneText = payload.text;
    }
    if (
      payload.type === "response.completed" ||
      payload.type === "response.done"
    ) {
      completedText = responseText(payload.response);
    }
    if (payload.type === "response.failed" || payload.type === "error") {
      const error = payload.response?.error || payload.error || payload;
      throw new Error(
        `LLM Responses 流失败：${String(
          error.message || error.code || payload.type
        )}`
      );
    }
  }

  return completedText || doneText || deltas.join("");
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

function retryableFailure(status: number, raw: string): boolean {
  return (
    status === 408 ||
    status === 425 ||
    status === 429 ||
    status >= 500 ||
    /bad_response_body|temporar|timeout|upstream/i.test(raw)
  );
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
  const systemPrompt = String(settings.prompt || DEFAULT_LLM_PROMPT)
    .trim()
    .slice(0, MAX_LLM_PROMPT_LENGTH);

  const body =
    settings.protocol === "chat_completions"
      ? {
          model: settings.model,
          messages: [
            { role: "system", content: systemPrompt },
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
          instructions: systemPrompt,
          input: responseInput(draft, settings.includeImages),
          stream: true,
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
  const retryDelayMs = options.retryDelayMs ?? 400;
  const requestWithRetry = async (
    requestBody: Record<string, any>,
    retries: number
  ) => {
    let response = await request(requestBody);
    let raw = await response.text();
    for (
      let attempt = 0;
      !response.ok &&
      attempt < retries &&
      retryableFailure(response.status, raw);
      attempt++
    ) {
      if (retryDelayMs > 0) {
        await new Promise((resolve) =>
          setTimeout(resolve, retryDelayMs * (attempt + 1))
        );
      }
      response = await request(requestBody);
      raw = await response.text();
    }
    return { response, raw };
  };

  let { response, raw } = await requestWithRetry(body, 1);
  if (
    !response.ok &&
    /response_format|json_schema|unavailable|bad_response_body/i.test(raw)
  ) {
    ({ response, raw } = await requestWithRetry(
      withoutStructuredOutput(body),
      0
    ));
  }
  if (!response.ok) {
    throw new Error(
      `LLM 请求失败 HTTP ${response.status}: ${raw.slice(0, 500)}`
    );
  }

  const text =
    settings.protocol === "chat_completions"
      ? chatText(JSON.parse(raw))
      : /text\/event-stream/i.test(response.headers.get("content-type") || "") ||
          /^\s*(?:event|data):/m.test(raw)
        ? responsesStreamText(raw)
        : responseText(JSON.parse(raw));
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
  responsesStreamText,
  chatText,
  assertOpenAiUrl,
  withoutStructuredOutput,
  retryableFailure
};
