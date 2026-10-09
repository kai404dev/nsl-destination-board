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
        return False, f"cannot write program: {exc}"
    return True, "saved"


PROGRAM_TEMPLATE = {
    "defaults": {
        "colour": "#DB9600",
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
