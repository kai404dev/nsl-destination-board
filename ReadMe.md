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
Destinations with a `bitmaps` list show each PNG fullscreen (240x40)
for the same `rotation_speed` timing. Bitmaps live under `bitmaps/`
and are referenced by repo-relative paths in the `.dest` file.

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