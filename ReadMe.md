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
chmod -x scripts/install.sh && scripts/install.sh
pip install -r requirements.txt
```

I recommend running this as a service but can run
```bash
python main.py --portal --board
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
WorkingDirectory={where every you cloned the repo to}
ExecStart={where every you cloned the repo to}/.venv/bin/python main.py --portal --board
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