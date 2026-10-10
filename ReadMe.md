# Python destination board

## Needed products
This project can probably be modified to work on other systems but this is whats its designed for.

* 80x40 P4 RGB Matrix panels | x3 | [link](https://www.onbuy.com/gb/p/p4-led-matrix-panel-rgb-full-color-led-display-module-80x40-pixels-120-scan-hub75-interfaces-for-diy-screen-billboards~p258456580/)
* Raspberry Pi 4B | [link](https://thepihut.com/products/raspberry-pi-4-model-b?variant=20064052740158)
* 5V 20A 100W Power Supply | [link](https://www.amazon.co.uk/gp/product/B07PQT2Q7L)
* 13 Amp Plug UK (or what ever your plugs are) | [link](https://www.amazon.co.uk/dp/B0F93VNV7S?ref=ppx_yo2ov_dt_b_fed_asin_title)

The links are just the onces I used.

## Setup
I recommend running this on a clean install as raspi OS lite

```bash
sudo apt update && sudo apt upgrade
sudo apt install git python python3 python3.14-venv
```

```bash
git clone https://github.com/kai404dev/nsl-destination-board.git
```

```bash
cd nsl-destination-board
```

```bash
python3 -m venv .venv
```

```bash
source .venv/bin/activate
```

```bash
chmod +x scripts/install.sh && scripts/install.sh
pip install -r requirements.txt
```

## Running the board

`main.py` runs the web portal and the LED driver together as one service:

```bash
sudo .venv/bin/python main.py --portal --board
```

* Portal: http://&lt;pi-ip&gt;:8000 — Sign Studio (`/studio`) + Controller (`/controller`)
* Board: renders the selected program/service/destination on the panels,
  rotating pages every `rotation_speed` seconds (from the `.dest` defaults).

Text pages render with the same BDF fonts, boxes (`from_X`/`to_X`/
`front_Y`/`to_Y`), alignment and colours as the Sign Studio preview.
Multi-line text (Enter in the Via box) stacks rows at the font's
natural line height; per-element `line_height` (explicit row height in
px, empty = auto) and `line_gap` (extra px between rows, negative
tightens) adjust it in the Editor's Line H / Gap fields, on the canvas
preview and on the panels alike. `letter_spacing` (Editor's Letter
field, px added after every character, negative tightens) adjusts
tracking per element the same way.
Destinations with a `bitmaps` list show each PNG fullscreen (240x40)
for the same `rotation_speed` timing. Bitmaps live under `bitmaps/`
and are referenced by repo-relative paths in the `.dest` file.
Text pages can also carry positioned overlays:
`"images": [{"src": "bitmaps/shared/logo.png", "x": 0, "y": 0}]`
(`x`/`y` = top-left corner, optional `w`/`h` to resize, max 8 per
page). Upload PNG/JPG/GIF files in Sign Studio → Editor → Bitmaps,
then Place them and set X/Y/W/H — the canvas preview, board preview
and LED output all match. Each Size selector has −/+ buttons stepping
through that font's available sizes. The **Settings** tab (stored in
this browser) sets the display size driving the Editor canvas, plus
your default colour, layout and per-element fonts/sizes for fresh
drafts and new pages.

### Program file format (v2)

`.dest` files are JSON with `defaults` + `services`. Files without
`defaults.version` are v1 (every field spelled out); `"version": 2`
marks the compact v2 shape, which packs each text element's geometry,
alignment and spacing into arrays and drops anything repeating the
defaults:

```json
"number": {
  "text": "1", "font": "johnston100-45",
  "area": [180, 0, 240, 40],
  "alignment": ["center", "middle"],
  "spacing": [null, 0, 1, null]
}
```

* `area` = `[x1, y1, x2, y2]` (was `from_X`/`front_Y`/`to_X`/`to_Y`)
* `alignment` = `[align, valign]`, default `["center", "middle"]`
* `spacing` = `[line_height (null = auto), line_gap, letter_spacing,
  space_width (null)]`, default `[null, 0, 0, null]` — arrays may be
  shortened from the right while dropped slots equal the defaults, and
  the key is omitted when all default (so `"spacing": [16]` means
  `line_height` 16, everything else default)
* `colour` is omitted when it equals `defaults.colour`,
  `service_name` when it equals the destination key, empty
  `service_code`s, and image `x`/`y` when 0
* `"scroll": true` on a destination/via element (kept as-is in both
  versions): over-wide text scrolls left like a blind instead of being
  clipped. It only engages when the text overflows its box — fitting
  text renders statically as before. Multi-line scrolling text is
  joined into one line with spaces. Tick **Scroll if too wide** in the
  Editor's Destination/Via panels; the canvas preview plays the marquee
  live and the Program tab badges scrolling destinations.

The portal API always serves expanded v1 and compacts back to v2 on
every save, so the board, Studio and hand-written v1 files keep working.
To convert old files, open one and press **Migrate to v2** (it appears
next to Save for v1 programs), or convert everything at once with
**Migrate all to v2** next to Export — both re-save the files
untouched apart from the new format.

Scrolling pages play at the program's **Scroll (px/s)** pace (Defaults,
30): the board holds the start position ~0.8s, slides the text left,
holds the end ~0.8s, then moves to the next page — so a scrolling page
lasts holds + distance / pace rather than the rotation slot.
Switching destinations or starting an editor preview cuts in
immediately, like any other page change. The scroll only reaches the
board once the page is written back (Editor → Save tab → Update page in
program → Program tab Save) and the Pi runs this code (`git pull` +
`sudo systemctl restart board.service`); the Controller's Now playing
line confirms it (`scrolling text on N pages`), as does
`journalctl -u board.service -f` (`playing … (N frames, Ss, M scrolling)`).

### Choosing what plays (Controller tab)

Open `/controller`, pick Program → Service → Destination, then
**Show on board**. The choice is saved to `board_state.json` and plays
until the app restarts — every boot starts blank, so pick again after a
reboot. Switching destinations blanks the screen for 3s before showing
the new one. Until anything is picked (fresh boot included) the panels
stay blank. API:

* `GET /api/board/state` — current selection + page count + speed
* `POST /api/board/select {"program","service","destination"}`
* `POST /api/board/preview {"page","width","height","seconds"}` — live
  editor preview (pauses the normal display, auto-resumes after expiry,
  max 300s), `DELETE /api/board/preview` to stop early

### Live preview from Sign Studio

The editor's Save tab has **Preview on board**: pushes the current draft
to the panels for 60s, exactly as the canvas shows it. The Controller
shows when a preview is on screen; picking a program there (or Stop
preview) takes over again.

Portal only (no panels, e.g. designing from a laptop):

```bash
python main.py --portal --port 8000
```

### Panel geometry (other setups)

Defaults fit 3x 80x40 P4 panels in one chain (240x40). Override with flags:

| Flag | Default | Meaning |
|---|---|---|
| `--led-rows` | 40 | rows per panel |
| `--led-cols` | 80 | columns per panel |
| `--led-chain` | 3 | panels chained; width = cols × chain |
| `--led-parallel` | 1 | parallel chains |
| `--led-brightness` | 100 | 1–100 |
| `--led-gpio-mapping` | regular | `regular` \| `adafruit-hat` \| `adafruit-hat-pwm` |
| `--led-slowdown-gpio` | 4 | Pi 4 needs 2–5; raise if flickering |
| `--led-row-addr-type` | 0 | panel addressing quirk |
| `--led-multiplexing` | 0 | panel multiplexing quirk |
| `--led-pwm-bits` | 11 | colour depth vs refresh tradeoff |
| `--led-limit-refresh` | 0 | cap refresh Hz (0 = off) |
| `--led-no-hardware-pulse` | on | avoids the `snd_bcm2835` sound-module clash (slightly more flicker). Use `--led-hardware-pulse` for best quality once onboard sound is disabled (`dtparam=audio=off` in `/boot/config.txt`) |
| `--port` / `--host` | 8000 / 0.0.0.0 | portal bind |

Rendering is logical (program `px_width`/`px_height`, usually 240x40)
then NEAREST-scaled to the physical size, so `.dest` files work unchanged
on other panel sizes. Examples:

```bash
# single 64x32 panel
sudo .venv/bin/python main.py --portal --board --led-rows 32 --led-cols 64 --led-chain 1
# with an Adafruit HAT, dimmer for night
sudo .venv/bin/python main.py --portal --board --led-gpio-mapping adafruit-hat --led-brightness 60
```

Service
```bash
sudo nano /etc/systemd/system/board.service
```

```ini
[Unit]
Description=NSL Desination board service
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
Group={your user, e.g. kai}
UMask=0002
WorkingDirectory={where ever you cloned the repo to}
ExecStart={where ever you cloned the repo to}/.venv/bin/python main.py --portal --board
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Now activate the services and check its running
```bash
sudo systemctl daemon-reload
sudo systemctl enable --now board.service
sudo systemctl status board.service
journalctl -u board.service -f
```

After changing the unit file, reload and restart:
```bash
sudo systemctl daemon-reload
sudo systemctl restart board.service
```

### Service permissions (read this if saves fail)

The service runs as `root` (the LED driver needs GPIO), but you also
work in the repo as your normal user. Without the setup below, files
the service creates (`board_state.json`, updated `.dest` files) end up
owned by `root` and portal saves fail with e.g.:

> cannot write program: [Errno 13] Permission denied: '.../bus-link.dest.tmp'

`Group=` + `UMask=` in the unit above make service-created files
group-writable, and this one-time setup hands the group to your user
(run with your repo path and username):

```bash
cd ~/nsl-destination-board
sudo chgrp -R kai .
sudo chmod -R g+rwX .
sudo chmod g+s . programs
sudo systemctl restart board.service
```

This means both the service and your user can write programs, fonts
and `board_state.json`, whether the portal runs under systemd or you
start it by hand for testing. If permission errors persist, check
ownership with `ls -l` — every file under the repo should show group
`kai` (or your user) with `rw` for the group.