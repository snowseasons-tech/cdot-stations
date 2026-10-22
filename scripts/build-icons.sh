#!/usr/bin/env bash
# Regenerates the app icons in public/icons/ (needs ImageMagick). The design is a white map pin on dark blue,
# drawn at 4x size and scaled down so the edges are smooth.
#   bash scripts/build-icons.sh
set -euo pipefail
cd "$(dirname "$0")/.."
OUT=public/icons
BG='#16324f'
FG='#ffffff'
ACCENT='#4cc27f'   # the "open" green used on the page

# pin(size, scale): scale 1.0 fills the safe area of a normal icon; 0.78 leaves the extra margin a maskable icon needs
pin() {
  local size=$1 scale=$2 file=$3
  local big=$((size * 4))
  # geometry on a 1000-unit grid, scaled to the canvas and shrunk toward the centre by $scale
  magick -size ${big}x${big} "xc:$BG" \
    -fill "$FG" -draw "$(python3 -I - "$big" "$scale" <<'PY'
import sys
big, scale = float(sys.argv[1]), float(sys.argv[2])
def p(x, y):
    # 1000-unit design coordinates -> pixels, shrunk about the centre
    return ((x - 500) * scale + 500) * big / 1000, ((y - 500) * scale + 500) * big / 1000
cx, cy = p(500, 400); rx, ry = p(500 + 230, 400)
tip = p(500, 860); l = p(335, 560); r = p(665, 560)
print(f"circle {cx:.1f},{cy:.1f} {rx:.1f},{ry:.1f} polygon {l[0]:.1f},{l[1]:.1f} {tip[0]:.1f},{tip[1]:.1f} {r[0]:.1f},{r[1]:.1f}")
PY
)" \
    -fill "$ACCENT" -draw "$(python3 -I - "$big" "$scale" <<'PY'
import sys
big, scale = float(sys.argv[1]), float(sys.argv[2])
cx = ((500 - 500) * scale + 500) * big / 1000
cy = ((400 - 500) * scale + 500) * big / 1000
r = 105 * scale * big / 1000
print(f"circle {cx:.1f},{cy:.1f} {cx + r:.1f},{cy:.1f}")
PY
)" \
    -filter Lanczos -resize ${size}x${size} -strip "PNG24:$file"
}

pin 192 1.0  "$OUT/icon-192.png"
pin 512 1.0  "$OUT/icon-512.png"
pin 512 0.78 "$OUT/icon-maskable-512.png"
pin 180 1.0  "$OUT/apple-touch-icon.png"
echo "Wrote icons to $OUT/"
