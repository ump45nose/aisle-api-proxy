# Aisle API Proxy

把 Aisle 暴露的非标准 prompt API 地址：

```text
https://api.aisle.sh/run_aisle/prompts/asdasda897-cc91-457f-83aa-44bdd
```

自动转换并反向代理到标准 OpenAI Chat Completions 风格地址：

```text
https://api.aisle.sh/run_aisle/v1/chat/completions
```

## 功能

- 读取 `AISLE_PROMPT_URL`，自动推导上游 `chat/completions` 地址。
- 对外提供 `POST /v1/chat/completions`，可用于大多数 OpenAI SDK 的 `baseURL`。
- 兼容 `POST /chat/completions` 和 `POST /run_aisle/prompts/{promptId}`。
- 原样转发请求体，支持 `stream: true` 的流式响应。
- 支持 Docker 与 Docker Compose 部署。

## 环境变量

| 变量 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `AISLE_PROMPT_URL` | 是 | 无 | Aisle 原始 prompt API 地址，例如 `https://api.aisle.sh/run_aisle/prompts/asdasda897-cc91-457f-83aa-44bdd` |
| `AISLE_API_KEY` | 否 | 无 | 如果客户端不传 `Authorization`，代理会自动补充 `Bearer ${AISLE_API_KEY}` |
| `AISLE_COMPLETION_URL` | 否 | 自动推导 | 手动覆盖最终上游地址 |
| `PORT` | 否 | `3000` | 服务监听端口 |
| `HOST` | 否 | `0.0.0.0` | 服务监听地址 |
| `PROXY_TIMEOUT_MS` | 否 | `120000` | 上游请求超时时间，单位毫秒 |

## Docker Compose 部署

1. 修改 `docker-compose.yml` 中的 `AISLE_PROMPT_URL`：

```yaml
environment:
  AISLE_PROMPT_URL: "https://api.aisle.sh/run_aisle/prompts/asdasda897-cc91-457f-83aa-44bdd"
```

2. 启动服务：

```bash
docker compose up -d --build
```

3. 健康检查：

```bash
curl http://localhost:3000/health
```

## NAS llm compose 部署记录

已在 NAS `192.168.31.201` 的 `llm` stack 中部署，访问地址：

```text
http://192.168.31.201:8320/v1/chat/completions
```

健康检查：

```bash
curl http://192.168.31.201:8320/health
```

本次 NAS 的 Docker 镜像源无法拉取 `node:20-alpine`，`llm` stack 中实际复用了已有的 `ghcr.io/sillytavern/sillytavern:latest` Node 运行环境，并通过只读挂载 `/vol2/1000/Docker/aisle-api-proxy` 运行：

```yaml
aisle-api-proxy:
  container_name: aisle-api-proxy
  image: ghcr.io/sillytavern/sillytavern:latest
  user: ${MY_UID}:${MY_GID}
  working_dir: /app
  entrypoint: ["node"]
  command: ["src/server.js"]
  volumes:
    - ${BASE_PATH}/aisle-api-proxy:/app:ro
  environment:
    AISLE_PROMPT_URL: "https://api.aisle.sh/run_aisle/prompts/asdasda897-cc91-457f-83aa-44bdd"
    PROXY_TIMEOUT_MS: "120000"
  ports:
    - 8320:3000
  restart: unless-stopped
```

## Docker 命令部署

```bash
docker build -t aisle-api-proxy .
docker run -d \
  --name aisle-api-proxy \
  -p 3000:3000 \
  -e AISLE_PROMPT_URL="https://api.aisle.sh/run_aisle/prompts/asdasda897-cc91-457f-83aa-44bdd" \
  aisle-api-proxy
```

如果需要由代理统一携带 Aisle API Key：

```bash
docker run -d \
  --name aisle-api-proxy \
  -p 3000:3000 \
  -e AISLE_PROMPT_URL="https://api.aisle.sh/run_aisle/prompts/asdasda897-cc91-457f-83aa-44bdd" \
  -e AISLE_API_KEY="sk-your-aisle-key" \
  aisle-api-proxy
```

## OpenAI SDK 使用方式

将 SDK 的 `baseURL` 指向代理服务：

```js
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: "sk-your-aisle-key",
  baseURL: "http://localhost:3000/v1"
});

const completion = await client.chat.completions.create({
  model: "gpt-4.1",
  messages: [{ role: "user", content: "你好" }]
});
```

SDK 会请求：

```text
POST http://localhost:3000/v1/chat/completions
```

代理实际转发到：

```text
POST https://api.aisle.sh/run_aisle/v1/chat/completions
```

## 本地运行

需要 Node.js 20 或更高版本。

```bash
npm install
$env:AISLE_PROMPT_URL="https://api.aisle.sh/run_aisle/prompts/asdasda897-cc91-457f-83aa-44bdd"
npm start
```

Linux/macOS：

```bash
AISLE_PROMPT_URL="https://api.aisle.sh/run_aisle/prompts/asdasda897-cc91-457f-83aa-44bdd" npm start
```

## 测试

```bash
npm test
```
