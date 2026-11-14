# -*- coding: utf-8 -*-
"""本地联调用的 mock 服务：模拟 ESA Edge KV 的接口语义，仅供开发预览"""
import json
import os
import re
import secrets
import string
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "public")
STORE = {}
STATS = {"total": 0}
ALPHABET = string.ascii_letters + string.digits + "-_"
PASS_GRACE = 600


def rand_str(n):
    return "".join(secrets.choice(ALPHABET) for _ in range(n))


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def log_message(self, fmt, *args):
        pass

    def _send_json(self, data, status=200):
        body = json.dumps(data).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("cache-control", "no-store")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _body(self):
        length = int(self.headers.get("content-length") or 0)
        if not length:
            return {}
        try:
            return json.loads(self.rfile.read(length).decode("utf-8"))
        except Exception:
            return {}

    def do_GET(self):
        if self.path.rstrip("/") == "/api/stats":
            return self._send_json({"total": STATS["total"]})
        return super().do_GET()

    def do_POST(self):
        path = re.sub(r"/+$", "", self.path)
        body = self._body()

        if path == "/api/create":
            ct = body.get("ct") or ""
            iv = body.get("iv") or ""
            mode = body.get("mode")
            ttl = min(max(int(body.get("ttl") or 86400), 3600), 604800)
            if not ct or not iv or mode not in ("link", "pass"):
                return self._send_json({"error": "missing_payload"}, 400)
            nid = rand_str(12)
            now = int(time.time() * 1000)
            STORE[nid] = {
                "mode": mode,
                "ct": ct,
                "iv": iv,
                "mgmt": rand_str(24),
                "state": "unread",
                "createdAt": now,
                "expiresAt": now + ttl * 1000,
                "readAt": None,
            }
            STATS["total"] += 1
            return self._send_json(
                {"id": nid, "mgmt": STORE[nid]["mgmt"], "expiresAt": STORE[nid]["expiresAt"], "ttl": ttl}
            )

        if path == "/api/read":
            rec = STORE.get(body.get("id") or "")
            if not rec:
                return self._send_json({"state": "not_found"}, 404)
            if rec["state"] in ("read", "burned"):
                return self._send_json({"state": "read", "readAt": rec["readAt"]}, 410)
            if int(time.time() * 1000) > rec["expiresAt"]:
                rec["state"] = "burned"
                rec["ct"] = ""
                rec["iv"] = ""
                return self._send_json({"state": "expired"}, 410)
            payload = {"state": "ok", "ct": rec["ct"], "iv": rec["iv"], "mode": rec["mode"]}
            if rec["mode"] == "link":
                rec["state"] = "read"
                rec["readAt"] = int(time.time() * 1000)
                rec["ct"] = ""
                rec["iv"] = ""
                STATS["total"] = max(0, STATS["total"] - 1)
            else:
                rec["state"] = "reading"
            return self._send_json(payload)

        if path == "/api/burn":
            rec = STORE.get(body.get("id") or "")
            if not rec:
                return self._send_json({"ok": False, "reason": "not_found"}, 404)
            rec["state"] = "read"
            rec["readAt"] = int(time.time() * 1000)
            rec["ct"] = ""
            rec["iv"] = ""
            STATS["total"] = max(0, STATS["total"] - 1)
            return self._send_json({"ok": True})

        if path == "/api/status":
            rec = STORE.get(body.get("id") or "")
            if not rec:
                return self._send_json({"state": "not_found"}, 404)
            if rec["mgmt"] != body.get("mgmt"):
                return self._send_json({"error": "forbidden"}, 403)
            state = rec["state"]
            if state == "reading":
                state = "unread"
            if state != "read" and int(time.time() * 1000) > rec["expiresAt"]:
                state = "expired"
            return self._send_json(
                {
                    "state": state,
                    "createdAt": rec["createdAt"],
                    "expiresAt": rec["expiresAt"],
                    "readAt": rec["readAt"],
                    "mode": rec["mode"],
                }
            )

        if path == "/api/destroy":
            rec = STORE.get(body.get("id") or "")
            if not rec:
                return self._send_json({"ok": False, "reason": "not_found"}, 404)
            if rec["mgmt"] != body.get("mgmt"):
                return self._send_json({"error": "forbidden"}, 403)
            was_unread = rec["state"] in ("unread", "reading")
            rec["state"] = "read"
            rec["readAt"] = int(time.time() * 1000)
            rec["ct"] = ""
            rec["iv"] = ""
            if was_unread:
                STATS["total"] = max(0, STATS["total"] - 1)
            return self._send_json({"ok": True})

        return self._send_json({"error": "not_found"}, 404)


if __name__ == "__main__":
    port = 8787
    print(f"mock server: http://127.0.0.1:{port}")
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
