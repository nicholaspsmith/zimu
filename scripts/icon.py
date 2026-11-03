# Draws the extension icon: 字 on a rounded red tile. python3 scripts/icon.py
from PIL import Image, ImageDraw, ImageFont
import os
FONT = '/System/Library/Fonts/STHeiti Medium.ttc'
out = os.path.join(os.path.dirname(__file__), '..', 'src', 'icons')
for size in (48, 128):
    s = size * 4
    im = Image.new('RGBA', (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.rounded_rectangle([0, 0, s - 1, s - 1], radius=s // 5, fill=(196, 43, 43, 255))
    f = ImageFont.truetype(FONT, int(s * 0.72))
    d.text((s / 2, s / 2), '字', font=f, fill=(255, 240, 210, 255), anchor='mm')
    im.resize((size, size), Image.LANCZOS).save(os.path.join(out, f'icon{size}.png'))
print('icons written')
