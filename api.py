#!/usr/bin/env python3
"""api.py - data helpers for the NSL board portal (stdlib only).

Font layout on disk::

    fonts/<font-name>/<font-name>-<size>.bdf
    e.g. fonts/johnston100/johnston100-31.bdf

Program files live in ``programs/*.dest`` (JSON, see defualt.dest).
"""

from __future__ import annotations

import json
import re
from pathlib import Path


def list_fonts(fonts_dir: Path) -> list[str]:
    """Return sorted names of font folders containing at least one .bdf file."""
    try:
        entries = sorted(p for p in fonts_dir.iterdir() if p.is_dir())
    except OSError:
        return []
    return [p.name for p in entries if any(p.glob("*.bdf"))]


def font_dir(fonts_dir: Path, name: str) -> Path | None:
    """Resolve a font folder strictly inside *fonts_dir* (blocks ../ escapes)."""
    if not name:
        return None
    try:
        resolved = (fonts_dir / name).resolve()
        resolved.relative_to(fonts_dir.resolve())
    except (OSError, ValueError):
        return None
    if not resolved.is_dir():
        return None
    return resolved


def list_sizes(fonts_dir: Path, name: str) -> list[int] | None:
    """Return sorted point sizes for a font, or None if the font is unknown.

    Sizes are parsed from the ``<name>-<size>.bdf`` filename suffix.
    """
    directory = font_dir(fonts_dir, name)
    if directory is None:
        return None
    sizes: set[int] = set()
    for bdf in directory.glob("*.bdf"):
        _head, sep, tail = bdf.stem.rpartition("-")
        if sep and tail.isdigit():
            sizes.add(int(tail))
    return sorted(sizes)


PROGRAM_NAME_RE = re.compile(r"[A-Za-z0-9_-]+")


def _program_path(programs_dir: Path, name: str) -> Path | None:
    """Resolve ``<name>.dest`` strictly inside *programs_dir*."""
    if not name or not PROGRAM_NAME_RE.fullmatch(name):
        return None
    try:
        resolved = (programs_dir / (name + ".dest")).resolve()
        resolved.relative_to(programs_dir.resolve())
    except (OSError, ValueError):
        return None
    return resolved


def list_programs(programs_dir: Path) -> list[str]:
    """Return sorted program names (``*.dest`` stems)."""
    try:
        return sorted(p.stem for p in programs_dir.glob("*.dest") if p.is_file())
    except OSError:
        return []


def load_program(programs_dir: Path, name: str) -> dict | None:
    """Return the parsed program dict, or None if missing/invalid."""
    path = _program_path(programs_dir, name)
    if path is None or not path.is_file():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def save_program(programs_dir: Path, name: str, data: dict) -> tuple[bool, str]:
    """Atomically overwrite an existing program. Returns (ok, message)."""
    path = _program_path(programs_dir, name)
    if path is None:
        return False, "invalid program name"
    if not path.is_file():
        return False, "program not found"
    if not isinstance(data, dict) or not isinstance(data.get("services"), dict):
        return False, "program must be an object with a 'services' object"
    try:
        tmp = path.with_suffix(".dest.tmp")
        tmp.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
        tmp.replace(path)
    except OSError as exc:
        return False, f"cannot write program: {exc} (see ReadMe 'Service permissions')"
    return True, "saved"


PROGRAM_TEMPLATE = {
    "defaults": {
        "colour": "#DB7700",
        "rotation_speed": 3,
        "px_width": 240,
        "px_height": 40,
    },
    "services": {},
}


def create_program(programs_dir: Path, name: str) -> tuple[bool, str]:
    """Create a new empty program from the template. Returns (ok, message)."""
    path = _program_path(programs_dir, name)
    if path is None:
        return False, "invalid program name (letters, digits, - and _ only)"
    if path.is_file():
        return False, "program already exists"
    try:
        programs_dir.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".dest.tmp")
        tmp.write_text(json.dumps(PROGRAM_TEMPLATE, indent=2) + "\n", encoding="utf-8")
        tmp.replace(path)
    except OSError as exc:
        return False, f"cannot write program: {exc}"
    return True, "created"


def delete_program(programs_dir: Path, name: str) -> tuple[bool, str]:
    """Delete a program file. Returns (ok, message)."""
    path = _program_path(programs_dir, name)
    if path is None:
        return False, "invalid program name"
    if not path.is_file():
        return False, "program not found"
    try:
        path.unlink()
    except OSError as exc:
        return False, f"cannot delete program: {exc}"
    return True, "deleted"


def font_file(fonts_dir: Path, name: str, size: str) -> Path | None:
    """Resolve ``fonts/<name>/<name>-<size>.bdf`` or None."""
    directory = font_dir(fonts_dir, name)
    if directory is None or not str(size).isdigit():
        return None
    candidate = directory / f"{name}-{size}.bdf"
    try:
        resolved = candidate.resolve()
        resolved.relative_to(directory.resolve())
    except (OSError, ValueError):
        return None
    return resolved if resolved.is_file() else None


def parse_bdf_glyphs(path: Path) -> list[dict]:
    """Parse a BDF file into [{encoding, name, dwidth, bbx, rows}]."""
    glyphs: list[dict] = []
    cur: dict | None = None
    in_bitmap = False
    try:
        lines = path.read_text(encoding="utf-8", errors="strict").splitlines()
    except (OSError, ValueError):
        return []
    for line in lines:
        if line.startswith("STARTCHAR"):
            cur = {"encoding": -1, "name": line[9:].strip(), "dwidth": 0,
                   "bbx": [0, 0, 0, 0], "rows": []}
            in_bitmap = False
        elif cur is None:
            continue
        elif line.startswith("ENCODING"):
            try:
                cur["encoding"] = int(line.split()[1])
            except (IndexError, ValueError):
                cur["encoding"] = -1
        elif line.startswith("DWIDTH"):
            try:
                cur["dwidth"] = int(line.split()[1])
            except (IndexError, ValueError):
                cur["dwidth"] = 0
        elif line.startswith("BBX"):
            try:
                cur["bbx"] = [int(p) for p in line.split()[1:5]]
            except ValueError:
                cur["bbx"] = [0, 0, 0, 0]
        elif line == "BITMAP":
            in_bitmap = True
        elif line == "ENDCHAR":
            glyphs.append(cur)
            cur = None
        elif in_bitmap and line.strip():
            try:
                cur["rows"].append(int(line.strip(), 16))
            except ValueError:
                return []
    return glyphs


def write_bdf_glyph(path: Path, encoding: int, rows: list[list[int]]) -> tuple[bool, str]:
    """Replace one glyph's BITMAP rows, preserving everything else.

    *rows* is a list of h bit-lists of length w (from the glyph's BBX).
    """
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as exc:
        return False, f"cannot read font: {exc}"
    lines = text.split("\n")
    # Locate the glyph block.
    start = char_line = bitmap_line = end = width = height = None
    in_target = False
    for i, line in enumerate(lines):
        if line.startswith("STARTCHAR"):
            in_target = False
            start = i
        elif in_target and line == "BITMAP":
            bitmap_line = i
        elif in_target and line == "ENDCHAR":
            end = i
            break
        elif line.startswith("ENCODING") and start is not None and bitmap_line is None and end is None:
            try:
                if int(line.split()[1]) == encoding:
                    in_target = True
                    char_line = start
            except (IndexError, ValueError):
                pass
        elif line.startswith("BBX") and in_target and bitmap_line is None:
            try:
                parts = [int(p) for p in line.split()[1:5]]
                width, height = parts[0], parts[1]
            except ValueError:
                return False, "bad BBX in font file"
    if char_line is None or bitmap_line is None or end is None or width is None:
        return False, "glyph not found"
    # Validate the new bitmap against the glyph's BBX.
    if len(rows) != height or any(len(r) != width for r in rows):
        return False, f"bitmap must be {width}x{height}"
    if any(bit not in (0, 1) for r in rows for bit in r):
        return False, "bitmap bits must be 0 or 1"
    stride = (width + 7) // 8
    hex_rows = []
    for r in rows:
        value = 0
        for bit in r:
            value = (value << 1) | bit
        value <<= stride * 8 - width
        hex_rows.append(f"{value:0{stride * 2}X}")
    lines[bitmap_line + 1:end] = hex_rows
    try:
        tmp = path.with_suffix(".bdf.tmp")
        tmp.write_text("\n".join(lines), encoding="utf-8")
        tmp.replace(path)
    except OSError as exc:
        return False, f"cannot write font: {exc}"
    return True, "saved"


# ---------------------------------------------------------------------------
# Board selection: which program/service/destination the matrix plays.
# Stored as JSON next to the programs (board_state.json) so the portal and
# the board loop share it. The board notices changes within one frame.
# ---------------------------------------------------------------------------

SELECTION_FILE = "board_state.json"

# In-process override, set by save_selection(). The combined service runs
# the portal and the board loop in one process, so even if the state file
# is not writable (bad ownership, read-only FS) the board still switches
# immediately - it just won't remember across reboots.
_memory_selection: dict | None = None

# Live preview: one editor page pushed to the board temporarily.
# {page, width, height, expires}. In-memory only - never persisted.
_preview: dict | None = None
PREVIEW_MIN_SECONDS = 5
PREVIEW_MAX_SECONDS = 300
PREVIEW_DEFAULT_SECONDS = 60


def _valid_preview_page(page) -> bool:
    if not isinstance(page, dict):
        return False
    for key in ("number", "destination", "via"):
        el = page.get(key)
        if el is not None and not isinstance(el, dict):
            return False
    return any((page.get(k) or {}).get("text") for k in ("number", "destination", "via"))


def set_preview(page: dict, width: int = 240, height: int = 40,
                seconds: int = PREVIEW_DEFAULT_SECONDS) -> tuple[bool, str]:
    """Show one editor page on the board until it expires. Returns (ok, message)."""
    import time as _time

    if not _valid_preview_page(page):
        return False, "page must have number/destination/via elements with text"
    try:
        width, height = int(width), int(height)
    except (TypeError, ValueError):
        width, height = 240, 40
    width = max(1, min(1024, width))
    height = max(1, min(256, height))
    try:
        seconds = int(seconds)
    except (TypeError, ValueError):
        seconds = PREVIEW_DEFAULT_SECONDS
    seconds = max(PREVIEW_MIN_SECONDS, min(PREVIEW_MAX_SECONDS, seconds))
    global _preview
    _preview = {"page": page, "width": width, "height": height,
                "expires": _time.monotonic() + seconds, "seconds": seconds}
    return True, f"previewing for {seconds}s"


def clear_preview() -> None:
    global _preview
    _preview = None


def get_preview() -> dict | None:
    """Return the active preview dict, or None (clearing it when expired)."""
    import time as _time

    global _preview
    if _preview is None:
        return None
    if _time.monotonic() >= _preview["expires"]:
        _preview = None
        return None
    return _preview


def _sorted_service_keys(services: dict) -> list[str]:
    def key(k: str):
        return (int(k) if k.isdigit() else 10**9, k)

    return sorted(services, key=key)


def list_services(program: dict) -> list[str]:
    services = (program or {}).get("services")
    if not isinstance(services, dict):
        return []
    return _sorted_service_keys(services)


def list_destinations(program: dict, service: str) -> list[str]:
    services = (program or {}).get("services") or {}
    group = services.get(service)
    if not isinstance(group, dict):
        return []

    def code_of(name: str) -> str:
        dest = group.get(name) or {}
        return str(dest.get("service_code") or "").strip()

    def key(name: str):
        code = code_of(name)
        numeric = int(code) if code.isdigit() else None
        return (0, numeric, "") if numeric is not None else (1, 0, code or name)

    # Numeric codes first (numerically), then the rest alphabetically -
    # same order the Program tab shows.
    nums = sorted([n for n in group if code_of(n).isdigit()],
                  key=lambda n: (int(code_of(n)), n))
    rest = sorted([n for n in group if not code_of(n).isdigit()],
                  key=lambda n: (code_of(n) or n, n))
    return nums + rest


def load_selection(root: Path) -> dict:
    """Read board_state.json.

    Returns a blank selection when nothing has been picked yet (or the
    file is unreadable) - the board stays blank until the Controller
    saves a selection. No auto-fallback: whatever is saved is returned
    as-is; callers treat unresolvable selections as blank/invalid.
    """
    from pathlib import Path as _P

    if _memory_selection is not None:
        return dict(_memory_selection)
    blank = {"program": "", "service": "", "destination": ""}
    try:
        raw = json.loads((_P(root) / SELECTION_FILE).read_text(encoding="utf-8"))
        return {"program": str(raw.get("program") or ""),
                "service": str(raw.get("service") or ""),
                "destination": str(raw.get("destination") or "")}
    except (OSError, ValueError, AttributeError):
        return blank


def clear_selection(root: Path) -> None:
    """Forget the saved board selection (boot to a blank screen)."""
    global _memory_selection
    _memory_selection = None
    try:
        (root / SELECTION_FILE).unlink()
    except OSError:
        pass


def save_selection(root: Path, program: str, service: str,
                   destination: str) -> tuple[bool, str]:
    """Validate and persist a new board selection. Returns (ok, message).

    The validated selection is always applied in-process (so the board
    loop in the same service switches at once). If the state file cannot
    be written, ok is still True but the message warns it won't survive
    a reboot - callers should surface it (the portal sends it as
    ``warning``).
    """
    from pathlib import Path as _P

    global _memory_selection
    root = _P(root)
    programs_dir = root / "programs"
    data = load_program(programs_dir, program or "")
    if data is None:
        return False, "program not found"
    if service not in list_services(data):
        return False, "service not found"
    if destination not in list_destinations(data, service):
        return False, "destination not found"
    sel = {"program": program, "service": service, "destination": destination}
    _memory_selection = dict(sel)
    try:
        tmp = root / (SELECTION_FILE + ".tmp")
        tmp.write_text(json.dumps(sel, indent=2) + "\n", encoding="utf-8")
        tmp.replace(root / SELECTION_FILE)
    except OSError as exc:
        return True, f"on the board now, but NOT saved for reboot: {exc}"
    return True, "saved"
