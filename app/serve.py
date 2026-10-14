"""Serve app/web for testing in a browser, with caching turned off.

Python's own `http.server` lets browsers cache files, so after a change a
tab can keep running an old worker.js or engine next to new code. This
server tells the browser to fetch every file fresh.

    python app/serve.py [port]      (default 8765)
"""

import functools
import http.server
import pathlib
import sys


class NoCache(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".wasm": "application/wasm",
        ".js": "text/javascript",
    }

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
web = pathlib.Path(__file__).parent / "web"
handler = functools.partial(NoCache, directory=str(web))
print(f"PixPath on http://127.0.0.1:{port}")
http.server.ThreadingHTTPServer(("127.0.0.1", port), handler).serve_forever()
