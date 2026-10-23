"""Credential-injecting proxy for the Claude API.

The agent sends plain HTTP to this proxy with a placeholder token. The proxy replaces the
authentication headers with the real subscription token and forwards the request to
https://api.anthropic.com. The real token never enters the agent container. A request with
an attacker's API key cannot reach the attacker's account: the proxy always overwrites the
credentials.

Env:
  CLAUDE_CODE_OAUTH_TOKEN  real token from "claude setup-token". Removed from os.environ at
                           start, so child processes do not get it. It stays in
                           /proc/<pid>/environ of this process; the agent has no access to
                           this container.
  API_PROXY_PORT           listen port (default 8080)

Usage: from the anthropic-ratelimit-unified-* response headers the proxy logs one line,
"api-proxy: usage {json}", when the validated values change and at least every
USAGE_REPEAT_S while requests run, so the log timestamp shows the age. No other header is logged.
"""

import http.client
import json
import math
import os
import re
import ssl
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

UPSTREAM_HOST = "api.anthropic.com"
OAUTH_BETA = "oauth-2025-04-20"
# Only the model endpoints. Other paths on api.anthropic.com accept the same token and can,
# for example, mint an API key and return it to the caller.
ALLOWED_PREFIXES = ("/v1/messages",)
MAX_BODY = 64 * 1024 * 1024
CHUNK = 16 * 1024
WORD = re.compile(r"[a-z_]{1,32}")
UNIFIED = "anthropic-ratelimit-unified-"
USAGE_REPEAT_S = 300

# Headers that describe one connection, never forwarded (RFC 9110, section 7.6.1).
HOP_BY_HOP = {
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "proxy-connection",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
}
# Request headers the proxy sets itself.
REPLACED = HOP_BY_HOP | {"host", "authorization", "x-api-key", "content-length"}


def log(msg: str) -> None:
    print(f"api-proxy: {msg}", file=sys.stderr, flush=True)


def load_token() -> str:
    token = os.environ.pop("CLAUDE_CODE_OAUTH_TOKEN", "").strip()
    if not token.startswith("sk-ant-oat"):
        log(
            "FATAL, CLAUDE_CODE_OAUTH_TOKEN is missing or is not a token from 'claude setup-token'"
        )
        sys.exit(1)
    return token


TOKEN = load_token()
TLS = ssl.create_default_context()

_usage_lock = threading.Lock()
_last_usage: dict | None = None
_last_usage_at = 0.0


def _window(headers: http.client.HTTPMessage, name: str) -> dict | None:
    util_raw = headers.get(f"{UNIFIED}{name}-utilization")
    reset_raw = headers.get(f"{UNIFIED}{name}-reset")
    if util_raw is None or reset_raw is None:
        return None
    try:
        util = float(util_raw.strip())
        reset = int(reset_raw.strip())
    except ValueError:
        return None
    if not math.isfinite(util) or not 0 <= util <= 10 or not 0 < reset < 2**33:
        return None
    return {"utilization": util, "resets_at": reset}


def parse_usage(headers: http.client.HTTPMessage) -> dict:
    """Validated usage values from the response headers. Invalid or missing parts are omitted."""
    usage: dict = {}
    for key, name in (("five_hour", "5h"), ("seven_day", "7d")):
        window = _window(headers, name)
        if window is not None:
            usage[key] = window
    for key, header in (("status", "status"), ("claim", "representative-claim")):
        value = headers.get(UNIFIED + header)
        if value is not None and WORD.fullmatch(value.strip()):
            usage[key] = value.strip()
    return usage


def log_usage(usage: dict) -> None:
    global _last_usage, _last_usage_at
    if not usage:
        return
    now = time.monotonic()
    with _usage_lock:
        if usage == _last_usage and now - _last_usage_at < USAGE_REPEAT_S:
            return
        _last_usage = usage
        _last_usage_at = now
    log(f"usage {json.dumps(usage, separators=(',', ':'))}")


class Handler(BaseHTTPRequestHandler):
    # HTTP/1.0 to the agent: the body ends when the connection closes, so streamed (SSE)
    # responses pass through chunk by chunk without re-encoding.
    protocol_version = "HTTP/1.0"
    server_version = "api-proxy"
    sys_version = ""

    def log_message(self, format: str, *args: object) -> None:
        pass

    def do_GET(self) -> None:
        self.forward()

    def do_POST(self) -> None:
        self.forward()

    def deny(self, status: int, reason: str) -> None:
        log(f"DENY {self.command} {self.path} ({reason})")
        body = f"api-proxy: {reason}\n".encode()
        self.send_response(status)
        self.send_header("Content-Type", "text/plain")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def forward(self) -> None:
        path = self.path
        if not path.startswith("/") or not any(
            path == p or path.startswith((p + "/", p + "?")) for p in ALLOWED_PREFIXES
        ):
            self.deny(403, "path not allowed")
            return
        if "chunked" in self.headers.get("Transfer-Encoding", "").lower():
            self.deny(411, "chunked request bodies are not supported")
            return
        length = int(self.headers.get("Content-Length") or 0)
        if not 0 <= length <= MAX_BODY:
            self.deny(413, "request body too large")
            return
        body = self.rfile.read(length) if length else None

        headers = {k: v for k, v in self.headers.items() if k.lower() not in REPLACED}
        headers["Authorization"] = f"Bearer {TOKEN}"
        betas = [
            b.strip() for b in headers.pop("anthropic-beta", "").split(",") if b.strip()
        ]
        if OAUTH_BETA not in betas:
            betas.append(OAUTH_BETA)
        headers["anthropic-beta"] = ",".join(betas)
        if body is not None:
            headers["Content-Length"] = str(len(body))

        conn = http.client.HTTPSConnection(UPSTREAM_HOST, 443, timeout=600, context=TLS)
        started = False
        try:
            conn.request(self.command, path, body=body, headers=headers)
            resp = conn.getresponse()
            log(f"{self.command} {path} -> {resp.status}")
            log_usage(parse_usage(resp.msg))
            started = True
            self.send_response_only(resp.status, resp.reason)
            for k, v in resp.getheaders():
                if k.lower() not in HOP_BY_HOP:
                    self.send_header(k, v)
            self.end_headers()
            while chunk := resp.read1(CHUNK):
                self.wfile.write(chunk)
                self.wfile.flush()
        except (OSError, http.client.HTTPException) as e:
            log(f"{self.command} {path} -> upstream error: {type(e).__name__}")
            if not started:
                try:
                    self.deny(502, "upstream error")
                except OSError:
                    pass
        finally:
            conn.close()


def main() -> None:
    port = int(os.environ.get("API_PROXY_PORT", "8080"))
    server = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    server.daemon_threads = True
    log(f"listening on :{port}, upstream https://{UPSTREAM_HOST}")
    server.serve_forever()


if __name__ == "__main__":
    main()
