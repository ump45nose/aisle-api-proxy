"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  buildForwardHeaders,
  deriveCompletionUrl,
  isChatCompletionRequest,
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
  assert.equal(isChatCompletionRequest(mockRequest("POST", "/run_aisle/prompts/prompt-id")), true);
  assert.equal(isChatCompletionRequest(mockRequest("GET", "/v1/chat/completions")), false);
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
    AISLE_PROMPT_URL: "https://api.aisle.sh/run_aisle/prompts/prompt-id"
  });

  assert.equal(config.port, 18080);
  assert.equal(config.completionUrl.toString(), "https://api.aisle.sh/run_aisle/v1/chat/completions");
});
