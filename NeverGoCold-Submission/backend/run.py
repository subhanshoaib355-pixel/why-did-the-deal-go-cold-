"""UC18 sample-mode API. Listens on port 8000.

SAMPLE_MODE defaults to true. Sentiment uses Grok when configured, otherwise keyword rules.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).resolve().parent
HOST = os.environ.get("HOST", "127.0.0.1")
PORT = int(os.environ.get("PORT", "8000"))
MAX_BODY_BYTES = 16_384
DEAL_RE = re.compile(r"^D\d{3}$")
ORIGIN_RE = re.compile(r"^https?://(localhost|127\.0\.0\.1)(:\d+)?$")
CACHE: dict[str, dict] = {}
CACHE_LOCK = threading.Lock()
INFLIGHT: dict[str, tuple[threading.Event, bool]] = {}


def load_dotenv() -> None:
    env_file = ROOT / ".env"
    if not env_file.is_file():
        return
    for line in env_file.read_text(encoding="utf-8").splitlines():
        entry = line.strip()
        if not entry or entry.startswith("#"):
            continue
        key, separator, value = entry.partition("=")
        key = key.strip()
        if not separator or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key):
            continue
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
            value = value[1:-1]
        os.environ.setdefault(key, value)


load_dotenv()


def cached_payload(deal: str, refresh: bool = False) -> tuple[dict | None, bool]:
    should_refresh = refresh
    while True:
        with CACHE_LOCK:
            if not should_refresh and deal in CACHE:
                return CACHE[deal], False
            running = INFLIGHT.get(deal)
            if running is None:
                INFLIGHT[deal] = (threading.Event(), should_refresh)
                if should_refresh:
                    CACHE.pop(deal, None)
                return None, True
            event, owner_refresh = running
        event.wait()
        should_refresh = should_refresh and not owner_refresh


def release_inflight(deal: str) -> None:
    with CACHE_LOCK:
        running = INFLIGHT.pop(deal, None)
        if running is not None:
            event, _ = running
            event.set()


def store_payload(deal: str, payload: dict) -> None:
    with CACHE_LOCK:
        CACHE[deal] = payload
        running = INFLIGHT.pop(deal, None)
        if running is not None:
            event, _ = running
            event.set()


def run_orchestrator(deal: str) -> tuple[int, str, str]:
    env = os.environ.copy()
    env["SAMPLE_MODE"] = "true"
    npx = "npx.cmd" if os.name == "nt" else "npx"
    proc = subprocess.run(
        [npx, "tsx", "hmem.ts", deal, "--json"],
        cwd=ROOT,
        env=env,
        capture_output=True,
        text=True,
        check=False,
        timeout=180,
    )
    return proc.returncode, proc.stdout, proc.stderr


def extract_json(text: str) -> dict | None:
    start = text.find("{")
    end = text.rfind("}")
    if start < 0 or end < start:
        return None
    try:
        parsed = json.loads(text[start : end + 1])
    except json.JSONDecodeError:
        return None
    return parsed if isinstance(parsed, dict) else None


class Handler(BaseHTTPRequestHandler):
    def _origin(self) -> str:
        origin = self.headers.get("Origin", "")
        if ORIGIN_RE.match(origin):
            return origin
        return ""

    def _send(self, code: int, body: bytes, content_type: str) -> None:
        origin = self._origin()
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        if origin:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()
        self.wfile.write(body)

    def _json(self, code: int, payload: dict) -> None:
        self._send(code, json.dumps(payload).encode("utf-8"), "application/json")

    def _deal_from_query(self) -> str:
        query = parse_qs(urlparse(self.path).query)
        values = query.get("deal_id") or query.get("deal") or ["D004"]
        return values[0] or "D004"

    def _handle(self, deal: str, refresh: bool = False) -> None:
        if deal != "all" and not DEAL_RE.match(deal):
            self._json(400, {"error": "deal_id must be D00X or all"})
            return
        cached, should_run = cached_payload(deal, refresh)
        if cached is not None:
            self._json(200, cached)
            return
        if not should_run:
            self._json(503, {"error": "agent run completed without a response"})
            return
        try:
            code, stdout, stderr = run_orchestrator(deal)
        except (OSError, subprocess.SubprocessError) as exc:
            release_inflight(deal)
            self._json(500, {"error": "orchestrator could not be started", "detail": str(exc)[:500]})
            return
        payload = extract_json(stdout)
        if payload is None or code != 0:
            detail = (stderr or stdout or "no json from orchestrator").strip()
            self._json(500, {"error": "orchestrator failed", "detail": detail[:500]})
            release_inflight(deal)
            return
        store_payload(deal, payload)
        self._json(200, payload)

    def do_OPTIONS(self) -> None:  # noqa: N802
        self._send(204, b"", "text/plain")

    def do_GET(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        if path == "/health":
            with CACHE_LOCK:
                cached = sorted(CACHE)
            self._json(200, {"status": "ok", "sample_mode": True, "service": "uc18", "cached": cached})
            return
        if path == "/run":
            self._handle(self._deal_from_query())
            return
        self._json(200, {"service": "uc18", "routes": ["/health", "/run"], "sample_mode": True})

    def do_POST(self) -> None:  # noqa: N802
        if urlparse(self.path).path != "/run":
            self._json(404, {"error": "not found"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0") or "0")
        except ValueError:
            self._json(400, {"error": "invalid content length"})
            return
        if length < 0:
            self._json(400, {"error": "invalid content length"})
            return
        if length > MAX_BODY_BYTES:
            self.close_connection = True
            self._json(413, {"error": "request body too large"})
            return
        raw = self.rfile.read(length) if length else b"{}"
        try:
            payload = json.loads(raw.decode("utf-8") or "{}")
        except json.JSONDecodeError:
            self._json(400, {"error": "invalid json"})
            return
        if not isinstance(payload, dict):
            self._json(400, {"error": "invalid json"})
            return
        deal = payload.get("deal_id", payload.get("deal", "D004"))
        if not isinstance(deal, str):
            self._json(400, {"error": "deal_id must be a string"})
            return
        refresh = payload.get("refresh", False)
        if not isinstance(refresh, bool):
            self._json(400, {"error": "refresh must be a boolean"})
            return
        self._handle(deal, refresh)


def main() -> None:
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"listening on {HOST}:{PORT}")
    server.serve_forever()


if __name__ == "__main__":
    main()
