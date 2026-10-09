#!/usr/bin/env python3
"""portal.py - web portal for the NSL destination board (stdlib only).

    python portal.py                # http://127.0.0.1:8000
    python portal.py --port 8080    # custom port

Routes:
    /                               -> templates/index.html
    /studio                         -> templates/studio.html
    /controller                     -> templates/controller.html
    /templates/pages/<name>         -> templates/pages/<name>
                                      (used by studio.html's fetch() calls)
    /static/<path>                  -> templates/static/<path>
                                      (css, js, images, ...)
    /api/fonts                        -> JSON list of font names
    /api/sizes/<font-name>            -> JSON list of sizes for a font
    /api/fonts/<name>/<size>/glyphs   -> JSON [{encoding, name}] (GET)
                                      -> GET/PUT .../glyphs/<encoding>
    /api/programs                     -> GET list, POST {"name"} to create
    /api/programs/<name>              -> GET/PUT/DELETE one .dest program
    /api/board/state                  -> GET current board selection + info
    /api/board/select                 -> POST {program,service,destination}
    /fonts/<path>                     -> raw BDF font files (canvas preview)
"""

from __future__ import annotations

import argparse
import json
import mimetypes
import posixpath
import threading
import urllib.parse
import webbrowser
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import api

ROOT = Path(__file__).resolve().parent
TEMPLATE_DIR = ROOT / "templates"
STATIC_DIR = TEMPLATE_DIR / "static"
PAGES_DIR = TEMPLATE_DIR / "pages"
FONTS_DIR = ROOT / "fonts"
PROGRAMS_DIR = ROOT / "programs"
MAX_PROGRAM_BYTES = 2 * 1024 * 1024


def _board_state_payload() -> dict:
    """Current selection plus what the board will play (for Controller).

    Blank/invalid selections report valid=False - the board shows nothing
    until the Controller saves a real program/service/destination.
    """
    sel = api.load_selection(ROOT)
    program = api.load_program(PROGRAMS_DIR, sel.get("program") or "")
    if program is None:
        return {"selection": sel, "valid": False, "pages": 0,
                "rotation_speed": 3,
                "services": [], "destinations": []}
    services = api.list_services(program)
    destinations = api.list_destinations(program, sel.get("service") or "")
    if sel.get("service") not in services or sel.get("destination") not in destinations:
        return {"selection": sel, "valid": False, "pages": 0,
                "rotation_speed": 3, "services": services,
                "destinations": destinations}
    dest = ((program.get("services") or {}).get(sel.get("service") or "")
            or {}).get(sel.get("destination") or "")
    pages = 0
    if isinstance(dest, dict):
        text = dest.get("text")
        bitmaps = dest.get("bitmaps")
        if isinstance(text, dict):
            pages = len(text)
        elif isinstance(bitmaps, list):
            pages = len(bitmaps)
    try:
        speed = float((program.get("defaults") or {}).get("rotation_speed", 3))
    except (TypeError, ValueError):
        speed = 3
    return {"selection": sel, "valid": True, "pages": pages,
            "rotation_speed": speed, "services": services,
            "destinations": destinations}

# Explicit page routes: URL path -> template file (relative to TEMPLATE_DIR).
PAGE_ROUTES = {
    "/": "index.html",
    "/index": "index.html",
    "/index.html": "index.html",
    "/studio": "studio.html",
    "/studio.html": "studio.html",
    "/controller": "controller.html",
    "/controller.html": "controller.html",
}


class BoardHandler(SimpleHTTPRequestHandler):
    """Serve template pages, partial pages and static assets."""

    server_version = "NSLBoardPreview/1.0"

    def __init__(self, *args, template_dir: Path = TEMPLATE_DIR, **kwargs):
        self.template_dir = template_dir
        self.static_dir = template_dir / "static"
        self.pages_dir = template_dir / "pages"
        super().__init__(*args, directory=str(template_dir), **kwargs)

    def log_message(self, format, *args):  # noqa: A002 - stdlib signature
        print(f"[{self.log_date_time_string()}] {self.address_string()} - {format % args}")

    def do_GET(self):  # noqa: N802 - stdlib handler name
        parsed = urllib.parse.urlparse(self.path)
        url_path = posixpath.normpath(parsed.path or "/")
        if parsed.path.endswith("/") and url_path != "/":
            url_path += "/"

        # 1. Top-level pages: / , /studio, /controller (+ .html variants).
        if url_path in PAGE_ROUTES:
            return self._serve_file(self.template_dir / PAGE_ROUTES[url_path])

        # 2. Partial pages fetched by studio.html: /templates/pages/<name>.
        if url_path == "/templates/pages" or url_path == "/templates/pages/":
            return self._serve_file(self.pages_dir / "editor.html", fallback_ok=True)
        if url_path.startswith("/templates/pages/"):
            rel = url_path[len("/templates/pages/"):]
            return self._serve_file(self.pages_dir / rel)

        # 3. Also allow the shorter /pages/<name> alias.
        if url_path.startswith("/pages/"):
            rel = url_path[len("/pages/"):]
            return self._serve_file(self.pages_dir / rel)

        # 4. Static assets: /static/<path> -> templates/static/<path>.
        if url_path == "/static" or url_path == "/static/":
            return self._listing("static assets", self.static_dir)
        if url_path.startswith("/static/"):
            rel = url_path[len("/static/"):]
            return self._serve_file(self.static_dir / rel)

        # 5. Raw BDF fonts for the 240x40 canvas preview.
        if url_path.startswith("/fonts/"):
            rel = url_path[len("/fonts/"):]
            return self._serve_file(FONTS_DIR / rel, base=FONTS_DIR)

        # 6. Font API used by the editor partial.
        if url_path in ("/api/fonts", "/api/fonts/"):
            return self._serve_json(api.list_fonts(FONTS_DIR))
        if url_path.startswith("/api/sizes/"):
            name = urllib.parse.unquote(url_path[len("/api/sizes/"):].strip("/"))
            sizes = api.list_sizes(FONTS_DIR, name)
            if sizes is None:
                return self.send_error(404, f"Unknown font: {name or '(none)'}")
            return self._serve_json(sizes)

        # 6b. Glyph API for the BDF editor (GET only; PUT lives in do_PUT).
        if url_path.startswith("/api/fonts/"):
            glyph = self._parse_glyph_path(url_path)
            if glyph is not None:
                if "error" in glyph:
                    return self._serve_json({"error": glyph["error"]}, status=glyph["status"])
                if glyph["encoding"] is None:
                    glyphs = api.parse_bdf_glyphs(glyph["path"])
                    return self._serve_json([{"encoding": g["encoding"], "name": g["name"]} for g in glyphs])
                return self._serve_glyph(glyph["path"], glyph["encoding"])

        # 7. Programs API: list and fetch .dest files.
        if url_path in ("/api/programs", "/api/programs/"):
            return self._serve_json(api.list_programs(PROGRAMS_DIR))
        if url_path in ("/api/board/state", "/api/board/state/"):
            return self._serve_json(_board_state_payload())
        if url_path.startswith("/api/programs/"):
            name = urllib.parse.unquote(url_path[len("/api/programs/"):].strip("/"))
            program = api.load_program(PROGRAMS_DIR, name)
            if program is None:
                return self._serve_json({"error": "program not found"}, status=404)
            return self._serve_json(program)

        return self.send_error(404, f"Not found: {parsed.path}")

    def do_PUT(self):  # noqa: N802 - stdlib handler name
        parsed = urllib.parse.urlparse(self.path)
        url_path = posixpath.normpath(parsed.path or "/")
        if parsed.path.endswith("/") and url_path != "/":
            url_path += "/"
        # Save (overwrite) a .dest program.
        if url_path.startswith("/api/programs/"):
            name = urllib.parse.unquote(url_path[len("/api/programs/"):].strip("/"))
            data, error = self._read_json_body()
            if error:
                return self._serve_json({"error": error}, status=400)
            ok, message = api.save_program(PROGRAMS_DIR, name, data)
            if not ok:
                status = 404 if message == "program not found" else 400
                return self._serve_json({"error": message}, status=status)
            return self._serve_json({"ok": True})

        # Save one glyph's pixels: PUT {rows: [[0|1]]}.
        glyph = self._parse_glyph_path(url_path)
        if glyph is not None:
            if "error" in glyph:
                return self._serve_json({"error": glyph["error"]}, status=glyph["status"])
            if glyph["encoding"] is None:
                return self._serve_json({"error": "not found"}, status=404)
            data, error = self._read_json_body()
            if error:
                return self._serve_json({"error": error}, status=400)
            rows = data.get("rows") if isinstance(data, dict) else None
            if not isinstance(rows, list):
                return self._serve_json({"error": "body must be {rows: [[0|1]]}"}, status=400)
            ok, message = api.write_bdf_glyph(glyph["path"], glyph["encoding"], rows)
            if not ok:
                status = 404 if message == "glyph not found" else 400
                return self._serve_json({"error": message}, status=status)
            return self._serve_json({"ok": True})

        return self.send_error(404, f"Not found: {parsed.path}")

    def _parse_glyph_path(self, url_path):
        """Split /api/fonts/<name>/<size>/glyphs[/<enc>].

        Returns None when it isn't a glyph route, {"error", "status"} on a
        bad route, or {"path", "encoding"} (encoding None for the list).
        """
        if not url_path.startswith("/api/fonts/"):
            return None
        parts = url_path[len("/api/fonts/"):].strip("/").split("/")
        if len(parts) < 3 or parts[2] != "glyphs" or len(parts) > 4:
            return None
        font_path = api.font_file(FONTS_DIR, urllib.parse.unquote(parts[0]), parts[1])
        if font_path is None:
            return {"error": "font not found", "status": 404}
        if len(parts) == 3:
            return {"path": font_path, "encoding": None}
        try:
            encoding = int(parts[3])
        except ValueError:
            return {"error": "bad encoding", "status": 400}
        return {"path": font_path, "encoding": encoding}

    def _serve_glyph(self, font_path, encoding):
        for g in api.parse_bdf_glyphs(font_path):
            if g["encoding"] == encoding:
                w, h = g["bbx"][0], g["bbx"][1]
                stride = (w + 7) // 8
                bits = []
                for row in g["rows"][:h]:
                    bits.append([(row >> (stride * 8 - 1 - c)) & 1 for c in range(w)])
                return self._serve_json({
                    "encoding": g["encoding"], "name": g["name"],
                    "dwidth": g["dwidth"], "bbx": g["bbx"], "rows": bits,
                })
        return self._serve_json({"error": "glyph not found"}, status=404)

    def do_DELETE(self):  # noqa: N802 - stdlib handler name
        parsed = urllib.parse.urlparse(self.path)
        url_path = posixpath.normpath(parsed.path or "/")
        if parsed.path.endswith("/") and url_path != "/":
            url_path += "/"

        # Delete a .dest program file.
        if url_path.startswith("/api/programs/"):
            name = urllib.parse.unquote(url_path[len("/api/programs/"):].strip("/"))
            ok, message = api.delete_program(PROGRAMS_DIR, name)
            if not ok:
                status = 404 if message == "program not found" else 400
                return self._serve_json({"error": message}, status=status)
            return self._serve_json({"ok": True})

        return self.send_error(404, f"Not found: {parsed.path}")

    def do_POST(self):  # noqa: N802 - stdlib handler name
        parsed = urllib.parse.urlparse(self.path)
        url_path = posixpath.normpath(parsed.path or "/")
        if parsed.path.endswith("/") and url_path != "/":
            url_path += "/"

        # Create a new .dest program from the template: POST {"name": "..."}.
        if url_path in ("/api/programs", "/api/programs/"):
            data, error = self._read_json_body()
            if error:
                return self._serve_json({"error": error}, status=400)
            name = data.get("name") if isinstance(data, dict) else ""
            ok, message = api.create_program(PROGRAMS_DIR, (name or "").strip())
            if not ok:
                status = 409 if message == "program already exists" else 400
                return self._serve_json({"error": message}, status=status)
            return self._serve_json({"ok": True, "name": (name or "").strip()}, status=201)

        # Select what the board plays: POST {"program","service","destination"}.
        if url_path in ("/api/board/select", "/api/board/select/"):
            data, error = self._read_json_body()
            if error:
                return self._serve_json({"error": error}, status=400)
            if not isinstance(data, dict):
                return self._serve_json({"error": "body must be JSON"}, status=400)
            ok, message = api.save_selection(
                ROOT, str(data.get("program") or ""),
                str(data.get("service") or ""),
                str(data.get("destination") or ""))
            if not ok:
                return self._serve_json({"error": message}, status=400)
            payload = {"ok": True, **_board_state_payload()}
            if message != "saved":
                payload["warning"] = message
            return self._serve_json(payload)

        return self.send_error(404, f"Not found: {parsed.path}")

    def _read_json_body(self):
        """Return (data, None) or (None, error message) for a JSON request body."""
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        if length <= 0 or length > MAX_PROGRAM_BYTES:
            return None, "bad content length"
        try:
            body = self.rfile.read(length)
            return json.loads(body.decode("utf-8")), None
        except (OSError, ValueError, UnicodeError):
            return None, "body must be JSON"

    def _resolve(self, base: Path, target: Path) -> Path | None:
        """Resolve *target* strictly inside *base* (blocks ../ escapes)."""
        try:
            resolved = target.resolve()
            resolved.relative_to(base.resolve())
        except (OSError, ValueError):
            return None
        return resolved

    def _serve_file(self, path: Path, base: Path | None = None, fallback_ok: bool = False):
        base = (base or self.template_dir).resolve()
        resolved = self._resolve(base, path)
        if resolved is None or not resolved.is_file():
            if fallback_ok and (self.pages_dir / "editor.html").is_file():
                resolved = self.pages_dir / "editor.html"
            else:
                return self.send_error(404, f"Not found: {self.path}")
        mime, _ = mimetypes.guess_type(str(resolved))
        try:
            data = resolved.read_bytes()
        except OSError as exc:
            return self.send_error(500, f"Cannot read file: {exc}")
        self.send_response(200)
        self.send_header("Content-Type", mime or "application/octet-stream")
        self.send_header("Content-Length", str(len(data)))
        # Dev server: never cache, so edits to templates/css/js show up
        # without a hard reload.
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def _serve_json(self, obj, status: int = 200):
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _listing(self, title: str, directory: Path):
        try:
            names = sorted(p.name for p in directory.iterdir())
        except OSError as exc:
            return self.send_error(500, f"Cannot list directory: {exc}")
        items = "".join(f'<li><a href="{self.path.rstrip("/")}/{n}">{n}</a></li>' for n in names)
        body = (
            f"<!DOCTYPE html><html><head><meta charset='utf-8'>"
            f"<title>{title}</title></head><body>"
            f"<h1>{title}</h1><ul>{items}</ul></body></html>"
        ).encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def run(host: str, port: int, template_dir: Path, open_browser: bool = False):
    if not template_dir.is_dir():
        raise SystemExit(f"template directory not found: {template_dir}")
    handler = partial(BoardHandler, template_dir=template_dir)
    server = ThreadingHTTPServer((host, port), handler)
    url = f"http://{host if host != '0.0.0.0' else '127.0.0.1'}:{server.server_port}"
    print(f"NSL board preview serving {template_dir} at {url}")
    print(f"  {url}/            index")
    print(f"  {url}/studio      sign studio")
    print(f"  {url}/controller  controller")
    if open_browser:
        threading.Timer(0.5, webbrowser.open, args=(url + "/",)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping preview server.")
    finally:
        server.server_close()


def main(argv=None):
    parser = argparse.ArgumentParser(description="Preview the board templates in a browser.")
    parser.add_argument("--host", default="127.0.0.1", help="interface to bind (default: 127.0.0.1)")
    parser.add_argument("--port", type=int, default=8000, help="port to listen on (default: 8000)")
    parser.add_argument(
        "--dir",
        type=Path,
        default=TEMPLATE_DIR,
        help="template directory to serve (default: ./templates)",
    )
    parser.add_argument("--open", action="store_true", help="open a browser tab once started")
    args = parser.parse_args(argv)
    run(args.host, args.port, args.dir, args.open)


if __name__ == "__main__":
    main()
