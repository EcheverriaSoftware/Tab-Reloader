import math
from PIL import Image, ImageDraw

ACCENT = (37, 99, 235, 255)   # #2563eb
WHITE  = (255, 255, 255, 255)

def rounded_rect_mask(size, radius):
    m = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(m)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    return m

def make_icon(target):
    SS = 8                      # supersample factor
    S = target * SS
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # Rounded background tile.
    radius = int(S * 0.22)
    d.rounded_rectangle([0, 0, S - 1, S - 1], radius=radius, fill=ACCENT)

    # Refresh ring: an arc with a gap, plus an arrowhead.
    cx = cy = S / 2
    r = S * 0.28               # ring radius (center of stroke)
    w = max(2, int(S * 0.085)) # stroke width

    # Arc from ~120deg sweeping clockwise, leaving a gap for the arrowhead.
    start, end = 120, 390       # degrees
    bbox = [cx - r, cy - r, cx + r, cy + r]
    d.arc(bbox, start=start, end=end, fill=WHITE, width=w)

    # Arrowhead at the arc's end (end angle ~ 390deg == 30deg).
    a = math.radians(end % 360)
    ex = cx + r * math.cos(a)
    ey = cy + r * math.sin(a)
    # tangent direction (clockwise) and outward normal
    tx, ty = -math.sin(a), math.cos(a)     # tangent (direction of travel)
    nx, ny = math.cos(a), math.sin(a)      # radial outward
    head = S * 0.11
    tip = (ex + tx * head, ey + ty * head)
    base1 = (ex + nx * head, ey + ny * head)
    base2 = (ex - nx * head, ey - ny * head)
    d.polygon([tip, base1, base2], fill=WHITE)

    img = img.resize((target, target), Image.LANCZOS)
    return img

for sz in (16, 48, 128):
    make_icon(sz).save(f"icons/icon{sz}.png")
    print("wrote icons/icon%d.png" % sz)
