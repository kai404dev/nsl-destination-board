#!/usr/bin/env python3
"""main.py - run the NSL destination board portal and/or LED driver.

Combined service (matches ReadMe)::

    sudo .venv/bin/python main.py --portal --board

Portal only (design .dest files from another machine)::

    python main.py --portal --port 8000

Matrix geometry defaults to 3x 80x40 P4 panels in one chain (240x40).
Override for other setups, e.g. a single 64x32 panel::

    sudo python main.py --board --led-rows 32 --led-cols 64 --led-chain 1

Must run as root on the Pi for GPIO access.
"""

from __future__ import annotations

import argparse
import threading


def build_parser() -> argparse.ArgumentParser:
    import board
    import portal

    parser = argparse.ArgumentParser(description="NSL destination board")
    parser.add_argument("--portal", action="store_true",
                        help="run the web portal (studio + controller)")
    parser.add_argument("--board", action="store_true",
                        help="run the LED matrix driver (needs root + panels)")
    parser.add_argument("--host", default="0.0.0.0",
                        help="portal interface to bind (default: 0.0.0.0)")
    parser.add_argument("--port", type=int, default=8000,
                        help="portal port (default: 8000)")
    board.add_matrix_args(parser)
    return parser


def main(argv=None) -> None:
    import board
    import portal

    parser = build_parser()
    args = parser.parse_args(argv)

    run_portal = args.portal
    run_board = args.board
    if not run_portal and not run_board:
        run_portal = run_board = True  # bare `python main.py` runs both

    # Boot selection comes from the board config: resume keeps the last
    # picked destination, default starts one configured destination,
    # blank (as before) clears it so the panels stay clear.
    import api
    from pathlib import Path as _P

    _ROOT = _P(__file__).resolve().parent
    _cfg = api.load_config(_ROOT)
    _mode = _cfg.get("startup_mode", "blank")
    if _mode == "resume":
        print("Board selection kept - resuming where it left off")
    elif _mode == "default":
        _ok, _msg = api.save_selection(
            _ROOT, str(_cfg.get("startup_program") or ""),
            str(_cfg.get("startup_service") or ""),
            str(_cfg.get("startup_destination") or ""))
        if _ok:
            print(f"Board starting on default {_cfg.get('startup_program')} / "
                  f"{_cfg.get('startup_service')} / {_cfg.get('startup_destination')}")
        else:
            api.clear_selection(_ROOT)
            print(f"Default startup invalid ({_msg}) - booting to a blank screen")
    else:
        api.clear_selection(_ROOT)
        print("Board selection cleared - booting to a blank screen")

    threads: list[threading.Thread] = []
    if run_portal:
        template_dir = portal.TEMPLATE_DIR
        if not template_dir.is_dir():
            raise SystemExit(f"template directory not found: {template_dir}")
        from functools import partial
        from http.server import ThreadingHTTPServer

        from portal import BoardHandler

        server = ThreadingHTTPServer(
            (args.host, args.port),
            partial(BoardHandler, template_dir=template_dir))
        url = f"http://{args.host}:{server.server_port}"
        print(f"Portal at {url}  (/studio  /controller)")
        thread = threading.Thread(target=server.serve_forever,
                                  kwargs={"poll_interval": 0.2},
                                  daemon=True)
        thread.start()
        threads.append(thread)

    if run_board:
        try:
            board.run_board(args)  # blocks; portal serves in background
        except KeyboardInterrupt:
            print("\nStopping.")
    elif threads:
        try:
            threads[0].join()
        except KeyboardInterrupt:
            print("\nStopping.")


if __name__ == "__main__":
    main()
