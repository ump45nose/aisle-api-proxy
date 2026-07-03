"use strict";

const http = require("node:http");

const DEFAULT_PORT = 3000;
const DEFAULT_HOST = "0.0.0.0";
const DEFAULT_MODEL_NAME = "aisle-prompt";
const DEFAULT_VARIABLE_NAME = "variable_name";

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length"
]);

/**
 * 方法功能：从用户配置的 Aisle prompt 地址推导标准 chat completions 展示地址。
 * 签名注释：deriveCompletionUrl(promptUrl: string, explicitCompletionUrl?: string): URL
 *
 * @param {string} promptUrl 用户配置的形如 https://api.aisle.sh/run_aisle/prompts/{id} 的地址。
 * @param {string | undefined} explicitCompletionUrl 可选的完整展示地址覆盖值。
 * @returns {URL} 推导后的 https://api.aisle.sh/run_aisle/v1/chat/completions 展示地址。
 */
function deriveCompletionUrl(promptUrl, explicitCompletionUrl) {
  if (explicitCompletionUrl) {
    return new URL(explicitCompletionUrl);
  }

  if (!promptUrl) {
    throw new Error("缺少 AISLE_PROMPT_URL，请配置 Aisle prompt API 地址。");
  }

  const parsedUrl = new URL(promptUrl);
  const pathSegments = parsedUrl.pathname.split("/").filter(Boolean);
  const runAisleIndex = pathSegments.indexOf("run_aisle");
  const promptsIndex = pathSegments.indexOf("prompts");

  if (runAisleIndex === -1 || promptsIndex !== runAisleIndex + 1 || !pathSegments[promptsIndex + 1]) {
    throw new Error("AISLE_PROMPT_URL 格式不正确，应类似 https://api.aisle.sh/run_aisle/prompts/{promptId}。");
  }

  // 业务逻辑：保留 run_aisle 之前的路径前缀，只把 prompts/{id} 替换为 v1/chat/completions。
  const prefixSegments = pathSegments.slice(0, runAisleIndex + 1);
  parsedUrl.pathname = `/${prefixSegments.concat(["v1", "chat", "completions"]).join("/")}`;
  parsedUrl.search = "";
  parsedUrl.hash = "";

  return parsedUrl;
}

/**
 * 方法功能：校验并返回真实可调用的 Aisle prompt 地址。
 * 签名注释：derivePromptUrl(promptUrl: string): URL
 *
 * @param {string} promptUrl 用户配置的形如 https://api.aisle.sh/run_aisle/prompts/{id} 的地址。
 * @returns {URL} 真实上游 prompt API 地址。
 */
function derivePromptUrl(promptUrl) {
  if (!promptUrl) {
    throw new Error("缺少 AISLE_PROMPT_URL，请配置 Aisle prompt API 地址。");
  }

  const parsedUrl = new URL(promptUrl);
  const pathSegments = parsedUrl.pathname.split("/").filter(Boolean);
  const runAisleIndex = pathSegments.indexOf("run_aisle");
  const promptsIndex = pathSegments.indexOf("prompts");

  if (runAisleIndex === -1 || promptsIndex !== runAisleIndex + 1 || !pathSegments[promptsIndex + 1]) {
    throw new Error("AISLE_PROMPT_URL 格式不正确，应类似 https://api.aisle.sh/run_aisle/prompts/{promptId}。");
  }

  return parsedUrl;
}

/**
 * 方法功能：读取环境变量并组装服务运行配置。
 * 签名注释：resolveConfig(env?: NodeJS.ProcessEnv): object
 *
 * @param {NodeJS.ProcessEnv} env 运行环境变量，默认使用 process.env。
 * @returns {{host: string, port: number, promptUrl: URL, completionUrl: URL, apiKey: string, timeoutMs: number, modelName: string, variableName: string}} 服务配置对象。
 */
function resolveConfig(env = process.env) {
  const port = Number.parseInt(env.PORT || `${DEFAULT_PORT}`, 10);
  const timeoutMs = Number.parseInt(env.PROXY_TIMEOUT_MS || "120000", 10);

  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error("PORT 必须是 1 到 65535 之间的端口号。");
  }

  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("PROXY_TIMEOUT_MS 必须是正整数毫秒数。");
  }

  return {
    host: env.HOST || DEFAULT_HOST,
    port,
    promptUrl: derivePromptUrl(env.AISLE_PROMPT_URL || ""),
    completionUrl: deriveCompletionUrl(env.AISLE_PROMPT_URL || "", env.AISLE_COMPLETION_URL),
    apiKey: env.AISLE_API_KEY || "",
    modelName: env.AISLE_MODEL_NAME || DEFAULT_MODEL_NAME,
    variableName: env.AISLE_VARIABLE_NAME || DEFAULT_VARIABLE_NAME,
    timeoutMs
  };
}

/**
 * 方法功能：判断当前请求是否应该被转发到 Aisle chat completions。
 * 签名注释：isChatCompletionRequest(req: http.IncomingMessage): boolean
 *
 * @param {http.IncomingMessage} req Node.js 原生 HTTP 请求。
 * @returns {boolean} 请求是否匹配代理支持的接口路径。
 */
function isChatCompletionRequest(req) {
  const requestUrl = new URL(req.url || "/", "http://localhost");
  const pathname = requestUrl.pathname.replace(/\/+$/, "") || "/";

  return (
    req.method === "POST" &&
    (
      pathname === "/v1/chat/completions" ||
      pathname === "/chat/completions" ||
      pathname.endsWith("/chat/completions") ||
      /^\/run_aisle\/prompts\/[^/]+$/.test(pathname)
    )
  );
}

/**
 * 方法功能：判断当前请求是否为 OpenAI models 查询接口。
 * 签名注释：isModelsRequest(req: http.IncomingMessage): boolean
 *
 * @param {http.IncomingMessage} req Node.js 原生 HTTP 请求。
 * @returns {boolean} 请求是否匹配模型列表接口。
 */
function isModelsRequest(req) {
  const requestUrl = new URL(req.url || "/", "http://localhost");
  const pathname = requestUrl.pathname.replace(/\/+$/, "") || "/";

  return req.method === "GET" && (pathname === "/v1/models" || pathname === "/models" || pathname.endsWith("/models"));
}

/**
 * 方法功能：构建转发给上游 Aisle API 的请求头。
 * 签名注释：buildForwardHeaders(req: http.IncomingMessage, config: object): Headers
 *
 * @param {http.IncomingMessage} req Node.js 原生 HTTP 请求。
 * @param {{apiKey: string}} config 服务配置对象。
 * @returns {Headers} 可传给 fetch 的请求头集合。
 */
function buildForwardHeaders(req, config) {
  const headers = new Headers();

  for (const [name, value] of Object.entries(req.headers)) {
    const normalizedName = name.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(normalizedName) || typeof value === "undefined") {
      continue;
    }

    // 业务逻辑：多值请求头按 HTTP 语义合并，便于 fetch 正常转发。
    headers.set(name, Array.isArray(value) ? value.join(", ") : String(value));
  }

  // 业务逻辑：如果用户在代理服务配置了 Aisle API Key，则由代理统一补充 Authorization。
  if (config.apiKey && !headers.has("authorization")) {
    headers.set("authorization", `Bearer ${config.apiKey}`);
  }

  return headers;
}

/**
 * 方法功能：读取并解析客户端 JSON 请求体。
 * 签名注释：readJsonBody(req: http.IncomingMessage): Promise<object>
 *
 * @param {http.IncomingMessage} req Node.js 原生 HTTP 请求。
 * @returns {Promise<object>} 解析后的 JSON 对象。
 */
async function readJsonBody(req) {
  const chunks = [];

  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const rawBody = Buffer.concat(chunks).toString("utf8");
  if (!rawBody.trim()) {
    return {};
  }

  return JSON.parse(rawBody);
}

/**
 * 方法功能：把 OpenAI messages 转换为适合 Aisle prompt 变量的用户输入文本。
 * 签名注释：extractPromptText(payload: object): string
 *
 * @param {{messages?: Array<{role?: string, content?: unknown}>, prompt?: unknown, input?: unknown}} payload OpenAI 兼容请求体。
 * @returns {string} 提取出的用户输入文本。
 */
function extractPromptText(payload) {
  if (typeof payload.prompt === "string") {
    return payload.prompt;
  }

  if (typeof payload.input === "string") {
    return payload.input;
  }

  if (!Array.isArray(payload.messages)) {
    return "";
  }

  const lastUserMessage = [...payload.messages].reverse().find((message) => message && message.role === "user");
  const targetMessage = lastUserMessage || payload.messages[payload.messages.length - 1];

  return normalizeMessageContent(targetMessage ? targetMessage.content : "");
}

/**
 * 方法功能：把 OpenAI 的多模态 content 规整为文本。
 * 签名注释：normalizeMessageContent(content: unknown): string
 *
 * @param {unknown} content OpenAI message.content 字段。
 * @returns {string} 可传给 Aisle prompt 变量的文本。
 */
function normalizeMessageContent(content) {
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") {
          return part;
        }
        if (part && typeof part === "object" && typeof part.text === "string") {
          return part.text;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }

  return "";
}

/**
 * 方法功能：构造 Aisle prompt API 所需的扁平变量请求体。
 * 签名注释：buildAislePromptPayload(payload: object, config: object): object
 *
 * @param {object} payload OpenAI 兼容请求体。
 * @param {{variableName: string}} config 服务配置对象。
 * @returns {object} Aisle prompt API 请求体。
 */
function buildAislePromptPayload(payload, config) {
  const promptText = extractPromptText(payload);
  const upstreamPayload = {
    [config.variableName]: promptText,
    variable_name: promptText,
    prompt: promptText,
    input: promptText,
    message: promptText,
    query: promptText,
    text: promptText,
    your_param: promptText
  };

  // 业务逻辑：该 Aisle endpoint 实测需要扁平 JSON，页面示例里的 variables 嵌套不会替换模板变量。
  if (payload.variables && typeof payload.variables === "object" && !Array.isArray(payload.variables)) {
    Object.assign(upstreamPayload, payload.variables);
  }

  return upstreamPayload;
}

/**
 * 方法功能：解析 Aisle prompt API 返回内容为纯文本。
 * 签名注释：extractAisleText(rawText: string): string
 *
 * @param {string} rawText 上游返回的原始响应文本。
 * @returns {string} 助手回复文本。
 */
function extractAisleText(rawText) {
  if (!rawText) {
    return "";
  }

  try {
    const parsed = JSON.parse(rawText);
    if (typeof parsed === "string") {
      return parsed;
    }
    if (parsed && typeof parsed === "object") {
      return parsed.output || parsed.text || parsed.content || parsed.message || JSON.stringify(parsed);
    }
  } catch (_error) {
    // 业务逻辑：上游也可能直接返回 text/plain，无法 JSON 解析时按原文处理。
  }

  return rawText;
}

/**
 * 方法功能：构造 OpenAI 非流式 chat completions 响应。
 * 签名注释：buildChatCompletionResponse(content: string, payload: object, config: object): object
 *
 * @param {string} content Aisle 返回的助手文本。
 * @param {{model?: string}} payload OpenAI 兼容请求体。
 * @param {{modelName: string}} config 服务配置对象。
 * @returns {object} OpenAI chat.completion 响应体。
 */
function buildChatCompletionResponse(content, payload, config) {
  return {
    id: `chatcmpl-aisle-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: payload.model || config.modelName,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content
        },
        finish_reason: "stop"
      }
    ],
    usage: {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0
    }
  };
}

/**
 * 方法功能：返回 OpenAI 兼容的模型列表，满足 Cherry Studio 的模型探测。
 * 签名注释：sendModels(res: http.ServerResponse, config: object): void
 *
 * @param {http.ServerResponse} res Node.js 原生 HTTP 响应。
 * @param {{modelName: string}} config 服务配置对象。
 */
function sendModels(res, config) {
  sendJson(res, 200, {
    object: "list",
    data: [
      {
        id: config.modelName,
        object: "model",
        created: 0,
        owned_by: "aisle"
      }
    ]
  });
}

/**
 * 方法功能：返回 OpenAI 兼容的错误响应，避免客户端解析上游非标准错误失败。
 * 签名注释：sendOpenAiError(res: http.ServerResponse, statusCode: number, message: string, type?: string): void
 *
 * @param {http.ServerResponse} res Node.js 原生 HTTP 响应。
 * @param {number} statusCode HTTP 状态码。
 * @param {string} message 错误说明。
 * @param {string} type OpenAI 错误类型。
 */
function sendOpenAiError(res, statusCode, message, type = "aisle_proxy_error") {
  sendJson(res, statusCode, {
    error: {
      message,
      type,
      param: null,
      code: null
    }
  });
}

/**
 * 方法功能：以 SSE 格式写出单次 OpenAI 流式响应。
 * 签名注释：sendStreamResponse(res: http.ServerResponse, content: string, payload: object, config: object): void
 *
 * @param {http.ServerResponse} res Node.js 原生 HTTP 响应。
 * @param {string} content Aisle 返回的助手文本。
 * @param {{model?: string}} payload OpenAI 兼容请求体。
 * @param {{modelName: string}} config 服务配置对象。
 */
function sendStreamResponse(res, content, payload, config) {
  const id = `chatcmpl-aisle-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);
  const model = payload.model || config.modelName;
  const chunks = [
    {
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }]
    },
    {
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta: { content }, finish_reason: null }]
    },
    {
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }]
    }
  ];

  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no"
  });

  // 业务逻辑：Aisle prompt API 本身是非流式接口，这里包装成 Cherry/OpenAI SDK 能消费的一次性 SSE。
  for (const chunk of chunks) {
    res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  }
  res.end("data: [DONE]\n\n");
}

/**
 * 方法功能：向客户端返回 JSON 错误响应。
 * 签名注释：sendJson(res: http.ServerResponse, statusCode: number, payload: object): void
 *
 * @param {http.ServerResponse} res Node.js 原生 HTTP 响应。
 * @param {number} statusCode HTTP 状态码。
 * @param {object} payload JSON 响应体。
 */
function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);

  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body)
  });
  res.end(body);
}

/**
 * 方法功能：处理健康检查请求。
 * 签名注释：handleHealth(req: http.IncomingMessage, res: http.ServerResponse, config: object): boolean
 *
 * @param {http.IncomingMessage} req Node.js 原生 HTTP 请求。
 * @param {http.ServerResponse} res Node.js 原生 HTTP 响应。
 * @param {{promptUrl: URL, completionUrl: URL}} config 服务配置对象。
 * @returns {boolean} 是否已经处理当前请求。
 */
function handleHealth(req, res, config) {
  const requestUrl = new URL(req.url || "/", "http://localhost");

  if (req.method !== "GET" || requestUrl.pathname !== "/health") {
    return false;
  }

  sendJson(res, 200, {
    ok: true,
    upstream: config.promptUrl.toString(),
    compatibleEndpoint: config.completionUrl.toString()
  });

  return true;
}

/**
 * 方法功能：把 OpenAI chat completions 请求适配到 Aisle prompt API。
 * 签名注释：proxyChatCompletion(req: http.IncomingMessage, res: http.ServerResponse, config: object): Promise<void>
 *
 * @param {http.IncomingMessage} req Node.js 原生 HTTP 请求。
 * @param {http.ServerResponse} res Node.js 原生 HTTP 响应。
 * @param {{promptUrl: URL, apiKey: string, timeoutMs: number, modelName: string, variableName: string}} config 服务配置对象。
 */
async function proxyChatCompletion(req, res, config) {
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), config.timeoutMs);

  try {
    const payload = await readJsonBody(req);
    const upstreamPayload = buildAislePromptPayload(payload, config);
    const headers = buildForwardHeaders(req, config);
    headers.set("content-type", "application/json");

    // 业务逻辑：Aisle 真实可用接口是 prompt endpoint，这里把 OpenAI messages 转成 variables 后提交。
    const upstreamResponse = await fetch(config.promptUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(upstreamPayload),
      signal: abortController.signal
    });

    const upstreamText = await upstreamResponse.text();

    if (!upstreamResponse.ok) {
      sendOpenAiError(res, upstreamResponse.status, extractAisleText(upstreamText), "upstream_error");
      return;
    }

    const content = extractAisleText(upstreamText);
    if (payload.stream === true) {
      sendStreamResponse(res, content, payload, config);
      return;
    }

    sendJson(res, 200, buildChatCompletionResponse(content, payload, config));
  } catch (error) {
    if (res.headersSent) {
      res.destroy(error);
      return;
    }

    const statusCode = error.name === "AbortError" ? 504 : 502;
    sendOpenAiError(res, statusCode, error.message);
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * 方法功能：创建 HTTP 反代服务实例。
 * 签名注释：createServer(config: object): http.Server
 *
 * @param {{promptUrl: URL, completionUrl: URL, apiKey: string, timeoutMs: number, modelName: string, variableName: string}} config 服务配置对象。
 * @returns {http.Server} Node.js HTTP 服务实例。
 */
function createServer(config) {
  return http.createServer(async (req, res) => {
    if (handleHealth(req, res, config)) {
      return;
    }

    if (isModelsRequest(req)) {
      sendModels(res, config);
      return;
    }

    if (!isChatCompletionRequest(req)) {
      sendJson(res, 404, {
        error: {
          message: "仅支持 GET /v1/models、POST /v1/chat/completions、/chat/completions 或 /run_aisle/prompts/{promptId}。",
          type: "not_found"
        }
      });
      return;
    }

    await proxyChatCompletion(req, res, config);
  });
}

/**
 * 方法功能：启动服务并监听配置端口。
 * 签名注释：start(): void
 */
function start() {
  const config = resolveConfig();
  const server = createServer(config);

  server.listen(config.port, config.host, () => {
    console.log(`Aisle API proxy listening on http://${config.host}:${config.port}`);
    console.log(`Adapting chat completions to ${config.promptUrl.toString()}`);
  });
}

if (require.main === module) {
  start();
}

module.exports = {
  buildForwardHeaders,
  buildAislePromptPayload,
  buildChatCompletionResponse,
  createServer,
  deriveCompletionUrl,
  derivePromptUrl,
  extractAisleText,
  extractPromptText,
  isChatCompletionRequest,
  isModelsRequest,
  resolveConfig
};
