"use strict";

const http = require("node:http");
const { Readable } = require("node:stream");

const DEFAULT_PORT = 3000;
const DEFAULT_HOST = "0.0.0.0";

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
 * 方法功能：从用户配置的 Aisle prompt 地址推导标准 chat completions 地址。
 * 签名注释：deriveCompletionUrl(promptUrl: string, explicitCompletionUrl?: string): URL
 *
 * @param {string} promptUrl 用户配置的形如 https://api.aisle.sh/run_aisle/prompts/{id} 的地址。
 * @param {string | undefined} explicitCompletionUrl 可选的完整目标地址覆盖值。
 * @returns {URL} 推导后的 https://api.aisle.sh/run_aisle/v1/chat/completions 地址。
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
 * 方法功能：读取环境变量并组装服务运行配置。
 * 签名注释：resolveConfig(env?: NodeJS.ProcessEnv): object
 *
 * @param {NodeJS.ProcessEnv} env 运行环境变量，默认使用 process.env。
 * @returns {{host: string, port: number, promptUrl: string, completionUrl: URL, apiKey: string, timeoutMs: number}} 服务配置对象。
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
    promptUrl: env.AISLE_PROMPT_URL || "",
    completionUrl: deriveCompletionUrl(env.AISLE_PROMPT_URL || "", env.AISLE_COMPLETION_URL),
    apiKey: env.AISLE_API_KEY || "",
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
      /^\/run_aisle\/prompts\/[^/]+$/.test(pathname)
    )
  );
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
 * @param {{completionUrl: URL}} config 服务配置对象。
 * @returns {boolean} 是否已经处理当前请求。
 */
function handleHealth(req, res, config) {
  const requestUrl = new URL(req.url || "/", "http://localhost");

  if (req.method !== "GET" || requestUrl.pathname !== "/health") {
    return false;
  }

  sendJson(res, 200, {
    ok: true,
    upstream: config.completionUrl.toString()
  });

  return true;
}

/**
 * 方法功能：把客户端请求反向代理到推导后的 Aisle chat completions 地址。
 * 签名注释：proxyChatCompletion(req: http.IncomingMessage, res: http.ServerResponse, config: object): Promise<void>
 *
 * @param {http.IncomingMessage} req Node.js 原生 HTTP 请求。
 * @param {http.ServerResponse} res Node.js 原生 HTTP 响应。
 * @param {{completionUrl: URL, apiKey: string, timeoutMs: number}} config 服务配置对象。
 */
async function proxyChatCompletion(req, res, config) {
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), config.timeoutMs);

  try {
    // 业务逻辑：不改写请求体，保证 OpenAI SDK 传入的 messages/model/stream 等字段原样送达上游。
    const upstreamResponse = await fetch(config.completionUrl, {
      method: "POST",
      headers: buildForwardHeaders(req, config),
      body: req,
      duplex: "half",
      signal: abortController.signal
    });

    const responseHeaders = {};
    upstreamResponse.headers.forEach((value, name) => {
      if (!HOP_BY_HOP_HEADERS.has(name.toLowerCase())) {
        responseHeaders[name] = value;
      }
    });

    res.writeHead(upstreamResponse.status, responseHeaders);

    if (upstreamResponse.body) {
      // 业务逻辑：使用流式管道转发响应，兼容 Aisle/OpenAI 的 stream=true SSE 输出。
      Readable.fromWeb(upstreamResponse.body).pipe(res);
    } else {
      res.end();
    }
  } catch (error) {
    if (res.headersSent) {
      res.destroy(error);
      return;
    }

    const statusCode = error.name === "AbortError" ? 504 : 502;
    sendJson(res, statusCode, {
      error: {
        message: error.message,
        type: "aisle_proxy_error"
      }
    });
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * 方法功能：创建 HTTP 反代服务实例。
 * 签名注释：createServer(config: object): http.Server
 *
 * @param {{completionUrl: URL, apiKey: string, timeoutMs: number}} config 服务配置对象。
 * @returns {http.Server} Node.js HTTP 服务实例。
 */
function createServer(config) {
  return http.createServer(async (req, res) => {
    if (handleHealth(req, res, config)) {
      return;
    }

    if (!isChatCompletionRequest(req)) {
      sendJson(res, 404, {
        error: {
          message: "仅支持 POST /v1/chat/completions、/chat/completions 或 /run_aisle/prompts/{promptId}。",
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
    console.log(`Forwarding chat completions to ${config.completionUrl.toString()}`);
  });
}

if (require.main === module) {
  start();
}

module.exports = {
  buildForwardHeaders,
  createServer,
  deriveCompletionUrl,
  isChatCompletionRequest,
  resolveConfig
};
