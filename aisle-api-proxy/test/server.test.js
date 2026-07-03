"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  buildAislePromptPayload,
  buildForwardHeaders,
  buildChatCompletionResponse,
  deriveCompletionUrl,
  derivePromptUrl,
  extractAisleText,
  extractPromptText,
  isChatCompletionRequest,
  isModelsRequest,
  resolveConfig
} = require("../src/server");

/**
 * 方法功能：构造最小化 HTTP 请求对象，便于单元测试代理路径判断。
 * 签名注释：mockRequest(method: string, url: string, headers?: object): object
 *
 * @param {string} method HTTP 方法。
 * @param {string} url 请求路径。
 * @param {object} headers 请求头。
 * @returns {{method: string, url: string, headers: object}} 测试请求对象。
 */
function mockRequest(method, url, headers = {}) {
  return { method, url, headers };
}

test("deriveCompletionUrl converts prompt API URL to chat completions URL", () => {
  const result = deriveCompletionUrl("https://api.aisle.sh/run_aisle/prompts/asdasda897-cc91-457f-83aa-44bdd");

  assert.equal(result.toString(), "https://api.aisle.sh/run_aisle/v1/chat/completions");
});

test("derivePromptUrl keeps real Aisle prompt endpoint", () => {
  const result = derivePromptUrl("https://api.aisle.sh/run_aisle/prompts/cafd8987-cc91-457f-83aa-44bdd9d20462");

  assert.equal(result.toString(), "https://api.aisle.sh/run_aisle/prompts/cafd8987-cc91-457f-83aa-44bdd9d20462");
});

test("deriveCompletionUrl preserves path prefix before run_aisle", () => {
  const result = deriveCompletionUrl("https://example.com/proxy/run_aisle/prompts/prompt-id?debug=1");

  assert.equal(result.toString(), "https://example.com/proxy/run_aisle/v1/chat/completions");
});

test("deriveCompletionUrl accepts explicit completion URL override", () => {
  const result = deriveCompletionUrl(
    "https://api.aisle.sh/run_aisle/prompts/prompt-id",
    "https://gateway.example.com/run_aisle/v1/chat/completions"
  );

  assert.equal(result.toString(), "https://gateway.example.com/run_aisle/v1/chat/completions");
});

test("deriveCompletionUrl rejects invalid prompt URL", () => {
  assert.throws(
    () => deriveCompletionUrl("https://api.aisle.sh/run_aisle/not-prompts/prompt-id"),
    /AISLE_PROMPT_URL 格式不正确/
  );
});

test("isChatCompletionRequest supports OpenAI-compatible and prompt-shaped paths", () => {
  assert.equal(isChatCompletionRequest(mockRequest("POST", "/v1/chat/completions")), true);
  assert.equal(isChatCompletionRequest(mockRequest("POST", "/chat/completions")), true);
  assert.equal(isChatCompletionRequest(mockRequest("POST", "/custom/base/v1/chat/completions")), true);
  assert.equal(isChatCompletionRequest(mockRequest("POST", "/run_aisle/prompts/prompt-id")), true);
  assert.equal(isChatCompletionRequest(mockRequest("GET", "/v1/chat/completions")), false);
});

test("isModelsRequest supports OpenAI-compatible model discovery paths", () => {
  assert.equal(isModelsRequest(mockRequest("GET", "/v1/models")), true);
  assert.equal(isModelsRequest(mockRequest("GET", "/models")), true);
  assert.equal(isModelsRequest(mockRequest("GET", "/custom/base/v1/models")), true);
  assert.equal(isModelsRequest(mockRequest("POST", "/v1/models")), false);
});

test("buildForwardHeaders strips hop-by-hop headers and injects configured API key", () => {
  const headers = buildForwardHeaders(
    mockRequest("POST", "/v1/chat/completions", {
      host: "localhost:3000",
      connection: "keep-alive",
      "content-type": "application/json",
      "x-client-id": "demo"
    }),
    { apiKey: "aisle-secret" }
  );

  assert.equal(headers.get("host"), null);
  assert.equal(headers.get("connection"), null);
  assert.equal(headers.get("content-type"), "application/json");
  assert.equal(headers.get("x-client-id"), "demo");
  assert.equal(headers.get("authorization"), "Bearer aisle-secret");
});

test("resolveConfig validates port and derives upstream URL", () => {
  const config = resolveConfig({
    PORT: "18080",
    AISLE_PROMPT_URL: "https://api.aisle.sh/run_aisle/prompts/prompt-id",
    AISLE_MODEL_NAME: "aisle-test",
    AISLE_VARIABLE_NAME: "question"
  });

  assert.equal(config.port, 18080);
  assert.equal(config.promptUrl.toString(), "https://api.aisle.sh/run_aisle/prompts/prompt-id");
  assert.equal(config.completionUrl.toString(), "https://api.aisle.sh/run_aisle/v1/chat/completions");
  assert.equal(config.modelName, "aisle-test");
  assert.equal(config.variableName, "question");
});

test("extractPromptText reads latest user message", () => {
  const result = extractPromptText({
    messages: [
      { role: "system", content: "system" },
      { role: "user", content: "first" },
      { role: "assistant", content: "answer" },
      { role: "user", content: [{ type: "text", text: "second" }] }
    ]
  });

  assert.equal(result, "second");
});

test("buildAislePromptPayload maps OpenAI messages to flat prompt variables", () => {
  const result = buildAislePromptPayload(
    {
      messages: [{ role: "user", content: "hello" }],
      variables: { custom: "value" }
    },
    { variableName: "question" }
  );

  assert.equal(result.question, "hello");
  assert.equal(result.variable_name, "hello");
  assert.equal(result.prompt, "hello");
  assert.equal(result.custom, "value");
});

test("extractAisleText unwraps JSON string and object responses", () => {
  assert.equal(extractAisleText("\"hello\""), "hello");
  assert.equal(extractAisleText("{\"output\":\"hello\"}"), "hello");
  assert.equal(extractAisleText("plain text"), "plain text");
});

test("buildChatCompletionResponse wraps content as OpenAI response", () => {
  const result = buildChatCompletionResponse("hello", { model: "demo" }, { modelName: "fallback" });

  assert.equal(result.object, "chat.completion");
  assert.equal(result.model, "demo");
  assert.equal(result.choices[0].message.content, "hello");
  assert.equal(result.choices[0].finish_reason, "stop");
});
