import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { llmInternals } from "../utils/llm";
import { reviewWithLlm } from "../utils/llm";

test("builds bounded JSON input for an LLM review", () => {
  const input = llmInternals.compactDraft({
    canvasId: "canvas-1",
    nodeId: "node-1",
    prompt: "x".repeat(5000),
    upstreamSummary: "y".repeat(3000)
  });
  const parsed = JSON.parse(input);
  assert.equal(parsed.prompt.length, 4000);
  assert.equal(parsed.upstream_context.length, 2000);
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

test("rejects non-OpenAI base URLs in the personal 0.1 build", () => {
  assert.throws(
    () => llmInternals.assertOpenAiUrl("http://localhost:3000/v1"),
    /只允许请求/
  );
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
    assert.equal(requests[0].body.text.format.type, "json_schema");
    assert.equal(requests[1].body.response_format.type, "json_schema");
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  }
});
