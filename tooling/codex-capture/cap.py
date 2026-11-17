#!/usr/bin/env python3
"""Local-only fake Responses upstream used to capture request bodies safely."""
import http.server
import json
import os
from urllib.parse import urlsplit

# Captures may contain private conversation data. Keep files private even when the
# caller's shell has a permissive umask.
os.umask(0o077)
MAX_BODY_BYTES = 20 * 1024 * 1024
SENSITIVE_HEADERS = {
    "authorization", "proxy-authorization", "x-api-key", "api-key",
    "cookie", "set-cookie",
}


def safe_headers(headers):
    out = {}
    for key, value in headers.items():
        if key.lower() in SENSITIVE_HEADERS:
            if key.lower() == "authorization":
                scheme = value.split(None, 1)[0] if value.strip() else ""
                value = (scheme + " <redacted>") if scheme else "<redacted>"
            else:
                value = "<redacted>"
        out[key] = value
    return out


def write_private(path, data, *, append=False, binary=False):
    flags = os.O_WRONLY | os.O_CREAT | (os.O_APPEND if append else os.O_TRUNC)
    fd = os.open(path, flags, 0o600)
    os.chmod(path, 0o600)
    mode = "ab" if binary else "a"
    with os.fdopen(fd, mode) as handle:
        handle.write(data)


class H(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def do_POST(self):
        raw_length = self.headers.get("content-length")
        try:
            n = int(raw_length) if raw_length is not None else 0
        except ValueError:
            self.send_error(400, "invalid content-length")
            return
        if n < 0 or n > MAX_BODY_BYTES:
            self.send_error(413, "capture body too large")
            return
        body = self.rfile.read(n)
        if len(body) != n:
            self.send_error(400, "incomplete request body")
            return

        rec = {
            "path": urlsplit(self.path).path,
            "headers": safe_headers(self.headers),
            "body": body.decode("utf-8", "replace"),
        }
        write_private("capture.jsonl", json.dumps(rec, ensure_ascii=False) + "\n", append=True)
        write_private("body.json", body, binary=True)

        # Return a minimal valid SSE Responses stream.
        chunks = [
            ("response.created", {"type": "response.created", "response": {
                "id": "resp_1", "object": "response", "created_at": 1,
                "status": "in_progress", "model": "gpt-5.6-sol", "output": []}}),
            ("response.output_item.added", {"type": "response.output_item.added",
                "output_index": 0, "item": {"type": "message", "id": "msg_1",
                "role": "assistant", "content": []}}),
            ("response.output_text.delta", {"type": "response.output_text.delta",
                "item_id": "msg_1", "output_index": 0, "content_index": 0, "delta": "OK"}),
            ("response.completed", {"type": "response.completed", "response": {
                "id": "resp_1", "object": "response", "created_at": 1,
                "status": "completed", "model": "gpt-5.6-sol",
                "output": [{"type": "message", "id": "msg_1", "role": "assistant",
                    "content": [{"type": "output_text", "text": "OK"}]}],
                "usage": {"input_tokens": 1, "output_tokens": 1, "total_tokens": 2}}}),
        ]
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Transfer-Encoding", "chunked")
        self.end_headers()
        for event, obj in chunks:
            data = f"event: {event}\ndata: {json.dumps(obj)}\n\n".encode()
            self.wfile.write(hex(len(data))[2:].encode() + b"\r\n" + data + b"\r\n")
            self.wfile.flush()
        self.wfile.write(b"0\r\n\r\n")
        self.wfile.flush()

    def do_GET(self):
        self.send_response(200)
        self.send_header("Content-Length", "2")
        self.end_headers()
        self.wfile.write(b"{}")

    def log_message(self, *args):
        pass


http.server.ThreadingHTTPServer(("127.0.0.1", 8899), H).serve_forever()
