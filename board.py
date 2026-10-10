#!/usr/bin/env python3
"""board.py - LED matrix driver for the NSL destination board.

Renders ``programs/*.dest`` pages pixel-for-pixel like the Sign Studio
preview (``templates/static/js/preview.js``) and plays the selected
service/destination on hzeller rpi-rgb-led-matrix panels.

Physical setup (default): 3x 80x40 P4 panels in one chain = 240x40.
All geometry is configurable - see ``--led-rows/--led-cols/--led-chain``
and the table in ReadMe.md.

Logical rendering is always done at the program's ``px_width``/``px_height``
(usually 240x40) then scaled with NEAREST to the physical panel size, so
.dest files stay portable across setups.

Usage on the Pi (run as root for GPIO)::

    python main.py --portal --board
    python main.py --board --led-rows 40 --led-cols 80 --led-chain 3 \\
        --led-brightness 80 --led-slowdown-gpio 4

Selection (which program/service/destination plays) is stored in
``board_state.json`` and controlled from the portal Controller tab
(``POST /api/board/select``). The player notices changes within one frame.
"""

from __future__ import annotations

import argparse
import math
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
FONTS_DIR = ROOT / "fonts"
PROGRAMS_DIR = ROOT / "programs"
STATE_FILE = ROOT / "board_state.json"

DEFAULT_COLOUR = (219, 150, 0)
MISSING_ADVANCE = 4  # px advance for glyphs missing from the BDF (matches JS)


# ---------------------------------------------------------------------------
# BDF font loading (mirrors preview.js parseBDF)
# ---------------------------------------------------------------------------

def _round_half_up(x: float) -> int:
    return int(math.floor(x + 0.5))


def parse_bdf(text: str) -> dict:
    """Parse BDF source into {glyphs, ascent, descent}.

    glyphs: {encoding: {dw, w, h, xoff, yoff, rows}}
    rows: list of bit-lists, leftmost ``w`` bits of each BITMAP row.
    """
    glyphs: dict[int, dict] = {}
    ascent = 0
    descent = 0
    cur: dict | None = None
    in_bitmap = False
    for line in text.splitlines():
        if line.startswith("FONT_ASCENT"):
            try:
                ascent = int(line.split()[1])
            except (IndexError, ValueError):
                pass
        elif line.startswith("FONT_DESCENT"):
            try:
                descent = int(line.split()[1])
            except (IndexError, ValueError):
                pass
        elif line.startswith("STARTCHAR"):
            cur = {"enc": -1, "dw": 0, "w": 0, "h": 0,
                   "xoff": 0, "yoff": 0, "rows": []}
            in_bitmap = False
        elif cur is None:
            continue
        elif line.startswith("ENCODING"):
            try:
                cur["enc"] = int(line.split()[1])
            except (IndexError, ValueError):
                cur["enc"] = -1
        elif line.startswith("DWIDTH"):
            try:
                cur["dw"] = int(line.split()[1])
            except (IndexError, ValueError):
                cur["dw"] = 0
        elif line.startswith("BBX"):
            try:
                p = line.split()[1:5]
                cur["w"], cur["h"], cur["xoff"], cur["yoff"] = (
                    int(p[0]), int(p[1]), int(p[2]), int(p[3]))
            except (IndexError, ValueError):
                pass
        elif line == "BITMAP":
            in_bitmap = True
        elif line == "ENDCHAR":
            if cur["enc"] >= 0:
                glyphs[cur["enc"]] = cur
            cur = None
        elif in_bitmap and line.strip():
            try:
                value = int(line.strip(), 16)
            except ValueError:
                continue
            hexlen = len(line.strip())
            total = hexlen * 4
            bits = [(value >> (total - 1 - b)) & 1 for b in range(total)]
            cur["rows"].append(bits[:cur["w"]])
    return {"glyphs": glyphs, "ascent": ascent, "descent": descent}


_font_cache: dict[str, dict | None] = {}


def load_font(fonts_dir: Path, name: str, size: str) -> dict | None:
    """Load (and cache) a BDF font. Returns None when unavailable."""
    key = f"{name}-{size}"
    if key in _font_cache:
        return _font_cache[key]
    import re as _re
    if not name or not _re.fullmatch(r"[A-Za-z0-9]+", str(size or "")):
        _font_cache[key] = None
        return None
    candidates = [fonts_dir / name / f"{key}.bdf"]
    try:
        # Fallback: any *-<size>.bdf in the folder (covers misnamed files
        # such as HaxorNarrow-15.bdf inside HaxorMedium/).
        candidates += sorted((fonts_dir / name).glob(f"*-{int(size)}.bdf"))
    except (OSError, ValueError):
        pass
    text = None
    for path in candidates:
        try:
            resolved = path.resolve()
            resolved.relative_to(fonts_dir.resolve())
            text = resolved.read_text(encoding="utf-8")
            break
        except OSError:
            continue
    if text is None:
        _font_cache[key] = None
        return None
    font = parse_bdf(text)
    _font_cache[key] = font
    return font


def split_font(spec: str) -> tuple[str, str]:
    s = str(spec or "")
    i = s.rfind("-")
    if i < 0:
        return s, ""
    return s[:i], s[i + 1:]


def parse_colour(spec: str) -> tuple[int, int, int]:
    s = str(spec or "").strip().lstrip("#")
    try:
        if len(s) == 3:
            return tuple(int(c * 2, 16) for c in s)  # type: ignore[return-value]
        if len(s) == 6:
            return (int(s[0:2], 16), int(s[2:4], 16), int(s[4:6], 16))
    except ValueError:
        pass
    return DEFAULT_COLOUR


# ---------------------------------------------------------------------------
# Text layout (mirrors preview.js measure/draw functions)
# ---------------------------------------------------------------------------

def _num(value, fallback: int) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return fallback


def element_box(el: dict, W: int, H: int) -> dict:
    """Convert a .dest element's from/to scheme to an {x,y,w,h} box."""
    el = el or {}
    y_raw = el["front_Y"] if "front_Y" in el else el.get("from_Y")
    x = _num(el.get("from_X"), 0)
    y = _num(y_raw, 0)
    w = _num(el.get("to_X"), x) - x
    h = _num(el.get("to_Y"), y) - y
    x = max(0, min(W - 1, x))
    y = max(0, min(H - 1, y))
    w = max(1, min(W - x, w if w >= 1 else W - x))
    h = max(1, min(H - y, h if h >= 1 else H - y))
    return {"x": x, "y": y, "w": w, "h": h}


def _one_of(value: str, allowed: tuple[str, ...], fallback: str) -> str:
    return value if value in allowed else fallback


def _letter_spacing(el: dict | None) -> int:
    """Resolve an element's letter spacing (tracking) in px, default 0."""
    try:
        tracking = int((el or {}).get("letter_spacing", 0))
    except (TypeError, ValueError):
        return 0
    return max(-20, min(40, tracking))


def _space_width(el: dict | None) -> int | None:
    """Resolve an element's explicit space width in px, None = font default."""
    try:
        raw = (el or {}).get("space_width")
        sw = None if raw in (None, "") else int(raw)
    except (TypeError, ValueError):
        return None
    if sw is None:
        return None
    return max(0, min(64, sw))


def measure_string(font: dict, s: str, tracking: int = 0, space_w: int | None = None) -> dict:
    width = 0
    top = 0
    bottom = 0
    has_ink = False
    for ch in s:
        if ord(ch) == 32 and space_w is not None:
            width += space_w + tracking  # explicit space width wins over the font
            continue
        g = font["glyphs"].get(ord(ch))
        if g is None:
            width += MISSING_ADVANCE + tracking
            continue
        width += (g["dw"] or g["w"]) + tracking
        if g["rows"]:
            has_ink = True
            if g["yoff"] + g["h"] > top:
                top = g["yoff"] + g["h"]
            if g["yoff"] < bottom:
                bottom = g["yoff"]
    if not has_ink:
        top = font.get("ascent") or 0
        bottom = -(font.get("descent") or 0)
    return {"width": width, "top": top, "bottom": bottom}


def _draw_line(px, W: int, H: int, font: dict, line: str,
               x: int, baseline: int, colour, clip: dict, tracking: int = 0,
               space_w: int | None = None) -> int:
    pen = x
    for ch in line:
        if ord(ch) == 32 and space_w is not None:
            pen += space_w + tracking  # explicit space width, no ink
            continue
        g = font["glyphs"].get(ord(ch))
        if g is None:
            pen += MISSING_ADVANCE + tracking
            continue
        for r, bits in enumerate(g["rows"]):
            y = baseline - g["yoff"] - g["h"] + r
            for c in range(g["w"]):
                if c < len(bits) and bits[c]:
                    xx, yy = pen + g["xoff"] + c, y
                    if (clip["x"] <= xx < clip["x"] + clip["w"]
                            and clip["y"] <= yy < clip["y"] + clip["h"]
                            and 0 <= xx < W and 0 <= yy < H):
                        px[xx, yy] = colour
        pen += (g["dw"] or g["w"]) + tracking
    return pen - x


def _line_spacing(el: dict, font: dict, measures: list) -> tuple[int, int, int]:
    """Resolve multi-line row geometry for one element.

    Returns (base, step, ascent): *base* is the row height (explicit
    ``line_height`` or the font's ascent+descent), *step* is the baseline
    pitch (base plus ``line_gap``), and *ascent* anchors the first row.
    Missing/invalid values fall back to the font default and zero gap.
    """
    el = el or {}
    ascent = font.get("ascent") or 0
    descent = font.get("descent") or 0
    natural = ascent + descent
    if not natural:
        natural = max([m["top"] - m["bottom"] for m in measures] or [0]) or 8
        if not ascent:
            ascent = max([m["top"] for m in measures] or [0]) or natural
    try:
        explicit = int(el.get("line_height")) if el.get("line_height") not in (None, "") else None
    except (TypeError, ValueError):
        explicit = None
    base = explicit if explicit is not None and 1 <= explicit <= 256 else natural
    try:
        gap = int(el.get("line_gap", 0))
    except (TypeError, ValueError):
        gap = 0
    gap = max(-64, min(200, gap))
    return base, max(1, base + gap), ascent


def _scroll_flag(el: dict | None) -> bool:
    """True when an element opts into marquee scrolling on overflow."""
    return bool((el or {}).get("scroll"))


def _draw_string(px, W: int, H: int, font: dict, s: str,
                 box: dict, align: str, valign: str, colour, el: dict | None = None,
                 offset: float = 0) -> None:
    if not s:
        return
    tracking = _letter_spacing(el)
    space_w = _space_width(el)
    lines = str(s).split("\n")
    if _scroll_flag(el) and len(lines) > 1:
        # A scrolling element is one horizontal line: join rows with a
        # space so no content is lost instead of stacking them.
        lines = [" ".join(lines)]
        s = lines[0]
    if len(lines) <= 1:
        m = measure_string(font, s, tracking, space_w)
        shift = int(round(offset)) if offset else 0
        if _scroll_flag(el) and m["width"] > box["w"]:
            # Scrolling overflow: pin to the left and slide (offset 0 shows
            # the head), ignoring alignment - centering the rest position
            # would start the text halfway scrolled and double-jump.
            x = box["x"] - shift
        else:
            x = box["x"]
            if align == "center":
                x = _round_half_up(box["x"] + (box["w"] - m["width"]) / 2)
            elif align == "right":
                x = _round_half_up(box["x"] + box["w"] - m["width"])
        baseline = _round_half_up(box["y"] + box["h"] + m["bottom"])
        if valign == "top":
            baseline = _round_half_up(box["y"] + m["top"])
        elif valign == "middle":
            baseline = _round_half_up(
                box["y"] + box["h"] / 2 + (m["top"] + m["bottom"]) / 2)
        _draw_line(px, W, H, font, s, x, baseline, colour, box, tracking, space_w)
        return
    # Multi-line: stack rows using ascent/descent (Enter in Via box),
    # adjusted by the element's line_height/line_gap overrides.
    measures = [measure_string(font, ln, tracking, space_w) for ln in lines]
    base, step, ascent = _line_spacing(el, font, measures)
    total_h = step * (len(lines) - 1) + base
    start_y = _round_half_up(box["y"] + box["h"] - total_h)
    if valign == "top":
        start_y = _round_half_up(box["y"])
    elif valign == "middle":
        start_y = _round_half_up(box["y"] + (box["h"] - total_h) / 2)
    for i, ln in enumerate(lines):
        w = measures[i]["width"]
        lx = box["x"]
        if align == "center":
            lx = _round_half_up(box["x"] + (box["w"] - w) / 2)
        elif align == "right":
            lx = _round_half_up(box["x"] + box["w"] - w)
        _draw_line(px, W, H, font, ln, lx,
                   start_y + ascent + i * step, colour, box, tracking, space_w)


def _resolve_page_image(src: str) -> Path | None:
    """Resolve a page image src to a readable file, or None."""
    s = str(src or "").strip().replace("\\", "/").lstrip("/")
    if not s:
        return None
    if s.startswith("/"):
        p = Path(s)
        return p if p.is_file() else None
    try:
        p = (ROOT / s).resolve()
        p.relative_to(ROOT.resolve())
    except (OSError, ValueError):
        return None
    return p if p.is_file() else None


def _draw_page_images(img, page: dict) -> None:
    """Paste positioned bitmaps over a rendered text page (in order)."""
    images = (page or {}).get("images")
    if not isinstance(images, list) or not images:
        # Backwards compat: a page-level "bitmaps" list of dicts.
        legacy = (page or {}).get("bitmaps")
        images = legacy if isinstance(legacy, list) and legacy and isinstance(legacy[0], dict) else []
        if not images:
            return
    for spec in images[:8]:
        if not isinstance(spec, dict):
            continue
        path = _resolve_page_image(spec.get("src"))
        if path is None:
            continue
        try:
            x = int(spec.get("x", 0))
        except (TypeError, ValueError):
            x = 0
        try:
            y = int(spec.get("y", 0))
        except (TypeError, ValueError):
            y = 0
        w = spec.get("w")
        h = spec.get("h")
        try:
            from PIL import Image as _I

            overlay = _I.open(path)
            has_alpha = overlay.mode in ("RGBA", "LA", "PA")
            overlay = overlay.convert("RGBA" if has_alpha else "RGB")
            if w is not None or h is not None:
                try:
                    tw = int(w) if w is not None else overlay.width
                    th = int(h) if h is not None else overlay.height
                except (TypeError, ValueError):
                    tw, th = overlay.width, overlay.height
                tw = max(1, min(1024, tw))
                th = max(1, min(1024, th))
                if (tw, th) != overlay.size:
                    overlay = overlay.resize((tw, th), _I.NEAREST)
            if has_alpha:
                img.paste(overlay, (x, y), overlay)
            else:
                img.paste(overlay.convert("RGB"), (x, y))
        except Exception:
            continue


def render_text_page(page: dict, W: int = 240, H: int = 40,
                     fonts_dir: Path = FONTS_DIR,
                     offsets: dict | None = None):
    """Render one text page to a Pillow RGB image (WxH).

    *offsets* maps element keys (``destination``/``via``/``number``) to a
    horizontal scroll shift in px for one animation frame - omitted or 0
    renders the static page exactly as before.
    """
    from PIL import Image

    img = Image.new("RGB", (W, H), "black")
    px = img.load()
    for key in ("destination", "via", "number"):  # same order as preview.js
        el = (page or {}).get(key) or {}
        text = el.get("text") or ""
        if not text:
            continue
        name, size = split_font(el.get("font"))
        font = load_font(fonts_dir, name, size)
        if font is None:
            continue  # BDF unavailable: leave blank (preview falls back)
        box = element_box(el, W, H)
        # Missing align/valign default to center/middle (same as the studio
        # draft loader) - older .dest entries omit them.
        align = _one_of(el.get("align"), ("left", "center", "right"), "center")
        valign = _one_of(el.get("valign"), ("top", "middle", "bottom"), "middle")
        _draw_string(px, W, H, font, text, box, align, valign,
                     parse_colour(el.get("colour")), el,
                     (offsets or {}).get(key, 0))
    _draw_page_images(img, page)
    return img


def render_bitmap(path: Path, W: int = 240, H: int = 40):
    """Load a fullscreen bitmap, scaled to WxH with NEAREST."""
    from PIL import Image

    img = Image.open(path).convert("RGB")
    if img.size != (W, H):
        img = img.resize((W, H), Image.NEAREST)
    return img


# ---------------------------------------------------------------------------
# Playlist: destination -> ordered list of ("text", page) / ("bitmap", path)
# ---------------------------------------------------------------------------

def page_scrolls(page: dict, W: int = 240, H: int = 40,
                 fonts_dir: Path = FONTS_DIR) -> dict:
    """Return scroll play info for elements flagged ``"scroll": true``.

    Result maps element keys to ``{"width", "distance"}`` - only for
    elements whose single-line text is wider than its box. Flagged text
    that fits renders statically, so this is empty for normal pages.
    """
    out = {}
    for key in ("destination", "via", "number"):
        el = (page or {}).get(key) or {}
        if not _scroll_flag(el):
            continue
        text = el.get("text") or ""
        if not text:
            continue
        name, size = split_font(el.get("font"))
        font = load_font(fonts_dir, name, size)
        if font is None:
            continue
        line = str(text).replace("\r\n", " ").replace("\n", " ").replace("\r", " ")
        width = measure_string(font, line,
                               _letter_spacing(el), _space_width(el))["width"]
        box = element_box(el, W, H)
        if width > box["w"]:
            out[key] = {"width": width, "distance": width - box["w"]}
    return out


def _page_sort_key(key: str) -> tuple:
    import re
    m = re.match(r"(\d+)", key)
    return (int(m.group(1)) if m else 9999, key)


def destination_frames(program: dict, service: str,
                       destination: str) -> list[tuple[str, object]]:
    """Return the frame list for one destination, in play order."""
    try:
        dest = program["services"][service][destination]
    except (KeyError, TypeError):
        return []
    if not isinstance(dest, dict):
        return []
    text = dest.get("text")
    if isinstance(text, dict) and text:
        return [("text", text[k]) for k in sorted(text, key=_page_sort_key)]
    bitmaps = dest.get("bitmaps")
    if isinstance(bitmaps, list) and bitmaps:
        out = []
        for rel in bitmaps:
            p = (ROOT / str(rel)).resolve() if not str(rel).startswith("/") else Path(str(rel))
            try:
                p.relative_to(ROOT.resolve())
            except ValueError:
                # Absolute path outside repo: allow it (USB stick etc.)
                pass
            out.append(("bitmap", p))
        return out
    return []


def rotation_speed(program: dict) -> float:
    try:
        return max(0.3, float((program.get("defaults") or {}).get("rotation_speed", 3)))
    except (TypeError, ValueError):
        return 3.0


DEFAULT_SCROLL_PX_PER_SEC = 30.0


def scroll_speed(program: dict) -> float:
    """Marquee pace in px/s (program ``defaults.scroll_speed``, 30)."""
    try:
        return max(1.0, float((program.get("defaults") or {}).get("scroll_speed", DEFAULT_SCROLL_PX_PER_SEC)))
    except (TypeError, ValueError):
        return DEFAULT_SCROLL_PX_PER_SEC


# ---------------------------------------------------------------------------
# Matrix options / player loop
# ---------------------------------------------------------------------------

def add_matrix_args(parser: argparse.ArgumentParser) -> None:
    """Physical panel geometry + driver tuning (documented in ReadMe)."""
    g = parser.add_argument_group("LED matrix (physical panels)")
    g.add_argument("--led-rows", type=int, default=40,
                   help="rows per panel (default 40 for 80x40 P4)")
    g.add_argument("--led-cols", type=int, default=80,
                   help="columns per panel (default 80)")
    g.add_argument("--led-chain", type=int, default=3,
                   help="panels in one chain; width = cols*chain (default 3 -> 240 wide)")
    g.add_argument("--led-parallel", type=int, default=1)
    g.add_argument("--led-brightness", type=int, default=70)
    g.add_argument("--led-gpio-mapping", default="regular",
                   help="regular | adafruit-hat | adafruit-hat-pwm")
    g.add_argument("--led-slowdown-gpio", type=int, default=4,
                   help="needed on Pi 4 (try 2-5 if flicker)")
    g.add_argument("--led-row-addr-type", type=int, default=0)
    g.add_argument("--led-multiplexing", type=int, default=0)
    g.add_argument("--led-pwm-bits", type=int, default=11)
    g.add_argument("--led-limit-refresh", type=int, default=0)
    g.add_argument("--led-no-hardware-pulse", dest="led_no_hardware_pulse",
                   action="store_true", default=True,
                   help="default on: avoids the snd_bcm2835 sound-module clash "
                        "(at the cost of slightly more flicker)")
    g.add_argument("--led-hardware-pulse", dest="led_no_hardware_pulse",
                   action="store_false",
                   help="best display quality; only use once onboard sound is "
                        "disabled (dtparam=audio=off)")
    g.add_argument("--panel-width", type=int, default=0,
                   help="override logical width (default: program px_width, 240)")


def create_matrix(args) -> tuple:
    """Build the RGBMatrix. Returns (matrix, width, height)."""
    from rgbmatrix import RGBMatrix, RGBMatrixOptions

    opts = RGBMatrixOptions()
    opts.rows = args.led_rows
    opts.cols = args.led_cols
    opts.chain_length = args.led_chain
    opts.parallel = args.led_parallel
    opts.brightness = args.led_brightness
    opts.hardware_mapping = args.led_gpio_mapping
    opts.gpio_slowdown = args.led_slowdown_gpio
    opts.row_address_type = args.led_row_addr_type
    opts.multiplexing = args.led_multiplexing
    opts.pwm_bits = args.led_pwm_bits
    opts.disable_hardware_pulsing = args.led_no_hardware_pulse
    if args.led_limit_refresh:
        opts.limit_refresh_rate_hz = args.led_limit_refresh
    matrix = RGBMatrix(options=opts)
    return matrix, opts.cols * opts.chain_length, opts.rows * opts.parallel


def _read_selection() -> dict:
    import api
    return api.load_selection(ROOT)


WIPE_SECONDS = 3.0  # blank pause when switching to a new destination

SCROLL_HOLD_SECONDS = 0.8  # readable pause at each end of a scroll run
SCROLL_STEP_SECONDS = 0.12  # frame time while scrolling (also the cut-in granularity)


def _wait_while_selected(seconds: float, sel: dict, previewing: bool = False) -> bool:
    """Sleep up to *seconds*, waking early on selection/preview changes.

    Returns True when something else cut in (new selection, or a preview
    starting/stopping).
    """
    import api

    waited = 0.0
    while waited < seconds:
        time.sleep(min(0.2, seconds - waited))
        waited += 0.2
        if (api.get_preview() is not None) != previewing:
            return True
        if _read_selection() != sel:
            return True
    return False


def _play_scrolling(matrix, page: dict, W: int, H: int,
                   phys_w: int, phys_h: int, scrolls: dict,
                   px_per_sec: float, sel: dict) -> bool:
    """Animate one scrolling text page on the matrix.

    Holds the start position, slides every scrolling element left in sync
    at *px_per_sec* (each travels its own overflow distance, so the page
    lasts holds + longest distance / pace), holds the end position, then
    returns False. Returns True when a new selection or preview cut in
    (the caller should re-resolve instead of advancing).
    """
    from PIL import Image

    def _show(offsets: dict) -> None:
        img = render_text_page(page, W, H, offsets=offsets)
        if img.size != (phys_w, phys_h):
            img = img.resize((phys_w, phys_h), Image.NEAREST)
        matrix.SetImage(img.convert("RGB"))

    hold = SCROLL_HOLD_SECONDS
    max_dist = max([v["distance"] for v in scrolls.values()] or [0])
    steps = max(1, int(round(max_dist / max(1.0, px_per_sec) / SCROLL_STEP_SECONDS)))
    _show({})
    if _wait_while_selected(hold, sel):
        return True
    for i in range(1, steps + 1):
        frac = i / steps
        _show({k: v["distance"] * frac for k, v in scrolls.items()})
        if _wait_while_selected(SCROLL_STEP_SECONDS, sel):
            return True
    if _wait_while_selected(hold, sel):
        return True
    return False


SPLASH_PAGE_SECONDS = 10.0  # dwell per boot splash page (1 page = 10s)


def splash_pages() -> list[dict]:
    """Built-in startup page (moved out of defualt.dest's startup/start).

    Canonical v1 element keys, rendered with the normal text renderer at
    240x40 so the splash matches what the file version showed.
    """
    white = "#ffffff"
    amber = "#DB7700"
    return [
        {
            "number": {"text": "", "font": "johnston100-45", "colour": white,
                       "from_X": 180, "to_X": 240, "front_Y": 0, "to_Y": 40,
                       "align": "center", "valign": "middle"},
            "destination": {"text": "Displays", "font": "default-7x13B",
                            "colour": white,
                            "from_X": 78, "to_X": 318, "front_Y": 26,
                            "to_Y": 66, "align": "center", "valign": "middle"},
            "via": {"text": "", "font": "johnston100-18", "colour": amber,
                    "from_X": 0, "to_X": 180, "front_Y": 25, "to_Y": 40,
                    "align": "center", "valign": "middle"},
            "images": [{"src": "bitmaps/shared/Next_Stop_Labs_Full_Logo.png",
                        "x": 0, "y": 0, "w": 200, "h": 35}],
        },
    ]


def _play_splash(matrix, phys_w: int, phys_h: int,
                 pages: list, sel: dict) -> bool:
    """Play the boot splash, one page per SPLASH_PAGE_SECONDS.

    Returns True when a new selection or preview cut in (the caller
    re-resolves instead of dwelling).
    """
    from PIL import Image

    for page in pages:
        try:
            img = render_text_page(page, 240, 40)
        except Exception as exc:
            print(f"Board: splash render error: {exc}")
            continue
        if img.size != (phys_w, phys_h):
            img = img.resize((phys_w, phys_h), Image.NEAREST)
        matrix.SetImage(img.convert("RGB"))
        if _wait_while_selected(SPLASH_PAGE_SECONDS, sel):
            return True
    return False


def run_board(args) -> None:
    """Main player loop: render frames, push to matrix, follow state file."""
    import api

    try:
        matrix, phys_w, phys_h = create_matrix(args)
    except ImportError:
        raise SystemExit("rgbmatrix module not found - run scripts/install.sh on the Pi")
    from PIL import Image

    print(f"Board driver: {phys_w}x{phys_h} "
          f"(rows={args.led_rows} cols={args.led_cols} chain={args.led_chain})")
    matrix.Clear()  # blank screen until the Controller picks a destination
    last_key = None
    # Boot splash first: 5s per page, then the normal selection loop
    # (which boots blank until the Controller picks - see main.py).
    # Picking a destination (or previewing) during the splash cuts in.
    sel = _read_selection()
    _pages = splash_pages()
    print(f"Board: startup splash ({len(_pages)} pages x {SPLASH_PAGE_SECONDS:g}s)")
    _play_splash(matrix, phys_w, phys_h, _pages, sel)
    blank_notice_key = None  # last key we already logged a blank notice for
    previewing = False
    frames: list = []
    program: dict | None = None
    speed = 3.0
    scroll_px = DEFAULT_SCROLL_PX_PER_SEC
    idx = 0
    while True:
        preview = api.get_preview()
        if preview is not None:
            if not previewing:
                print(f"Board: live preview ({preview['seconds']}s) - selection paused")
                previewing = True
            try:
                img = render_text_page(preview["page"],
                                       preview["width"], preview["height"])
            except Exception as exc:
                print(f"Board: preview render error: {exc}")
                time.sleep(0.5)
                continue
            if img.size != (phys_w, phys_h):
                img = img.resize((phys_w, phys_h), Image.NEAREST)
            matrix.SetImage(img.convert("RGB"))
            time.sleep(0.5)
            continue
        if previewing:
            print("Board: preview ended - resuming selection")
            previewing = False
            last_key = None
        sel = _read_selection()
        key = (sel.get("program"), sel.get("service"), sel.get("destination"),
               args.panel_width)
        if key != last_key:
            program = api.load_program(PROGRAMS_DIR, sel.get("program") or "")
            if program is None or not destination_frames(
                    program, sel.get("service") or "", sel.get("destination") or ""):
                frames, speed = [], 3.0
                if key != blank_notice_key:
                    if not sel.get("program"):
                        print("Board: no selection - blank until the Controller picks one")
                    else:
                        print(f"Board: selection not found "
                              f"({sel.get('program')} / {sel.get('service')} / "
                              f"{sel.get('destination')}) - blank")
                    blank_notice_key = key
            else:
                frames = destination_frames(
                    program, sel.get("service") or "", sel.get("destination") or "")
                speed = rotation_speed(program)
                scroll_px = scroll_speed(program)
                W0 = args.panel_width or int(((program.get("defaults") or {}).get("px_width", 240)) or 240)
                H0 = int(((program.get("defaults") or {}).get("px_height", 40)) or 40)
                n_scroll = sum(1 for _kind, _pay in frames
                               if _kind == "text" and page_scrolls(_pay, W0, H0))
                print(f"Board: playing {sel.get('program')} / "
                      f"{sel.get('service')} / {sel.get('destination')} "
                      f"({len(frames)} frames, {speed}s"
                      f"{f', {n_scroll} scrolling @{scroll_px:g}px/s' if n_scroll else ''})")
                # Transition wipe: clear the old screen for a beat so it
                # never blends into the new destination.
                print(f"Board: clearing screen for {WIPE_SECONDS:g}s")
                matrix.Clear()
                if _wait_while_selected(WIPE_SECONDS, sel):
                    continue  # something else cut in; re-resolve
            last_key, idx = key, 0
            # Re-check the .dest file each switch; also reload cheaply
            # every full loop so studio edits appear without reselecting.
        if not frames:
            matrix.Clear()
            time.sleep(1.0)
            last_key = None  # retry (selection may appear / program added)
            continue
        if idx >= len(frames):
            # Loop wrapped: reload program so saved edits take effect.
            fresh = api.load_program(PROGRAMS_DIR, sel.get("program") or "")
            if fresh is not None:
                program = fresh
                frames = destination_frames(
                    program, sel.get("service") or "", sel.get("destination") or "")
                speed = rotation_speed(program)
                scroll_px = scroll_speed(program)
            idx = 0
            if not frames:
                continue
        kind, payload = frames[idx]
        scrolled = False
        try:
            W = (program.get("defaults") or {}).get("px_width", 240) if program else 240
            H = (program.get("defaults") or {}).get("px_height", 40) if program else 40
            W = args.panel_width or int(W or 240)
            H = int(H or 40)
            if kind == "text":
                scrolls = page_scrolls(payload, W, H)
                if scrolls:
                    if _play_scrolling(matrix, payload, W, H,
                                       phys_w, phys_h, scrolls, scroll_px, sel):
                        continue  # cut in: re-resolve, don't advance
                    scrolled = True  # scroll time already spent
                else:
                    img = render_text_page(payload, W, H)
                    if img.size != (phys_w, phys_h):
                        img = img.resize((phys_w, phys_h), Image.NEAREST)
                    matrix.SetImage(img.convert("RGB"))
            else:
                try:
                    img = render_bitmap(Path(payload), W, H)
                except OSError as exc:
                    print(f"Board: cannot load bitmap {payload}: {exc}")
                    from PIL import Image as _I
                    img = _I.new("RGB", (W, H), "black")
                if img.size != (phys_w, phys_h):
                    img = img.resize((phys_w, phys_h), Image.NEAREST)
                matrix.SetImage(img.convert("RGB"))
        except Exception as exc:  # keep the loop alive on bad frames
            print(f"Board: render error on frame {idx}: {exc}")
        idx += 1
        if scrolled:
            continue  # next frame now; no extra dwell
        # Sleep in small slices so a controller change (or preview) cuts in.
        if _wait_while_selected(speed, sel):
            idx = min(idx, max(0, len(frames) - 1))


def main(argv=None) -> None:
    parser = argparse.ArgumentParser(description="NSL board matrix driver")
    add_matrix_args(parser)
    args = parser.parse_args(argv)
    run_board(args)


if __name__ == "__main__":
    main()
