#!/usr/bin/env python3
"""api.py - data helpers for the NSL board portal (stdlib only).

Font layout on disk::

    fonts/<font-name>/<font-name>-<size>.bdf
    e.g. fonts/johnston100/johnston100-31.bdf

Program files live in ``programs/*.dest`` (JSON, see defualt.dest).

Program versions: v1 spells every element field out (``from_X``/``to_X``/
``front_Y``/``to_Y``, ``align``/``valign``, ``line_height``/``line_gap``/
``letter_spacing``/``space_width``). v2 packs them into arrays (``area``,
``alignment``, ``spacing``) and drops anything repeating the defaults
(``colour``, ``service_name``, empty codes, ``x``/``y`` == 0). Files
without ``defaults.version`` are v1; ``"version": 2`` marks v2. The API
always serves expanded (canonical v1) programs and compacts back to v2
on every save, so old files, the board and the Studio JS keep working.
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


SIZE_TOKEN_RE = re.compile(r"[A-Za-z0-9]+")


def is_size_token(size) -> bool:
    """True for safe font-size tokens (digits, or names like ``6x13``).

    Tokens are alphanumerics only, so they can never escape the font
    folder via ``..`` or slashes.
    """
    return bool(SIZE_TOKEN_RE.fullmatch(str(size or "")))


def _size_sort_key(size):
    """Order sizes: plain numbers first, then WxH by height, then the rest."""
    if isinstance(size, int):
        return (0, size, 0, "")
    m = re.fullmatch(r"(\d+)x(\d+)([A-Za-z]*)", str(size))
    if m:
        return (1, int(m.group(2)), int(m.group(1)), m.group(3))
    return (2, 0, 0, str(size))


def list_sizes(fonts_dir: Path, name: str) -> list | None:
    """Return sorted size tokens for a font, or None if unknown.

    Sizes are parsed from the ``*-<size>.bdf`` filename suffix - any file
    in the folder counts. Plain numbers come back as ints, anything else
    (e.g. the ``6x13`` entries under the ``default`` family) as strings.
    This matches font_file(), which serves an exact ``<name>-<size>.bdf``
    hit first and falls back to any ``*-<size>.bdf``, so every advertised
    size is guaranteed to resolve.
    """
    directory = font_dir(fonts_dir, name)
    if directory is None:
        return None
    sizes: set = set()
    for bdf in directory.glob("*.bdf"):
        _head, sep, tail = bdf.stem.rpartition("-")
        if sep and is_size_token(tail):
            sizes.add(int(tail) if tail.isdigit() else tail)
    return sorted(sizes, key=_size_sort_key)


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
    """Return the parsed program dict (expanded to canonical v1), or None."""
    path = _program_path(programs_dir, name)
    if path is None or not path.is_file():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(data, dict):
        return None
    try:
        return expand_program(data)
    except Exception:
        return None


def save_program(programs_dir: Path, name: str, data: dict) -> tuple[bool, str]:
    """Overwrite an existing program, storing it as compact v2.

    Accepts v1, v2 or mixed input: it is expanded to canonical v1 first,
    then validated/normalised as before. Returns (ok, message).
    """
    path = _program_path(programs_dir, name)
    if path is None:
        return False, "invalid program name"
    if not path.is_file():
        return False, "program not found"
    try:
        data = expand_program(data) if isinstance(data, dict) else data
    except Exception:
        return False, "program must be an object with a 'services' object"
    if not isinstance(data, dict) or not isinstance(data.get("services"), dict):
        return False, "program must be an object with a 'services' object"
    # Normalise positioned page bitmaps + line spacing so files stay clean.
    try:
        for _service in (data.get("services") or {}).values():
            if not isinstance(_service, dict):
                continue
            for _dest in _service.values():
                if not isinstance(_dest, dict):
                    continue
                _text = _dest.get("text")
                if not isinstance(_text, dict):
                    continue
                for _page in _text.values():
                    if not isinstance(_page, dict):
                        continue
                    if "images" in _page:
                        _clean = sanitise_page_images(_page.get("images"))
                        if _clean:
                            _page["images"] = _clean
                        else:
                            _page.pop("images", None)
                    for _el in _page.values():
                        if not isinstance(_el, dict):
                            continue
                        try:
                            _lh = int(_el.get("line_height")) if _el.get("line_height") not in (None, "") else None
                        except (TypeError, ValueError):
                            _lh = None
                        if _lh is None or not 1 <= _lh <= 256:
                            _el.pop("line_height", None)
                        else:
                            _el["line_height"] = _lh
                        try:
                            _lg = int(_el.get("line_gap", 0))
                        except (TypeError, ValueError):
                            _lg = 0
                        _lg = max(-64, min(200, _lg))
                        if _lg:
                            _el["line_gap"] = _lg
                        else:
                            _el.pop("line_gap", None)
                        try:
                            _ls = int(_el.get("letter_spacing", 0))
                        except (TypeError, ValueError):
                            _ls = 0
                        _ls = max(-20, min(40, _ls))
                        if _ls:
                            _el["letter_spacing"] = _ls
                        else:
                            _el.pop("letter_spacing", None)
                        try:
                            _sw = _el.get("space_width")
                            _sw = None if _sw in (None, "") else int(_sw)
                        except (TypeError, ValueError):
                            _sw = None
                        if _sw is None:
                            _el.pop("space_width", None)
                        else:
                            _el["space_width"] = max(0, min(64, _sw))
    except Exception:
        pass
    try:
        out = compact_program(data)
        tmp = path.with_suffix(".dest.tmp")
        tmp.write_text(dumps_program(out), encoding="utf-8")
        tmp.replace(path)
    except OSError as exc:
        return False, f"cannot write program: {exc} (see ReadMe 'Service permissions')"
    return True, "saved"


# ---------------------------------------------------------------------------
# Program versions: v1 (verbose keys) <-> v2 (compact arrays).
#
# v1 element (every field spelled out)::
#
#     {"text": "Tutbury", "font": "johnston100-31", "colour": "#DB7700",
#      "from_X": 0, "to_X": 210, "front_Y": 0, "to_Y": 25,
#      "align": "center", "valign": "middle", "line_height": 16, ...}
#
# v2 element (same data, packed)::
#
#     {"text": "Tutbury", "font": "johnston100-31",
#      "area": [0, 0, 210, 25]}              # [x1, y1, x2, y2]
#
# ``alignment`` is [align, valign] (default ["center", "middle"]) and
# ``spacing`` is [line_height(auto=null), line_gap, letter_spacing,
# space_width(null)] (default [null, 0, 0, null]). Arrays may be shortened
# from the right while the dropped slots equal the defaults, and the whole
# key is dropped when everything is default. ``colour`` is dropped when it
# equals ``defaults.colour``, ``service_name`` when it equals the
# destination key, empty ``service_code``s, and image ``x``/``y`` when 0.
# A ``"scroll": true`` element flag survives as-is in both versions:
# over-wide destination/via text scrolls left like a blind instead of
# being clipped (only engages when the text overflows its box).
# ---------------------------------------------------------------------------

PROGRAM_VERSION = 2

_ALIGN_DEFAULTS = ("center", "middle")
# [line_height (None = auto), line_gap, letter_spacing, space_width (None)]
_SPACING_DEFAULTS = (None, 0, 0, None)


def program_version(data: dict) -> int:
    """Return 2 for v2 programs, else 1 (a missing flag means v1)."""
    try:
        return int((data.get("defaults") or {}).get("version", 1))
    except (TypeError, ValueError, AttributeError):
        return 1


def _v2_int(value, fallback: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return fallback


def dumps_program(data: dict) -> str:
    """Serialise a program dict, keeping short arrays on one line.

    Plain ``indent=2`` would explode every ``"area": [x1, y1, x2, y2]``
    over six lines; this collapses the known short value arrays
    (``area``/``alignment``/``spacing``) back onto one line each.
    Arrays containing nested brackets are left alone.
    """
    raw = json.dumps(data, indent=2)

    def _inline(m: re.Match) -> str:
        inner = re.sub(r"\s+", " ", m.group(2)).strip()
        inner = re.sub(r",\s*", ", ", inner)
        return f'"{m.group(1)}": [{inner}]'

    return re.sub(r'"(area|alignment|spacing)": \[([^\[\]]*?)\]',
                  _inline, raw) + "\n"


def _expand_element(el: dict, default_colour: str) -> dict:
    """Expand one v1/v2/mixed element to canonical v1 keys (new keys win)."""
    if not isinstance(el, dict):
        return el
    out = dict(el)
    area = out.pop("area", None)
    if isinstance(area, (list, tuple)) and len(area) >= 4:
        for _k in ("from_X", "to_X", "front_Y", "from_Y", "to_Y"):
            out.pop(_k, None)
        out["from_X"] = _v2_int(area[0])
        out["front_Y"] = _v2_int(area[1])
        out["to_X"] = _v2_int(area[2])
        out["to_Y"] = _v2_int(area[3])
    alignment = out.pop("alignment", None)
    if isinstance(alignment, (list, tuple)) and alignment:
        out.pop("align", None)
        out.pop("valign", None)
        if len(alignment) > 0 and alignment[0]:
            out["align"] = str(alignment[0])
        if len(alignment) > 1 and alignment[1]:
            out["valign"] = str(alignment[1])
    spacing = out.pop("spacing", None)
    if isinstance(spacing, (list, tuple)) and spacing:
        for _k in ("line_height", "line_gap", "letter_spacing", "space_width"):
            out.pop(_k, None)
        vals = [spacing[i] if i < len(spacing) else _SPACING_DEFAULTS[i]
                for i in range(4)]
        if vals[0] not in (None, ""):
            try:
                out["line_height"] = int(vals[0])
            except (TypeError, ValueError):
                pass
        for _k, _v in (("line_gap", vals[1]), ("letter_spacing", vals[2])):
            try:
                _iv = int(_v)
            except (TypeError, ValueError):
                continue
            if _iv != 0:
                out[_k] = _iv
        if vals[3] not in (None, ""):
            try:
                out["space_width"] = int(vals[3])
            except (TypeError, ValueError):
                pass
    if "colour" not in out and default_colour:
        out["colour"] = default_colour
    if out.get("scroll"):
        out["scroll"] = True
    else:
        out.pop("scroll", None)
    return out


def _expand_image(im: dict) -> dict:
    """Fill image x/y defaults so canonical pages are fully explicit."""
    if not isinstance(im, dict):
        return im
    out = dict(im)
    out.setdefault("x", 0)
    out.setdefault("y", 0)
    return out


def expand_program(data: dict) -> dict:
    """Expand a v1/v2/mixed program dict to canonical v1 (verbose keys)."""
    if not isinstance(data, dict):
        raise ValueError("program must be an object")
    out = dict(data)
    defaults = dict(data.get("defaults") or {})
    out["defaults"] = defaults
    default_colour = defaults.get("colour", "")
    services = data.get("services")
    if not isinstance(services, dict):
        return out
    new_services = {}
    for svc, group in services.items():
        if not isinstance(group, dict):
            new_services[svc] = group
            continue
        new_group = {}
        for name, dest in group.items():
            if not isinstance(dest, dict):
                new_group[name] = dest
                continue
            new_dest = dict(dest)
            if not new_dest.get("service_code"):
                new_dest["service_code"] = ""
            if not new_dest.get("service_name"):
                new_dest["service_name"] = name
            text = new_dest.get("text")
            if isinstance(text, dict):
                new_text = {}
                for pk, page in text.items():
                    if not isinstance(page, dict):
                        new_text[pk] = page
                        continue
                    new_page = dict(page)
                    for ek in ("number", "destination", "via"):
                        if isinstance(new_page.get(ek), dict):
                            new_page[ek] = _expand_element(new_page[ek],
                                                           default_colour)
                    if isinstance(new_page.get("images"), list):
                        new_page["images"] = [_expand_image(im)
                                              for im in new_page["images"]]
                    new_text[pk] = new_page
                new_dest["text"] = new_text
            new_group[name] = new_dest
        new_services[svc] = new_group
    out["services"] = new_services
    return out


def _trim_trailing(vals: list, defaults) -> list:
    """Drop trailing slots equal to the defaults (for partial arrays)."""
    vals = list(vals)
    while vals and vals[-1] == defaults[len(vals) - 1]:
        vals.pop()
    return vals


def _compact_opt_int(value, default):
    """Coerce an optional spacing slot, falling back to its default."""
    if value in (None, ""):
        return default
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _compact_element(el: dict, default_colour: str) -> dict:
    """Pack one canonical v1 element into the compact v2 shape."""
    if not isinstance(el, dict):
        return el
    out = {"text": el.get("text", ""), "font": el.get("font", "")}
    colour = el.get("colour", "")
    if not (default_colour and str(colour).lower() == str(default_colour).lower()):
        out["colour"] = colour
    y = el["front_Y"] if "front_Y" in el else el.get("from_Y", 0)
    out["area"] = [_v2_int(el.get("from_X")), _v2_int(y),
                   _v2_int(el.get("to_X")), _v2_int(el.get("to_Y"))]
    alignment = _trim_trailing([el.get("align", "center"),
                                el.get("valign", "middle")],
                               list(_ALIGN_DEFAULTS))
    if alignment:
        out["alignment"] = alignment
    lh = el.get("line_height")
    try:
        lh = int(lh) if lh not in (None, "") else None
    except (TypeError, ValueError):
        lh = None
    spacing = _trim_trailing([lh,
                              _compact_opt_int(el.get("line_gap"), 0),
                              _compact_opt_int(el.get("letter_spacing"), 0),
                              _compact_opt_int(el.get("space_width"), None)],
                             list(_SPACING_DEFAULTS))
    if spacing:
        out["spacing"] = spacing
    if el.get("scroll"):
        out["scroll"] = True
    # Pass through anything unexpected so saves never lose data.
    for k, v in el.items():
        if k not in out and k not in ("from_X", "to_X", "front_Y", "from_Y",
                                      "to_Y", "align", "valign", "line_height",
                                      "line_gap", "letter_spacing",
                                      "space_width", "scroll", "area", "alignment",
                                      "spacing", "text", "font", "colour"):
            out[k] = v
    return out


def _compact_image(im: dict) -> dict:
    """Pack one image spec, dropping x/y when 0 (readers default to 0)."""
    if not isinstance(im, dict):
        return im
    out = {"src": str(im.get("src") or "")}
    if _v2_int(im.get("x", 0)):
        out["x"] = _v2_int(im.get("x", 0))
    if _v2_int(im.get("y", 0)):
        out["y"] = _v2_int(im.get("y", 0))
    for k in ("w", "h"):
        v = im.get(k)
        if v in (None, ""):
            continue
        try:
            iv = int(v)
        except (TypeError, ValueError):
            continue
        if 1 <= iv <= 1024:
            out[k] = iv
    for k, v in im.items():
        if k not in ("src", "x", "y", "w", "h") and k not in out:
            out[k] = v
    return out


def compact_program(data: dict) -> dict:
    """Pack a canonical v1 program dict into the compact v2 shape."""
    if not isinstance(data, dict):
        raise ValueError("program must be an object")
    defaults = dict(data.get("defaults") or {})
    defaults["version"] = PROGRAM_VERSION
    default_colour = defaults.get("colour", "")
    out = dict(data)
    out["defaults"] = defaults
    services = data.get("services")
    if not isinstance(services, dict):
        return out
    new_services = {}
    for svc, group in services.items():
        if not isinstance(group, dict):
            new_services[svc] = group
            continue
        new_group = {}
        for name, dest in group.items():
            if not isinstance(dest, dict):
                new_group[name] = dest
                continue
            new_dest = {}
            code = str(dest.get("service_code") or "")
            if code:
                new_dest["service_code"] = code
            if dest.get("service_name") not in (None, "") \
                    and dest.get("service_name") != name:
                new_dest["service_name"] = dest["service_name"]
            for k, v in dest.items():
                if k in ("service_code", "service_name"):
                    continue
                new_dest[k] = v
            text = new_dest.get("text")
            if isinstance(text, dict):
                new_text = {}
                for pk, page in text.items():
                    if not isinstance(page, dict):
                        new_text[pk] = page
                        continue
                    new_page = dict(page)
                    for ek in ("number", "destination", "via"):
                        if isinstance(new_page.get(ek), dict):
                            new_page[ek] = _compact_element(new_page[ek],
                                                            default_colour)
                    if isinstance(new_page.get("images"), list):
                        new_page["images"] = [_compact_image(im)
                                              for im in new_page["images"]]
                    new_text[pk] = new_page
                new_dest["text"] = new_text
            new_group[name] = new_dest
        new_services[svc] = new_group
    out["services"] = new_services
    return out


PROGRAM_TEMPLATE = {
    "defaults": {
        "colour": "#DB7700",
        "rotation_speed": 3,
        "px_width": 240,
        "px_height": 40,
        "scroll_speed": 30,
        "version": 2,
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
        tmp.write_text(dumps_program(PROGRAM_TEMPLATE), encoding="utf-8")
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
    """Resolve ``fonts/<name>/<name>-<size>.bdf`` or None.

    Falls back to any ``*-<size>.bdf`` in the folder, so a misnamed file
    (e.g. ``HaxorNarrow-15.bdf`` inside ``HaxorMedium/``) still resolves
    instead of 404ing. *size* may be a number or a token like ``6x13``.
    """
    directory = font_dir(fonts_dir, name)
    if directory is None or not is_size_token(size):
        return None
    candidate = directory / f"{name}-{size}.bdf"
    try:
        resolved = candidate.resolve()
        resolved.relative_to(directory.resolve())
    except (OSError, ValueError):
        return None
    if resolved.is_file():
        return resolved
    try:
        fallbacks = sorted(directory.glob(f"*-{size}.bdf"))
    except OSError:
        return None
    for fb in fallbacks:
        try:
            resolved = fb.resolve()
            resolved.relative_to(directory.resolve())
        except (OSError, ValueError):
            continue
        if resolved.is_file():
            return resolved
    return None


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
    if any((page.get(k) or {}).get("text") for k in ("number", "destination", "via")):
        return True
    # A page with only positioned bitmaps is also previewable.
    images = page.get("images")
    return isinstance(images, list) and any(
        isinstance(im, dict) and str(im.get("src") or "") for im in images)


def set_preview(page: dict, width: int = 240, height: int = 40,
                seconds: int = PREVIEW_DEFAULT_SECONDS) -> tuple[bool, str]:
    """Show one editor page on the board until it expires. Returns (ok, message)."""
    import time as _time

    if not _valid_preview_page(page):
        return False, "page must have text or positioned bitmaps"
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


# ---------------------------------------------------------------------------
# Bitmaps: uploadable PNG/JPG images positioned on text pages.
#
# Files live under ``bitmaps/shared/`` (uploads go here) plus any existing
# ``bitmaps/programs/...`` assets. Pages reference them by repo-relative
# POSIX path, e.g. ``{"src": "bitmaps/shared/logo.png", "x": 0, "y": 0}``.
# ---------------------------------------------------------------------------

BITMAPS_DIR_NAME = "bitmaps"
BITMAP_UPLOAD_SUBDIR = "shared"
BITMAP_ALLOWED_EXTS = {".png", ".jpg", ".jpeg", ".bmp", ".gif"}
BITMAP_MAX_BYTES = 1024 * 1024  # 1 MiB decoded
BITMAP_FILENAME_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]*")


def _bitmaps_dir(root: Path) -> Path:
    from pathlib import Path as _P

    return _P(root) / BITMAPS_DIR_NAME


def _resolve_bitmap_rel(root: Path, rel: str) -> Path | None:
    """Resolve a repo-relative bitmap path strictly inside *root*."""
    from pathlib import Path as _P

    if not rel or not isinstance(rel, str):
        return None
    # Normalise to POSIX-ish, block absolute paths and .. escapes.
    rel = rel.strip().replace("\\", "/").lstrip("/")
    if not rel.startswith(BITMAPS_DIR_NAME + "/"):
        return None
    try:
        resolved = (_P(root) / rel).resolve()
        resolved.relative_to(_P(root).resolve())
        base = (_P(root) / BITMAPS_DIR_NAME).resolve()
        resolved.relative_to(base)
    except (OSError, ValueError):
        return None
    return resolved


def list_bitmaps(root: Path) -> list[dict]:
    """Return sorted [{path, bytes}] for every image under bitmaps/."""
    base = _bitmaps_dir(root)
    out: list[dict] = []
    try:
        files = sorted(p for p in base.rglob("*") if p.is_file())
    except OSError:
        return []
    root_resolved = Path(root).resolve()
    for p in files:
        if p.suffix.lower() not in BITMAP_ALLOWED_EXTS:
            continue
        try:
            rel = p.resolve().relative_to(root_resolved).as_posix()
            out.append({"path": rel, "bytes": p.stat().st_size})
        except (OSError, ValueError):
            continue
    return out


def _sanitise_bitmap_filename(name: str) -> str | None:
    base = (name or "").strip().replace("\\", "/").split("/")[-1].strip()
    if not base or len(base) > 100:
        return None
    stem_end = base.rfind(".")
    if stem_end <= 0:
        return None
    ext = base[stem_end:].lower()
    if ext not in BITMAP_ALLOWED_EXTS:
        return None
    stem = base[:stem_end]
    # Normalise stem: spaces -> _, drop anything unsafe.
    stem = re.sub(r"\s+", "_", stem)
    stem = re.sub(r"[^A-Za-z0-9._-]", "", stem).strip("._")
    if not stem:
        return None
    return f"{stem}{ext}"


def save_bitmap(root: Path, filename: str, data_b64: str) -> tuple[bool, str, str]:
    """Decode base64 *data_b64* and store it under bitmaps/shared/.

    Returns (ok, message, rel_path). Accepts raw base64 or a data-URL.
    """
    import base64 as _b64

    clean = _sanitise_bitmap_filename(filename or "")
    if clean is None:
        return False, "filename must end .png/.jpg/.jpeg/.bmp/.gif (letters, digits, - _ .)", ""
    if not data_b64 or not isinstance(data_b64, str):
        return False, "missing image data", ""
    payload = data_b64.strip()
    if payload.startswith("data:"):
        comma = payload.find(",")
        if comma < 0:
            return False, "bad data URL", ""
        payload = payload[comma + 1:]
    try:
        raw = _b64.b64decode(payload, validate=True)
    except Exception:
        return False, "image data is not valid base64", ""
    if not raw or len(raw) > BITMAP_MAX_BYTES:
        return False, f"image must be 1 byte..{BITMAP_MAX_BYTES // 1024}KB", ""
    # Validate it is a real image (Pillow) and normalise ext mismatch.
    try:
        from PIL import Image as _Image

        import io as _io

        with _Image.open(_io.BytesIO(raw)) as im:
            im.verify()
    except ImportError:
        # Pillow unavailable (portal-only env): check magic bytes loosely.
        png_magic = raw[:8] == b"\x89PNG\r\n\x1a\n"
        jpg_magic = raw[:2] == b"\xff\xd8"
        gif_magic = raw[:6] in (b"GIF87a", b"GIF89a")
        bmp_magic = raw[:2] == b"BM"
        if not (png_magic or jpg_magic or gif_magic or bmp_magic):
            return False, "not a recognised image", ""
    except Exception:
        return False, "not a recognised image", ""
    target_dir = _bitmaps_dir(root) / BITMAP_UPLOAD_SUBDIR
    try:
        target_dir.mkdir(parents=True, exist_ok=True)
        stem, ext = clean.rsplit(".", 1)
        candidate = target_dir / clean
        n = 1
        while candidate.exists():
            n += 1
            candidate = target_dir / f"{stem}_{n}.{ext}"
            if n > 999:
                return False, "name clash, rename the file", ""
        tmp = candidate.with_suffix(candidate.suffix + ".tmp")
        tmp.write_bytes(raw)
        tmp.replace(candidate)
        rel = candidate.resolve().relative_to(Path(root).resolve()).as_posix()
    except OSError as exc:
        return False, f"cannot write bitmap: {exc}", ""
    return True, "uploaded", rel


def delete_bitmap(root: Path, rel: str) -> tuple[bool, str]:
    """Delete one bitmap strictly inside bitmaps/. Returns (ok, message)."""
    path = _resolve_bitmap_rel(root, rel or "")
    if path is None or not path.is_file():
        return False, "bitmap not found"
    try:
        path.unlink()
    except OSError as exc:
        return False, f"cannot delete bitmap: {exc}"
    return True, "deleted"


def sanitise_page_images(images) -> list[dict]:
    """Coerce a page's images list to [{src,x,y,w,h}] with sane bounds."""
    if not isinstance(images, list):
        return []
    out: list[dict] = []
    for im in images:
        if not isinstance(im, dict):
            continue
        src = str(im.get("src") or "").strip().replace("\\", "/").lstrip("/")
        if not src.startswith(BITMAPS_DIR_NAME + "/"):
            continue
        try:
            x = int(im.get("x", 0))
        except (TypeError, ValueError):
            x = 0
        try:
            y = int(im.get("y", 0))
        except (TypeError, ValueError):
            y = 0
        spec: dict = {"src": src, "x": max(-1024, min(1024, x)),
                      "y": max(-256, min(256, y))}
        for key in ("w", "h"):
            if im.get(key) is None or str(im.get(key)).strip() == "":
                continue
            try:
                v = int(im.get(key))
            except (TypeError, ValueError):
                continue
            if 1 <= v <= 1024:
                spec[key] = v
        out.append(spec)
        if len(out) >= 8:  # cap overlays per page
            break
    return out
