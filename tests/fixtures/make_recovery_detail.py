"""Maintainer-only deterministic JPEG fixture; Pillow is not needed to run tests."""
from PIL import Image, ImageDraw
from pathlib import Path
import random
w,h=2048,1536
rng=random.Random(187244)
pixels=bytearray(w*h*3)
for y in range(h):
    for x in range(w):
        at=(y*w+x)*3
        noise=rng.randrange(-12,13)
        pixels[at]=max(0,min(255,40+x*160//w+noise))
        pixels[at+1]=max(0,min(255,50+y*140//h+noise))
        pixels[at+2]=max(0,min(255,70+(x+y)*110//(w+h)+noise))
im=Image.frombytes('RGB',(w,h),bytes(pixels))
draw=ImageDraw.Draw(im)
for i in range(40):
    x=80+i*45
    draw.line((x,260,x,1300),fill=(240,240,240),width=3)
draw.rectangle((60,60,1980,200),fill='white')
draw.text((90,100),'SYNTHETIC DETAIL TEST - 2048 x 1536 - NOT A RECOVERY CAPTURE',fill='black',font_size=32)
im.save(Path(__file__).with_name('recovery-detail-test.jpg'),quality=90,subsampling=2)
print(Path(__file__).with_name('recovery-detail-test.jpg').stat().st_size)
