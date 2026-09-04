import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { llmInternals } from "../utils/llm";
import { reviewWithLlm } from "../utils/llm";
import {
  MAX_IMAGE_DATA_URL_CHARS,
  MAX_REVIEW_TEXT_CHARS,
  preparedImageStats
} from "../utils/limits";

test("builds bounded JSON input for an LLM review", () => {
  const input = llmInternals.compactDraft({
    canvasId: "canvas-1",
    nodeId: "node-1",
    prompt: "x".repeat(150000),
    upstreamSummary: "y".repeat(50000),
    textMaterials: ["z".repeat(100000), "w".repeat(100000)]
  });
  const parsed = JSON.parse(input);
  assert.equal(parsed.prompt.length, 120000);
  assert.equal(parsed.upstream_context.length, 40000);
  assert.equal(
    parsed.text_materials.reduce(
      (sum: number, value: { text: string }) => sum + value.text.length,
      0
    ),
    MAX_REVIEW_TEXT_CHARS - 120000 - 40000
  );
});

test("extracts structured text from Responses and Chat Completions", () => {
  assert.equal(
    llmInternals.responseText({
      output_text: "{\"decision\":\"allow\"}"
    }),
    "{\"decision\":\"allow\"}"
  );
  assert.equal(
    llmInternals.chatText({
      choices: [{ message: { content: "{\"decision\":\"warn\"}" } }]
    }),
    "{\"decision\":\"warn\"}"
  );
});

test("extracts structured text from a Responses event stream", () => {
  const result = JSON.stringify({
    decision: "allow",
    summary: "流式图片审阅完成。",
    issues: [],
    suggestions: []
  });
  const stream = [
    `event: response.output_text.delta\ndata: ${JSON.stringify({
      type: "response.output_text.delta",
      delta: result
    })}`,
    `event: response.completed\ndata: ${JSON.stringify({
      type: "response.completed",
      response: { status: "completed", output: [] }
    })}`
  ].join("\n\n");
  assert.equal(llmInternals.responsesStreamText(stream), result);
});

test("includes captured data URLs in multimodal request content", () => {
  const dataUrl = "data:image/png;base64,ZmFrZQ==";
  const draft = {
    nodeId: "node-image",
    prompt: "审阅图片",
    imageMaterials: [
      { url: "https://example.com/image.png", dataUrl },
      { url: "https://example.com/not-prepared.png" }
    ]
  };
  assert.deepEqual(llmInternals.userContent(draft, true)[2], {
    type: "image_url",
    image_url: { url: dataUrl }
  });
  assert.match(llmInternals.userContent(draft, true)[1].text, /image-1/);
  assert.deepEqual(llmInternals.responseInput(draft, true)[0].content[2], {
    type: "input_image",
    image_url: dataUrl
  });
  assert.deepEqual(llmInternals.userContent(draft, false), [
    { type: "text", text: llmInternals.compactDraft(draft) }
  ]);
});

test("preserves image compression metadata in the review payload", () => {
  const parsed = JSON.parse(
    llmInternals.compactDraft({
      prompt: "审阅图片",
      textMaterials: ["上游提示词"],
      textMaterialSources: [
        { nodeId: "text-source", nodeType: "text", role: "upstream-node" }
      ],
      imageMaterials: [
        {
          materialId: "image-1",
          url: "https://example.com/compressed.jpg",
          dataUrl: "data:image/jpeg;base64,ZmFrZQ==",
          sourceNodeId: "image-source",
          sourceNodeType: "image",
          role: "upstream-node",
          compression: {
            applied: true,
            method: "page-canvas-jpeg-2048",
            originalBytes: 12_000_000,
            preparedBytes: 800_000
          }
        }
      ]
    })
  );
  assert.deepEqual(parsed.text_materials[0], {
    material_id: "text-1",
    text: "上游提示词",
    source_node_id: "text-source",
    source_node_type: "text",
    role: "upstream-node"
  });
  assert.equal(parsed.image_materials[0].material_id, "image-1");
  assert.equal(parsed.image_materials[0].source_node_id, "image-source");
  assert.deepEqual(parsed.image_materials[0].compression, {
    applied: true,
    method: "page-canvas-jpeg-2048",
    original_bytes: 12_000_000,
    prepared_bytes: 800_000
  });
});

test("sends multiple prepared images and skips unprepared images", () => {
  const image = (name: string) => ({
    url: `https://example.com/${name}.png`,
    dataUrl: "data:image/png;base64,ZmFrZQ=="
  });
  const content = llmInternals.userContent(
    { prompt: "多图审阅", imageMaterials: [image("one"), image("two"), { url: "https://example.com/three.png" }] },
    true
  );
  assert.equal(content.filter((part: any) => part.type === "image_url").length, 2);
});

test("allows more than four small prepared images", () => {
  const image = (name: string) => ({
    url: `https://example.com/${name}.png`,
    dataUrl: "data:image/png;base64,ZmFrZQ=="
  });
  const content = llmInternals.userContent(
    {
      prompt: "多图审阅",
      imageMaterials: Array.from({ length: 12 }, (_, index) => image(String(index)))
    },
    true
  );
  assert.equal(content.filter((part: any) => part.type === "image_url").length, 12);
});

test("reports prepared images omitted only when the aggregate image budget is exceeded", () => {
  const oneImage = "data:image/jpeg;base64," + "a".repeat(8_000_000);
  const stats = preparedImageStats([
      { url: "https://example.com/one.jpg", dataUrl: oneImage },
      { url: "https://example.com/two.jpg", dataUrl: oneImage },
      { url: "https://example.com/three.jpg", dataUrl: oneImage }
  ]);
  assert.equal(stats.preparedCount, 3);
  assert.equal(stats.sentCount, 2);
  assert.equal(stats.omittedCount, 1);
  assert.equal(stats.budgetChars, MAX_IMAGE_DATA_URL_CHARS);
});

test("uses a configured review prompt in the request", async () => {
  const requests: any[] = [];
  const server = http.createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    requests.push(JSON.parse(raw));
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({
      choices: [{
        message: {
          content: JSON.stringify({
            decision: "allow",
            summary: "已完成。",
            issues: [],
            suggestions: []
          })
        }
      }]
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    await reviewWithLlm(
      { prompt: "检查" },
      {
        apiKey: "test-key",
        includeImages: false,
        prompt: "只检查团队风格",
        protocol: "chat_completions",
        model: "test-model",
        baseUrl: `http://127.0.0.1:${address.port}/v1`
      },
      { allowTestEndpoint: true }
    );
    assert.equal(requests[0].messages[0].content, "只检查团队风格");
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  }
});

test("rejects non-OpenAI base URLs in the personal 0.1 build", () => {
  assert.throws(
    () => llmInternals.assertOpenAiUrl("http://localhost:3000/v1"),
    /只允许请求/
  );
});

test("retries without structured output when a provider rejects the format", async () => {
  const requests: any[] = [];
  const server = http.createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    requests.push(JSON.parse(raw));
    response.setHeader("Content-Type", "application/json");
    if (requests.length === 1) {
      response.statusCode = 400;
      response.end(JSON.stringify({ error: { message: "response_format is unavailable" } }));
      return;
    }
    response.end(JSON.stringify({
      choices: [{
        message: {
          content: JSON.stringify({
            decision: "allow",
            summary: "图片和文字素材已审阅。",
            issues: [],
            suggestions: []
          })
        }
      }]
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;
  const dataUrl = "data:image/png;base64,ZmFrZQ==";

  try {
    const result = await reviewWithLlm(
      {
        nodeId: "node-image",
        prompt: "审阅图片",
        imageMaterials: [{ url: "https://example.com/image.png", dataUrl }]
      },
      {
        apiKey: "test-key",
        includeImages: true,
        protocol: "chat_completions",
        model: "vision-test",
        baseUrl
      },
      { allowTestEndpoint: true }
    );
    assert.equal(result.decision, "allow");
    assert.equal(requests.length, 2);
    assert.equal(requests[0].response_format.type, "json_schema");
    assert.equal(requests[1].response_format, undefined);
    assert.deepEqual(requests[1].messages[1].content[2], {
      type: "image_url",
      image_url: { url: dataUrl }
    });
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  }
});

test("retries an ACU bad response body before falling back", async () => {
  const requests: any[] = [];
  const server = http.createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    requests.push(JSON.parse(raw));
    response.setHeader("Content-Type", "application/json");
    if (requests.length < 3) {
      response.statusCode = 500;
      response.end(JSON.stringify({
        error: {
          message: "invalid character 'e' looking for beginning of value",
          type: "bad_response_body",
          code: "bad_response_body"
        }
      }));
      return;
    }
    response.end(JSON.stringify({
      choices: [{
        message: {
          content: "```json\n" + JSON.stringify({
            decision: "warn",
            summary: "重试后成功。",
            issues: [],
            suggestions: ["继续检查图片。"]
          }) + "\n```"
        }
      }]
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  try {
    const result = await reviewWithLlm(
      { prompt: "审阅真实节点" },
      {
        apiKey: "test-key",
        includeImages: true,
        protocol: "chat_completions",
        model: "vision-test",
        baseUrl: `http://127.0.0.1:${address.port}/v1`
      },
      { allowTestEndpoint: true, retryDelayMs: 0 }
    );
    assert.equal(result.summary, "重试后成功。");
    assert.equal(requests.length, 3);
    assert.equal(requests[0].response_format.type, "json_schema");
    assert.equal(requests[1].response_format.type, "json_schema");
    assert.equal(requests[2].response_format, undefined);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  }
});

test("retries a transient browser network failure", async () => {
  let calls = 0;
  const result = JSON.stringify({
    decision: "allow",
    summary: "网络重试后成功。",
    issues: [],
    suggestions: []
  });
  const fetchImpl: typeof fetch = async () => {
    calls++;
    if (calls === 1) throw new TypeError("Failed to fetch");
    return new Response(JSON.stringify({ output_text: result }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  };

  const reviewed = await reviewWithLlm(
    { prompt: "网络重试测试" },
    {
      apiKey: "test-key",
      includeImages: false,
      protocol: "responses",
      model: "test-model",
      baseUrl: "https://api.acucompute.com/v1"
    },
    { fetchImpl, retryDelayMs: 0 }
  );
  assert.equal(reviewed.summary, "网络重试后成功。");
  assert.equal(calls, 2);
});

test("runs the complete Responses and Chat Completions HTTP flows", async () => {
  const requests: Array<{ url: string; body: any; authorization: string }> = [];
  const server = http.createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    requests.push({
      url: request.url || "",
      body: JSON.parse(raw),
      authorization: String(request.headers.authorization || "")
    });
    response.setHeader("Content-Type", "application/json");
    const result = JSON.stringify({
      decision: "warn",
      summary: "需要补充可验证的视觉要求。",
      issues: [
        {
          severity: "warn",
          code: "missing-detail",
          title: "缺少细节",
          detail: "建议补充主体和光线。"
        }
      ],
      suggestions: ["补充主体、环境和光线。"]
    });
    if (request.url === "/v1/responses") {
      response.end(JSON.stringify({ output_text: result }));
    } else {
      response.end(
        JSON.stringify({ choices: [{ message: { content: result } }] })
      );
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;

  try {
    const draft = { nodeId: "node-1", nodeType: "image", prompt: "一只猫" };
    const responsesResult = await reviewWithLlm(
      draft,
      {
        apiKey: "test-key",
        includeImages: true,
        protocol: "responses",
        model: "test-model",
        baseUrl
      },
      { allowTestEndpoint: true }
    );
    const chatResult = await reviewWithLlm(
      draft,
      {
        apiKey: "test-key",
        includeImages: true,
        protocol: "chat_completions",
        model: "test-model",
        baseUrl
      },
      { allowTestEndpoint: true }
    );

    assert.equal(responsesResult.decision, "warn");
    assert.equal(chatResult.issues[0].code, "missing-detail");
    assert.equal(requests[0].url, "/v1/responses");
    assert.equal(requests[1].url, "/v1/chat/completions");
    assert.equal(requests[0].authorization, "Bearer test-key");
    assert.equal(requests[1].authorization, "Bearer test-key");
    assert.equal(requests[0].body.stream, true);
    assert.equal(requests[0].body.text.format.type, "json_schema");
    assert.equal(requests[1].body.response_format.type, "json_schema");
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  }
});
