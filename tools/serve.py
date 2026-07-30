#!/usr/bin/env python3
"""Development server.

Plain `python -m http.server` almost works, but two things about it make an
iteration loop painful: it caches, so a reload can silently show you the previous
build and you debug a file you already fixed; and its MIME guessing for .js
depends on the Windows registry, which on some machines returns text/plain and
makes every ES module import fail with a message that does not mention MIME types
at all.

Both are fixed here. Nothing else is added, because the point of this project's
stack is that there is no build step to go wrong.
"""

from __future__ import annotations

import argparse
import http.server
import os
import socketserver
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

TYPES = {
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".wasm": "application/wasm",
    ".png": "image/png",
    ".webp": "image/webp",
    ".ogg": "audio/ogg",
    ".wav": "audio/wav",
    ".glsl": "text/plain; charset=utf-8",
}


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def do_POST(self):
        """Accept artefacts from the running game.

        The game is developed by an agent that cannot see the browser window, so
        the game has to be able to hand back what it drew. `/__evidence/<name>`
        takes a body and writes it under evidence/, which turns "look at the
        screen" into "read a file" — the only version of visual verification that
        works when the page is not compositing.
        """
        if not self.path.startswith("/__evidence/"):
            self.send_error(404)
            return

        name = os.path.basename(self.path[len("/__evidence/"):]) or "capture.png"
        if not name or name.startswith("."):
            self.send_error(400, "bad name")
            return

        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            self.send_error(400, "bad length")
            return
        if length <= 0 or length > 64 * 1024 * 1024:
            self.send_error(400, "bad length")
            return

        body = self.rfile.read(length)
        out_dir = os.path.join(ROOT, "evidence")
        os.makedirs(out_dir, exist_ok=True)
        path = os.path.join(out_dir, name)

        if body.startswith(b"data:"):
            import base64
            comma = body.find(b",")
            body = base64.b64decode(body[comma + 1:]) if comma >= 0 else b""

        with open(path, "wb") as fh:
            fh.write(body)

        payload = f'{{"ok":true,"path":"evidence/{name}","bytes":{len(body)}}}'.encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def guess_type(self, path):
        ext = os.path.splitext(path)[1].lower()
        if ext in TYPES:
            return TYPES[ext]
        return super().guess_type(path)

    def end_headers(self):
        # Never serve a stale module. The whole iteration loop depends on a
        # reload showing what is actually on disk.
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        # Required for SharedArrayBuffer / high-resolution timers if profiling
        # ever needs them. Harmless otherwise.
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        super().end_headers()

    def log_message(self, fmt, *args):
        # One line per request, without the timestamp noise.
        sys.stderr.write("  %s\n" % (fmt % args))


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8181)
    args = ap.parse_args()

    with Server(("127.0.0.1", args.port), Handler) as httpd:
        print(f"serving {ROOT} at http://127.0.0.1:{args.port}/", flush=True)
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nstopped", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
