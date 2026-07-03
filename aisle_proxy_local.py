#!/usr/bin/env python3
"""本地运行版 Aisle OpenAI 兼容适配代理。"""

from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.request
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import urlparse, urlunparse


DEFAULT_HOST = "0.0.0.0"
DEFAULT_PORT = 3000
DEFAULT_MODEL_NAME = "aisle-prompt"
DEFAULT_VARIABLE_NAME = "variable_name"

HOP_BY_HOP_HEADERS = {
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
    "host",
    "content-length",
    "accept-encoding",
}


def derive_prompt_url(prompt_url: str) -> str:
    """方法功能：校验并返回真实可调用的 Aisle prompt 地址。

    签名注释：derive_prompt_url(prompt_url: str) -> str
    """

    if not prompt_url:
        raise ValueError("缺少 AISLE_PROMPT_URL，请配置 Aisle prompt API 地址。")

    parsed_url = urlparse(prompt_url)
    path_segments = [segment for segment in parsed_url.path.split("/") if segment]

    try:
        run_aisle_index = path_segments.index("run_aisle")
        prompts_index = path_segments.index("prompts")
    except ValueError as exc:
        raise ValueError("AISLE_PROMPT_URL 格式不正确，应类似 https://api.aisle.sh/run_aisle/prompts/{promptId}。") from exc

    if prompts_index != run_aisle_index + 1 or prompts_index + 1 >= len(path_segments):
        raise ValueError("AISLE_PROMPT_URL 格式不正确，应类似 https://api.aisle.sh/run_aisle/prompts/{promptId}。")

    return prompt_url


def derive_completion_url(prompt_url: str, explicit_completion_url: str | None = None) -> str:
    """方法功能：从 Aisle prompt 地址推导 OpenAI 兼容接口展示地址。

    签名注释：derive_completion_url(prompt_url: str, explicit_completion_url: str | None = None) -> str
    """

    if explicit_completion_url:
        return explicit_completion_url

    derive_prompt_url(prompt_url)
    parsed_url = urlparse(prompt_url)
    path_segments = [segment for segment in parsed_url.path.split("/") if segment]
    run_aisle_index = path_segments.index("run_aisle")
    prefix_segments = path_segments[: run_aisle_index + 1]
    compatible_path = "/" + "/".join([*prefix_segments, "v1", "chat", "completions"])

    # 业务逻辑：这个地址只用于健康检查展示，真实上游调用仍走 prompt endpoint。
    return urlunparse(parsed_url._replace(path=compatible_path, query="", fragment=""))


def load_config() -> dict[str, Any]:
    """方法功能：从环境变量读取本地代理运行配置。

    签名注释：load_config() -> dict[str, Any]
    """

    port = int(os.environ.get("PORT", DEFAULT_PORT))
    if port <= 0 or port > 65535:
        raise ValueError("PORT 必须是 1 到 65535 之间的端口号。")

    prompt_url = derive_prompt_url(os.environ.get("AISLE_PROMPT_URL", ""))
    return {
        "host": os.environ.get("HOST", DEFAULT_HOST),
        "port": port,
        "prompt_url": prompt_url,
        "completion_url": derive_completion_url(prompt_url, os.environ.get("AISLE_COMPLETION_URL")),
        "api_key": os.environ.get("AISLE_API_KEY", ""),
        "model_name": os.environ.get("AISLE_MODEL_NAME", DEFAULT_MODEL_NAME),
        "variable_name": os.environ.get("AISLE_VARIABLE_NAME", DEFAULT_VARIABLE_NAME),
        "timeout": int(os.environ.get("PROXY_TIMEOUT_MS", "120000")) / 1000,
    }


def normalize_path(path: str) -> str:
    """方法功能：规整请求路径，去除末尾斜杠。

    签名注释：normalize_path(path: str) -> str
    """

    normalized = path.rstrip("/")
    return normalized or "/"


def is_chat_completion_path(path: str) -> bool:
    """方法功能：判断请求路径是否为 OpenAI chat completions 兼容接口。

    签名注释：is_chat_completion_path(path: str) -> bool
    """

    normalized = normalize_path(path)
    return (
        normalized in {"/v1/chat/completions", "/chat/completions"}
        or normalized.endswith("/chat/completions")
        or (normalized.startswith("/run_aisle/prompts/") and len(normalized.split("/")) == 4)
    )


def is_models_path(path: str) -> bool:
    """方法功能：判断请求路径是否为 OpenAI models 查询接口。

    签名注释：is_models_path(path: str) -> bool
    """

    normalized = normalize_path(path)
    return normalized in {"/v1/models", "/models"} or normalized.endswith("/models")


def normalize_message_content(content: Any) -> str:
    """方法功能：把 OpenAI message.content 规整为纯文本。

    签名注释：normalize_message_content(content: Any) -> str
    """

    if isinstance(content, str):
        return content

    if isinstance(content, list):
        text_parts: list[str] = []
        for part in content:
            if isinstance(part, str):
                text_parts.append(part)
            elif isinstance(part, dict) and isinstance(part.get("text"), str):
                text_parts.append(part["text"])
        return "\n".join(text_parts)

    return ""


def extract_prompt_text(payload: dict[str, Any]) -> str:
    """方法功能：从 OpenAI 兼容请求体提取用户输入文本。

    签名注释：extract_prompt_text(payload: dict[str, Any]) -> str
    """

    if isinstance(payload.get("prompt"), str):
        return payload["prompt"]

    if isinstance(payload.get("input"), str):
        return payload["input"]

    messages = payload.get("messages")
    if not isinstance(messages, list) or not messages:
        return ""

    # 业务逻辑：优先取最后一条 user 消息，符合聊天软件连续对话的常见语义。
    for message in reversed(messages):
        if isinstance(message, dict) and message.get("role") == "user":
            return normalize_message_content(message.get("content"))

    last_message = messages[-1]
    if isinstance(last_message, dict):
        return normalize_message_content(last_message.get("content"))

    return ""


def build_aisle_prompt_payload(payload: dict[str, Any], config: dict[str, Any]) -> dict[str, Any]:
    """方法功能：构造 Aisle prompt API 实测可用的扁平变量请求体。

    签名注释：build_aisle_prompt_payload(payload: dict[str, Any], config: dict[str, Any]) -> dict[str, Any]
    """

    prompt_text = extract_prompt_text(payload)
    upstream_payload = {
        config["variable_name"]: prompt_text,
        "variable_name": prompt_text,
        "prompt": prompt_text,
        "input": prompt_text,
        "message": prompt_text,
        "query": prompt_text,
        "text": prompt_text,
        "your_param": prompt_text,
    }

    # 业务逻辑：允许调用方通过 variables 显式补充或覆盖 Aisle 模板变量。
    variables = payload.get("variables")
    if isinstance(variables, dict):
        upstream_payload.update(variables)

    return upstream_payload


def extract_aisle_text(raw_text: str) -> str:
    """方法功能：把 Aisle 返回内容解析为助手回复文本。

    签名注释：extract_aisle_text(raw_text: str) -> str
    """

    if not raw_text:
        return ""

    try:
        parsed = json.loads(raw_text)
    except json.JSONDecodeError:
        return raw_text

    if isinstance(parsed, str):
        return parsed

    if isinstance(parsed, dict):
        for key in ("output", "text", "content", "message"):
            if isinstance(parsed.get(key), str):
                return parsed[key]
        return json.dumps(parsed, ensure_ascii=False)

    return str(parsed)


def build_chat_completion_response(content: str, payload: dict[str, Any], config: dict[str, Any]) -> dict[str, Any]:
    """方法功能：构造 OpenAI 非流式 chat completions 响应。

    签名注释：build_chat_completion_response(content: str, payload: dict[str, Any], config: dict[str, Any]) -> dict[str, Any]
    """

    return {
        "id": f"chatcmpl-aisle-{int(time.time() * 1000)}",
        "object": "chat.completion",
        "created": int(time.time()),
        "model": payload.get("model") or config["model_name"],
        "choices": [
            {
                "index": 0,
                "message": {"role": "assistant", "content": content},
                "finish_reason": "stop",
            }
        ],
        "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
    }


def build_forward_headers(handler: BaseHTTPRequestHandler, config: dict[str, Any]) -> dict[str, str]:
    """方法功能：构造转发给 Aisle 上游的 HTTP 请求头。

    签名注释：build_forward_headers(handler: BaseHTTPRequestHandler, config: dict[str, Any]) -> dict[str, str]
    """

    headers: dict[str, str] = {}
    for name, value in handler.headers.items():
        if name.lower() in HOP_BY_HOP_HEADERS:
            continue
        headers[name] = value

    # 业务逻辑：如果客户端没有传 Authorization，则由本地代理统一补上环境变量里的 Aisle key。
    if config["api_key"] and "Authorization" not in headers and "authorization" not in {key.lower() for key in headers}:
        headers["Authorization"] = f"Bearer {config['api_key']}"

    headers["Content-Type"] = "application/json"
    # 业务逻辑：Python 标准库不会自动处理所有上游压缩格式，这里要求上游返回明文响应。
    headers["Accept-Encoding"] = "identity"
    return headers


def call_aisle_prompt(
    upstream_payload: dict[str, Any],
    handler: BaseHTTPRequestHandler,
    config: dict[str, Any],
) -> tuple[int, str]:
    """方法功能：调用真实 Aisle prompt endpoint 并返回状态码与文本。

    签名注释：call_aisle_prompt(upstream_payload: dict[str, Any], handler: BaseHTTPRequestHandler, config: dict[str, Any]) -> tuple[int, str]
    """

    body = json.dumps(upstream_payload, ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(
        config["prompt_url"],
        data=body,
        headers=build_forward_headers(handler, config),
        method="POST",
    )

    try:
        with urllib.request.urlopen(request, timeout=config["timeout"]) as response:
            return response.status, response.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as error:
        return error.code, error.read().decode("utf-8", errors="replace")


class AisleProxyHandler(BaseHTTPRequestHandler):
    """方法功能：处理本地 OpenAI 兼容 HTTP 请求并适配到 Aisle prompt API。

    签名注释：class AisleProxyHandler(BaseHTTPRequestHandler)
    """

    server_version = "AisleLocalProxy/1.0"

    def log_message(self, format: str, *args: Any) -> None:
        """方法功能：输出简洁访问日志。

        签名注释：log_message(self, format: str, *args: Any) -> None
        """

        print(f"{self.address_string()} - {format % args}")

    def do_OPTIONS(self) -> None:
        """方法功能：处理浏览器预检请求。

        签名注释：do_OPTIONS(self) -> None
        """

        self.send_response(HTTPStatus.NO_CONTENT)
        self.send_common_headers("application/json; charset=utf-8")
        self.end_headers()

    def do_GET(self) -> None:
        """方法功能：处理健康检查与模型列表请求。

        签名注释：do_GET(self) -> None
        """

        config = self.server.config  # type: ignore[attr-defined]
        path = urlparse(self.path).path

        if normalize_path(path) == "/health":
            self.send_json(
                HTTPStatus.OK,
                {
                    "ok": True,
                    "upstream": config["prompt_url"],
                    "compatibleEndpoint": config["completion_url"],
                },
            )
            return

        if is_models_path(path):
            self.send_json(
                HTTPStatus.OK,
                {
                    "object": "list",
                    "data": [
                        {
                            "id": config["model_name"],
                            "object": "model",
                            "created": 0,
                            "owned_by": "aisle",
                        }
                    ],
                },
            )
            return

        self.send_openai_error(HTTPStatus.NOT_FOUND, "仅支持 GET /health、GET /v1/models 和 POST /v1/chat/completions。", "not_found")

    def do_POST(self) -> None:
        """方法功能：处理 OpenAI chat completions 兼容请求。

        签名注释：do_POST(self) -> None
        """

        config = self.server.config  # type: ignore[attr-defined]
        path = urlparse(self.path).path

        if not is_chat_completion_path(path):
            self.send_openai_error(HTTPStatus.NOT_FOUND, "仅支持 POST /v1/chat/completions。", "not_found")
            return

        try:
            payload = self.read_json_body()
            upstream_payload = build_aisle_prompt_payload(payload, config)
            status_code, upstream_text = call_aisle_prompt(upstream_payload, self, config)
            content = extract_aisle_text(upstream_text)

            if status_code < 200 or status_code >= 300:
                self.send_openai_error(status_code, content, "upstream_error")
                return

            if payload.get("stream") is True:
                self.send_stream_response(content, payload, config)
                return

            self.send_json(HTTPStatus.OK, build_chat_completion_response(content, payload, config))
        except json.JSONDecodeError as error:
            self.send_openai_error(HTTPStatus.BAD_REQUEST, str(error), "invalid_request_error")
        except Exception as error:  # noqa: BLE001
            self.send_openai_error(HTTPStatus.BAD_GATEWAY, str(error), "aisle_proxy_error")

    def read_json_body(self) -> dict[str, Any]:
        """方法功能：读取并解析客户端 JSON 请求体。

        签名注释：read_json_body(self) -> dict[str, Any]
        """

        content_length = int(self.headers.get("Content-Length", "0") or "0")
        if content_length <= 0:
            return {}

        raw_body = self.rfile.read(content_length).decode("utf-8")
        if not raw_body.strip():
            return {}

        return json.loads(raw_body)

    def send_common_headers(self, content_type: str) -> None:
        """方法功能：发送通用响应头。

        签名注释：send_common_headers(self, content_type: str) -> None
        """

        self.send_header("Content-Type", content_type)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")

    def send_json(self, status_code: int, payload: dict[str, Any]) -> None:
        """方法功能：发送 JSON 响应。

        签名注释：send_json(self, status_code: int, payload: dict[str, Any]) -> None
        """

        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status_code)
        self.send_common_headers("application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def send_openai_error(self, status_code: int, message: str, error_type: str) -> None:
        """方法功能：发送 OpenAI 兼容错误响应。

        签名注释：send_openai_error(self, status_code: int, message: str, error_type: str) -> None
        """

        self.send_json(
            status_code,
            {"error": {"message": message, "type": error_type, "param": None, "code": None}},
        )

    def send_stream_response(self, content: str, payload: dict[str, Any], config: dict[str, Any]) -> None:
        """方法功能：把非流式 Aisle 结果包装成 OpenAI SSE 流式响应。

        签名注释：send_stream_response(self, content: str, payload: dict[str, Any], config: dict[str, Any]) -> None
        """

        chunk_id = f"chatcmpl-aisle-{int(time.time() * 1000)}"
        created = int(time.time())
        model = payload.get("model") or config["model_name"]
        chunks = [
            {
                "id": chunk_id,
                "object": "chat.completion.chunk",
                "created": created,
                "model": model,
                "choices": [{"index": 0, "delta": {"role": "assistant"}, "finish_reason": None}],
            },
            {
                "id": chunk_id,
                "object": "chat.completion.chunk",
                "created": created,
                "model": model,
                "choices": [{"index": 0, "delta": {"content": content}, "finish_reason": None}],
            },
            {
                "id": chunk_id,
                "object": "chat.completion.chunk",
                "created": created,
                "model": model,
                "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
            },
        ]

        self.send_response(HTTPStatus.OK)
        self.send_common_headers("text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache, no-transform")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()

        # 业务逻辑：Aisle 上游不支持真正流式输出，本地脚本按 OpenAI SSE 协议一次性写出完整结果。
        for chunk in chunks:
            data = json.dumps(chunk, ensure_ascii=False)
            self.wfile.write(f"data: {data}\n\n".encode("utf-8"))
        self.wfile.write(b"data: [DONE]\n\n")


def main() -> None:
    """方法功能：启动本地 HTTP 代理服务。

    签名注释：main() -> None
    """

    config = load_config()
    server = ThreadingHTTPServer((config["host"], config["port"]), AisleProxyHandler)
    server.config = config  # type: ignore[attr-defined]

    print(f"Aisle local proxy listening on http://{config['host']}:{config['port']}")
    print(f"Adapting chat completions to {config['prompt_url']}")
    server.serve_forever()


if __name__ == "__main__":
    main()
