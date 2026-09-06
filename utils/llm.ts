import type {
  ReviewDecision,
  ReviewDraft,
  ReviewIssue,
  ReviewNodeInfo
} from "./reviewer";
import { DEFAULT_LLM_PROMPT } from "./reviewer";
import {
  MAX_REVIEW_IMAGE_MATERIALS,
  MAX_REVIEW_PROMPT_CHARS,
  MAX_REVIEW_REQUEST_BYTES,
  MAX_REVIEW_TEXT_CHARS,
  MAX_REVIEW_TEXT_MATERIAL_CHARS,
  MAX_REVIEW_TEXT_MATERIAL_ITEM_CHARS,
  MAX_REVIEW_TEXT_MATERIALS,
  MAX_REVIEW_UPSTREAM_CHARS,
  MAX_LLM_PROMPT_LENGTH,
  preparedImageStats,
  selectPreparedImages
} from "./limits";

export interface LlmReview {
  decision: ReviewDecision;
  summary: string;
  issues: ReviewIssue[];
  suggestions: string[];
  provider: string;
  model: string;
  requestStats: ReturnType<typeof reviewPayloadStats> & {
    requestBytes: number;
  };
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

function compactValue(value: unknown, depth = 0): unknown {
  if (value == null || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") return value.slice(0, 8_000);
  if (depth >= 4) return "[nested data omitted]";
  if (Array.isArray(value)) {
    return value.slice(0, 32).map((item) => compactValue(item, depth + 1));
  }
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 64)
        .map(([key, item]) => [key, compactValue(item, depth + 1)])
    );
  }
  return String(value).slice(0, 8_000);
}

function compactDraft(draft: ReviewDraft): string {
  const prompt = String(draft.prompt ?? "").slice(
    0,
    MAX_REVIEW_PROMPT_CHARS
  );
  const upstreamBudget = Math.max(
    0,
    Math.min(
      MAX_REVIEW_UPSTREAM_CHARS,
      MAX_REVIEW_TEXT_CHARS - prompt.length
    )
  );
  const upstream = String(draft.upstreamSummary ?? "").slice(
    0,
    upstreamBudget
  );
  let materialBudget = Math.max(
    0,
    Math.min(
      MAX_REVIEW_TEXT_MATERIAL_CHARS,
      MAX_REVIEW_TEXT_CHARS - prompt.length - upstream.length
    )
  );
  const textMaterials: string[] = [];
  for (const item of (draft.textMaterials || []).slice(
    0,
    MAX_REVIEW_TEXT_MATERIALS
  )) {
    if (materialBudget <= 0) break;
    const text = String(item).slice(
      0,
      Math.min(MAX_REVIEW_TEXT_MATERIAL_ITEM_CHARS, materialBudget)
    );
    if (!text) continue;
    textMaterials.push(text);
    materialBudget -= text.length;
  }

  const compactNode = (node: ReviewNodeInfo | null | undefined) =>
    node
      ? {
          id: node.id,
          canvas_id: node.canvasId,
          node_type: node.nodeType,
          data_type: node.dataType,
          title: node.title,
          short_id: node.shortId,
          data: compactValue(node.data),
          prompt: node.prompt.slice(0, 20_000),
          text: node.text.slice(0, 20_000),
          params: node.params,
          media: node.media.slice(0, MAX_REVIEW_IMAGE_MATERIALS).map((media) => ({
            url: media.url.slice(0, 2_000),
            width: media.width ?? null,
            height: media.height ?? null
          })),
          task_status: node.taskStatus,
          position: node.position,
          measured: node.measured,
          dimensions: node.dimensions,
          parent_id: node.parentId,
          extent: node.extent,
          source_position: node.sourcePosition,
          target_position: node.targetPosition,
          session_id: node.sessionId,
          created_by: node.createdBy,
          created_by_role: node.createdByRole,
          created_at: node.createdAt,
          updated_at: node.updatedAt
        }
      : null;

  return JSON.stringify({
    canvas_id: draft.canvasId ?? null,
    node_id: draft.nodeId ?? null,
    node_type: draft.nodeType ?? null,
    prompt,
    prompt_source: draft.promptSource ?? null,
    prompt_candidates: (draft.promptCandidates || []).map((candidate) => ({
      source: candidate.source,
      value: candidate.value.slice(0, MAX_REVIEW_PROMPT_CHARS),
      selected: candidate.selected,
      ignored_reason: candidate.ignoredReason ?? null
    })),
    upstream_context: upstream,
    text_materials: textMaterials.map((text, index) => {
      const source = draft.textMaterialSources?.[index];
      return {
        material_id: `text-${index + 1}`,
        text,
        source_node_id: source?.nodeId ?? null,
        source_node_type: source?.nodeType ?? null,
        role: source?.role ?? "connected-text"
      };
    }),
    focus_node: compactNode(draft.nodeInfo),
    incoming_nodes: (draft.incomingNodes || [])
      .slice(0, MAX_REVIEW_TEXT_MATERIALS)
      .map(compactNode),
    incoming_connections: (draft.incomingConnections || [])
      .slice(0, MAX_REVIEW_TEXT_MATERIALS)
      .map((connection) => ({
        id: connection.id,
        source: connection.source,
        target: connection.target,
        source_handle: connection.sourceHandle,
        target_handle: connection.targetHandle,
        label: connection.label
      })),
    outgoing_nodes: (draft.outgoingNodes || [])
      .slice(0, MAX_REVIEW_TEXT_MATERIALS)
      .map(compactNode),
    outgoing_connections: (draft.outgoingConnections || [])
      .slice(0, MAX_REVIEW_TEXT_MATERIALS)
      .map((connection) => ({
        id: connection.id,
        source: connection.source,
        target: connection.target,
        source_handle: connection.sourceHandle,
        target_handle: connection.targetHandle,
        label: connection.label
      })),
    reference_bindings: (draft.referenceBindings || []).slice(
      0,
      MAX_REVIEW_IMAGE_MATERIALS
    ),
    snapshot: draft.snapshot
      ? {
          source: draft.snapshot.source,
          endpoint: draft.snapshot.endpoint ?? null,
          node_count: draft.snapshot.nodeCount ?? null,
          connection_count: draft.snapshot.connectionCount ?? null,
          reference_order_source:
            draft.snapshot.referenceOrderSource ?? null,
          relations_endpoint: draft.snapshot.relationsEndpoint ?? null,
          relations_error: draft.snapshot.relationsError ?? null,
          error: draft.snapshot.error ?? null
        }
      : null,
    image_materials: (draft.imageMaterials || [])
      .slice(0, MAX_REVIEW_IMAGE_MATERIALS)
      .map((item, index) => ({
        material_id: item.materialId || `image-${index + 1}`,
        order: index + 1,
        url: item.url.slice(0, 2000),
        alt: String(item.alt || "").slice(0, 300),
        width: item.width || null,
        height: item.height || null,
        source_node_id: item.sourceNodeId ?? null,
        source_node_type: item.sourceNodeType ?? null,
        source_title: item.sourceTitle ?? null,
        role: item.role ?? "connected-image",
        reference: item.reference ?? null,
        reference_index: item.referenceIndex ?? null,
        capture_source_url: item.captureSourceUrl ?? null,
        uploadable: Boolean(item.dataUrl),
        compression: item.compression
          ? {
              applied: item.compression.applied,
              method: item.compression.method,
              original_bytes: item.compression.originalBytes ?? null,
              prepared_bytes: item.compression.preparedBytes ?? null
            }
          : null
      }))
  });
}

function selectedImages(draft: ReviewDraft, includeImages: boolean) {
  if (!includeImages) return [];
  return selectPreparedImages(draft.imageMaterials || []);
}

function imageMarker(
  image: NonNullable<ReviewDraft["imageMaterials"]>[number],
  index: number
): string {
  const materialId = image.materialId || `image-${index + 1}`;
  const reference = image.reference ? `，提示词引用 ${image.reference}` : "";
  const source = image.sourceNodeId ? `，来源节点 ${image.sourceNodeId}` : "";
  return `下面是 ${materialId}${reference}${source}，必须按此标识审阅：`;
}

function userContent(draft: ReviewDraft, includeImages: boolean) {
  const text = compactDraft(draft);
  return [
    { type: "text", text },
    ...selectedImages(draft, includeImages).flatMap(({ image, index, dataUrl }) => [
      {
        type: "text",
        text: imageMarker(image, index)
      },
      { type: "image_url", image_url: { url: dataUrl } }
    ])
  ];
}

function responseInput(draft: ReviewDraft, includeImages: boolean) {
  return [{
    role: "user",
    content: [
      { type: "input_text", text: compactDraft(draft) },
      ...selectedImages(draft, includeImages).flatMap(
        ({ image, index, dataUrl }) => [
          {
            type: "input_text",
            text: imageMarker(image, index)
          },
          { type: "input_image", image_url: dataUrl }
        ]
      )
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

  const requestBytes = new TextEncoder().encode(JSON.stringify(body)).length;
  if (requestBytes > MAX_REVIEW_REQUEST_BYTES) {
    throw new Error(
      `LLM 请求体约 ${(requestBytes / 1_000_000).toFixed(1)} MB，超过插件 ` +
        `${(MAX_REVIEW_REQUEST_BYTES / 1_000_000).toFixed(0)} MB 安全预算。` +
        "请减少或压缩图片素材后重试。"
    );
  }

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
    let response: Response | null = null;
    let raw = "";
    for (
      let attempt = 0;
      attempt <= retries;
      attempt++
    ) {
      try {
        response = await request(requestBody);
        raw = await response.text();
      } catch (error) {
        if (attempt >= retries) {
          throw new Error(
            `LLM 网络请求失败（${endpoint}）：${
              error instanceof Error ? error.message : String(error)
            }`
          );
        }
        if (retryDelayMs > 0) {
          await new Promise((resolve) =>
            setTimeout(resolve, retryDelayMs * (attempt + 1))
          );
        }
        continue;
      }
      if (
        response.ok ||
        attempt >= retries ||
        !retryableFailure(response.status, raw)
      ) {
        break;
      }
      if (retryDelayMs > 0) {
        await new Promise((resolve) =>
          setTimeout(resolve, retryDelayMs * (attempt + 1))
        );
      }
    }
    return { response: response!, raw };
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
    model: settings.model,
    requestStats: {
      ...reviewPayloadStats(draft, settings.includeImages),
      requestBytes
    }
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

export function reviewPayloadStats(
  draft: ReviewDraft,
  includeImages: boolean
) {
  const compact = compactDraft(draft);
  const parsed = JSON.parse(compact);
  const sourceTextChars =
    String(draft.prompt || "").length +
    String(draft.upstreamSummary || "").length +
    (draft.textMaterials || []).reduce(
      (sum, item) => sum + String(item).length,
      0
    );
  const includedTextChars =
    String(parsed.prompt || "").length +
    String(parsed.upstream_context || "").length +
    (parsed.text_materials || []).reduce(
      (sum: number, item: unknown) =>
        sum +
        (typeof item === "object" && item
          ? String((item as { text?: unknown }).text || "").length
          : String(item).length),
      0
    );
  const images = includeImages
    ? preparedImageStats(draft.imageMaterials)
    : {
        preparedCount: 0,
        sentCount: 0,
        omittedCount: 0,
        sentDataUrlChars: 0,
        sentImageBytes: 0,
        budgetChars: 0
      };
  return {
    compactTextChars: compact.length,
    sourceTextChars,
    includedTextChars,
    omittedTextChars: Math.max(0, sourceTextChars - includedTextChars),
    textBudgetChars: MAX_REVIEW_TEXT_CHARS,
    ...images
  };
}
