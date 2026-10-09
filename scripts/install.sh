#!/usr/bin/env bash
# Install the rgbmatrix Python driver on a Raspberry Pi.
# Run once from inside this folder:
#   chmod +x install.sh && ./install.sh
set -e
cd "$(dirname "$0")"

echo "==> Installing system build deps (needs sudo)..."
sudo apt-get update
sudo apt-get install -y python3-dev python3-pil cython3 build-essential git

echo "==> Installing Python build backend in your venv..."
# scikit-build-core + cython are needed to compile the bindings (see pyproject.toml)
pip install --upgrade pip
pip install cython scikit-build-core Pillow

if [ ! -d matrix ]; then
  echo "==> Cloning rpi-rgb-led-matrix..."
  git clone https://github.com/hzeller/rpi-rgb-led-matrix.git matrix
fi

echo "==> Building + installing rgbmatrix bindings (takes a few minutes)..."
pip install ./matrix

echo "==> Verifying..."
python3 -c "from rgbmatrix import RGBMatrix; print('rgbmatrix OK')"

echo ""
echo "Done. Now run, e.g.:"
echo "  sudo python3 departures.py --led-rows 32 --led-cols 64 --led-chain 3"
echo "Test without hardware first:"
echo "  python3 departures.py --mock --once"
